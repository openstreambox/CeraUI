import { expect, test } from "bun:test";
import {
	createInternalCallContext,
	type InternalCallContextDeps,
} from "./internal-call-context.ts";
import {
	type InternalContextAuthority,
	type InternalContextRequest,
	parseInternalContextAuthority,
} from "./internal-context-authority.ts";
import type { CellularControl } from "./modems.ts";
import type { withJournaledModemMutation } from "./mutation-lease.ts";
import type { InternalContext } from "./transport-policy.ts";

const unit = "a".repeat(64),
	firstSim = "b".repeat(64),
	secondSim = "c".repeat(64);
const initial: InternalContext = {
	apn: "baseline.invalid",
	family: "ipv4",
	settings: ["0.0.0.0", "0"],
};
function fixture() {
	let record: InternalContextAuthority | undefined,
		context = structuredClone(initial),
		active = false,
		subscription: string | undefined = firstSim,
		owned = true,
		withdrawn = true,
		policy = true,
		currentUnit = unit,
		key = "synthetic-key",
		valid = true;
	const events: string[] = [];
	const control: CellularControl = {
		valid: async () => valid,
		readSubscriber: async () => subscription,
		verifySubscriber: async () => subscription === firstSim,
		onRevoked: () => () => {},
		registration: async () => true,
		registrationState: async () => "home",
		readContext: async () => structuredClone(context),
		contextActive: async () => active,
		defineContext: async (_cid, apn, family, settings) => {
			expect(["defining", "restoring"]).toContain(record?.phase);
			events.push(`define-${apn}`);
			context = {
				apn,
				family,
				...(settings ? { settings: [...settings] } : {}),
			};
		},
		activateContext: async (_cid, value) => {
			expect(record?.phase).toBe(value ? "activating" : "deactivating");
			events.push(`active-${value}`);
			active = value;
		},
		readGrant: async () => undefined,
		readContextDns: async () => undefined,
		readIpv4Grant: async () => undefined,
		readAutoConnect: async () => undefined,
		disableAutoConnect: async () => false,
		reset: async () => {
			throw new Error("Reset forbidden");
		},
		close: async () => {},
	};
	const deps: InternalCallContextDeps = {
		owned: () => owned,
		withdrawn: () => withdrawn,
		current: async () => policy,
		identity: async () =>
			subscription
				? { unit: currentUnit, subscription, stableKey: key }
				: undefined,
		prepareCall: async () => {
			events.push("link-up");
		},
		access: async (operation) =>
			operation(record && structuredClone(record), async (value) => {
				record = value
					? parseInternalContextAuthority(value, value.key)
					: undefined;
				events.push(`persist-${record?.phase ?? "absent"}`);
			}),
		journal: (async (_key, _kind, preState, run) => {
			expect(preState.format).toBe("cellular-internal-context-v1");
			expect(preState.unit).toBe(unit);
			const outcome = await run({
				markExecuting: async () => {
					events.push("executing");
				},
			} as Parameters<Parameters<typeof withJournaledModemMutation>[3]>[0]);
			return outcome.confirmed
				? { ok: true, value: outcome.value }
				: { ok: false, refusal: "mutation_blocked" };
		}) as typeof withJournaledModemMutation,
	};
	const make = (
		request: InternalContextRequest = {
			unit,
			subscription: firstSim,
			cid: 1,
			desired: { apn: "first.invalid", family: "ipv4v6" },
		},
	) => createInternalCallContext("synthetic-key", request, deps);
	return {
		make,
		control,
		deps,
		events,
		state: () => ({ record, context, active }),
		set: (next: {
			subscription?: string | null;
			owned?: boolean;
			withdrawn?: boolean;
			policy?: boolean;
			unit?: string;
			key?: string;
			valid?: boolean;
			active?: boolean;
			record?: InternalContextAuthority | null;
		}) => {
			if (next.subscription !== undefined)
				subscription = next.subscription ?? undefined;
			if (next.owned !== undefined) owned = next.owned;
			if (next.withdrawn !== undefined) withdrawn = next.withdrawn;
			if (next.policy !== undefined) policy = next.policy;
			if (next.unit !== undefined) currentUnit = next.unit;
			if (next.key !== undefined) key = next.key;
			if (next.valid !== undefined) valid = next.valid;
			if (next.active !== undefined) active = next.active;
			if (next.record !== undefined) record = next.record ?? undefined;
		},
	};
}

test("a replacement adapter resumes durable context authority without adopting a new baseline", async () => {
	const f = fixture(),
		first = f.make();
	expect(await first.activate(f.control)).toBe(true);
	expect(await first.valid(f.control)).toBe(true);
	const original = structuredClone(f.state().record?.original);
	f.events.length = 0;
	const replacement = f.make();
	await replacement.load();
	expect(replacement.known()).toBe(true);
	expect(await replacement.activate(f.control)).toBe(true);
	expect(f.events).not.toContain("active-true");
	expect(f.events.some((event) => event.startsWith("define-"))).toBe(false);
	expect(f.state().record?.original).toEqual(original);
	expect(await replacement.close(f.control)).toBe(true);
	expect(f.state().context).toEqual(initial);
	expect(f.state().record?.phase).toBe("parked");
});

test("a new subscription parks only an inactive predecessor and uses its own requested policy", async () => {
	const f = fixture();
	expect(await f.make().activate(f.control)).toBe(true);
	f.set({ subscription: secondSim });
	const second = f.make({
		unit,
		subscription: secondSim,
		cid: 1,
		desired: { apn: "second.invalid", family: "ipv6" },
	});
	f.events.length = 0;
	expect(await second.activate(f.control)).toBe(false);
	expect(f.events).toEqual([]);
	f.set({ active: false });
	expect(await second.activate(f.control)).toBe(true);
	expect(f.state().record?.original.subscription).toBe(firstSim);
	expect(f.state().record?.original.context).toEqual(initial);
	expect(f.state().context.apn).toBe("second.invalid");
	f.events.length = 0;
	expect(await second.close(f.control)).toBe(true);
	expect(f.state().record?.phase).toBe("parked");
	expect(f.events).not.toContain("define-baseline.invalid");
	expect(f.state().context.apn).toBe("second.invalid");
});

test("close settles the stored predecessor even before a new policy has activated", async () => {
	const f = fixture();
	expect(await f.make().activate(f.control)).toBe(true);
	const newPolicy = f.make({
		unit,
		subscription: secondSim,
		cid: 1,
		desired: { apn: "second.invalid", family: "ipv6" },
	});
	expect(await newPolicy.close(f.control)).toBe(true);
	expect(f.state().context).toEqual(initial);
	expect(f.state().record?.phase).toBe("parked");
});

test("missing remembered authority is neither a new baseline nor an acknowledged inverse", async () => {
	const f = fixture(),
		owner = f.make();
	expect(await owner.activate(f.control)).toBe(true);
	f.set({ record: null });
	f.events.length = 0;
	expect(await owner.activate(f.control)).toBe(false);
	expect(await owner.valid(f.control)).toBe(false);
	expect(await owner.close(f.control)).toBe(false);
	expect(owner.known()).toBe(true);
	expect(f.events).toEqual([]);
});

test("policy change restores the same-SIM definition before applying new settings", async () => {
	const f = fixture();
	expect(await f.make().activate(f.control)).toBe(true);
	const changed = f.make({
		unit,
		subscription: firstSim,
		cid: 1,
		desired: {
			apn: "first.invalid",
			family: "ipv4v6",
			settings: ["0.0.0.0", "1"],
		},
	});
	expect(await changed.valid(f.control)).toBe(false);
	f.events.length = 0;
	expect(await changed.activate(f.control)).toBe(true);
	expect(f.events.indexOf("define-baseline.invalid")).toBeLessThan(
		f.events.indexOf("define-first.invalid"),
	);
	expect(f.state().context.settings).toEqual(["0.0.0.0", "1"]);
	expect(f.state().record?.original.context).toEqual(initial);
});

test("identity, current policy and withdrawal have separate read and effect gates", async () => {
	const f = fixture(),
		owner = f.make();
	expect(await owner.activate(f.control)).toBe(true);
	f.set({ withdrawn: false });
	expect(await owner.valid(f.control)).toBe(true);
	expect(await owner.deactivate(f.control)).toBe(false);
	for (const state of [
		{ unit: "d".repeat(64) },
		{ key: "other-key" },
		{ owned: false },
		{ valid: false },
		{ subscription: null },
	]) {
		f.set({
			unit,
			key: "synthetic-key",
			owned: true,
			valid: true,
			subscription: firstSim,
			...state,
		});
		expect(await owner.accept(f.control)).toBe(false);
		expect(await owner.valid(f.control)).toBe(false);
		expect(await owner.close(f.control)).toBe(false);
	}
	f.set({
		owned: true,
		valid: true,
		subscription: firstSim,
		policy: false,
		withdrawn: true,
	});
	expect(await owner.valid(f.control)).toBe(false);
	expect(await owner.close(f.control)).toBe(true);
});

test("the request and definition settings are captured before caller mutation", async () => {
	const f = fixture(),
		desired = {
			apn: "first.invalid",
			family: "ipv4v6" as const,
			settings: ["0.0.0.0", "1"],
		},
		request = { unit, subscription: firstSim, cid: 1, desired },
		owner = f.make(request);
	request.cid = 3;
	desired.apn = "mutated.invalid";
	desired.settings[1] = "0";
	expect(await owner.activate(f.control)).toBe(true);
	expect(f.state().record?.cid).toBe(1);
	expect(f.state().context.apn).toBe("first.invalid");
	expect(f.state().context.settings).toEqual(["0.0.0.0", "1"]);
});
