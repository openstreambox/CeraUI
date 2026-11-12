import { expect, test } from "bun:test";
import { createInternalCallContext } from "./internal-call-context.ts";
import {
	type InternalCallDeps,
	InternalCallOwner,
} from "./internal-call-owner.ts";
import {
	type InternalContextAuthority,
	parseInternalContextAuthority,
} from "./internal-context-authority.ts";
import type { CellularControl, CellularControlTarget } from "./modems.ts";
import type { withJournaledModemMutation } from "./mutation-lease.ts";
import { CARRIER_POLICIES } from "./subscription-policy.ts";
import type {
	InternalContext,
	InternalGrant,
	InternalRegistration,
} from "./transport-policy.ts";

function fixture(policyKey = "att") {
	const policy = CARRIER_POLICIES.find((row) => row.key === policyKey);
	if (!policy) throw new Error("Missing policy fixture");
	const events: string[] = [];
	let now = 0,
		current = true,
		sameSubscriber = true,
		valid = true,
		allowMutation = true,
		cleanup = true;
	let registration: InternalRegistration = "home";
	let context: InternalContext = { apn: "old.example", family: "ipv4" },
		active = false;
	let grant: InternalGrant = { family: "ipv4", ipv4: "192.0.2.10" };
	let revoked: () => void = () => {};
	let record: InternalContextAuthority | undefined;
	let withdrawn = false;
	const control: CellularControl = {
		valid: async () => valid,
		readSubscriber: async () =>
			sameSubscriber ? "000000000000001" : "000000000000002",
		verifySubscriber: async () => sameSubscriber,
		onRevoked: (callback) => {
			revoked = callback;
			return () => {
				revoked = () => {};
			};
		},
		registration: async () => registration === "home",
		registrationState: async () => {
			events.push("CEREG-read");
			return registration;
		},
		readContext: async () => context,
		contextActive: async () => active,
		defineContext: async (cid, apn, family, settings) => {
			events.push(`define-${cid}`);
			context = {
				apn,
				family,
				...(settings ? { settings: [...settings] } : {}),
			};
		},
		activateContext: async (cid, value) => {
			events.push(`active-${cid}-${value}`);
			active = value;
		},
		readGrant: async () => grant,
		readContextDns: async () => ["192.0.2.53"],
		readIpv4Grant: async () => grant.ipv4,
		readAutoConnect: async () => undefined,
		disableAutoConnect: async () => false,
		reset: async () => {
			throw new Error("No radio resets allowed");
		},
		close: async () => {
			events.push("release-MM");
		},
	};
	const deps: InternalCallDeps = {
		acquire: async () => {
			events.push("inhibit-ack");
			return control;
		},
		current: async () => current,
		now: () => now,
		context: createInternalCallContext(
			"synthetic-key",
			{
				unit: "a".repeat(64),
				subscription: "b".repeat(64),
				cid: policy.key === "verizon" ? 3 : 1,
				desired: { apn: policy.apn, family: policy.requestFamily },
			},
			{
				owned: () => true,
				withdrawn: () => withdrawn,
				identity: async () => ({
					unit: "a".repeat(64),
					subscription: (sameSubscriber ? "b" : "c").repeat(64),
					stableKey: "synthetic-key",
				}),
				current: async () => current,
				prepareCall: async () => {
					events.push("link-up");
				},
				access: async (operation) =>
					operation(record && structuredClone(record), async (value) => {
						if (!record && value) events.push("durable-baseline");
						record = value
							? parseInternalContextAuthority(value, value.key)
							: undefined;
					}),
				journal: (async (_key, _kind, _preState, run) => {
					if (!allowMutation) return { ok: false, refusal: "mutation_blocked" };
					const outcome = await run({
						markExecuting: async () => {
							events.push("journal-executing");
						},
					} as Parameters<Parameters<typeof withJournaledModemMutation>[3]>[0]);
					return outcome.confirmed
						? { ok: true, value: outcome.value }
						: { ok: false, refusal: "mutation_blocked" };
				}) as typeof withJournaledModemMutation,
			},
		),
		mutate: async (operation, effect) => {
			if (!allowMutation) return false;
			events.push(`lease+journal-${operation}`);
			await effect();
			events.push(`confirmed-${operation}`);
			return true;
		},
		host: {
			withdraw: () => {
				events.push("withdraw");
			},
			prepare: async () => {
				events.push("RA-guard");
			},
			prepareCall: async () => {
				events.push("link-up");
			},
			grant: async () => {
				events.push("install-grant-not-ready");
				withdrawn = false;
			},
			clearGrant: async () => {
				events.push("clear-grant");
				withdrawn = cleanup;
				return cleanup;
			},
			cleanup: async () => {
				events.push("cleanup");
				return cleanup;
			},
		},
	};
	const owner = new InternalCallOwner(
		{
			identity: {
				model: "FM350-GL",
				firmware: "81600.0000.00.29.18.01",
				mode: "rndis",
			},
		} as CellularControlTarget,
		policy,
		false,
		deps,
	);
	return {
		owner,
		events,
		control,
		deps,
		baseline: () =>
			record && {
				context: record.original.context,
				active: record.original.active,
				cid: record.cid,
				desired: record.desired,
			},
		record: () => record,
		set: (values: {
			current?: boolean;
			sameSubscriber?: boolean;
			valid?: boolean;
			allowMutation?: boolean;
			registration?: InternalRegistration;
			cleanup?: boolean;
			context?: InternalContext;
			active?: boolean;
			grant?: InternalGrant;
		}) => {
			if (values.current !== undefined) current = values.current;
			if (values.sameSubscriber !== undefined)
				sameSubscriber = values.sameSubscriber;
			if (values.valid !== undefined) valid = values.valid;
			if (values.allowMutation !== undefined)
				allowMutation = values.allowMutation;
			if (values.registration !== undefined) registration = values.registration;
			if (values.cleanup !== undefined) cleanup = values.cleanup;
			if (values.context !== undefined) context = values.context;
			if (values.active !== undefined) active = values.active;
			if (values.grant !== undefined) grant = values.grant;
		},
		tick: async () => {
			now += 1_000;
			await owner.observe();
		},
		revoke: () => {
			valid = false;
			revoked();
		},
	};
}

test("self-registration is observed without COPS; four stable reads precede a reversible call", async () => {
	const f = fixture();
	expect(await f.owner.start()).toBe(true);
	for (let i = 0; i < 3; i++) await f.tick();
	expect(f.events.some((event) => event.startsWith("define"))).toBe(false);
	await f.tick();
	expect(f.owner.phase).toBe("granted");
	expect(f.events.indexOf("durable-baseline")).toBeLessThan(
		f.events.indexOf("define-1"),
	);
	expect(f.events.indexOf("RA-guard")).toBeLessThan(
		f.events.indexOf("inhibit-ack"),
	);
	expect(f.events.indexOf("RA-guard")).toBeLessThan(
		f.events.indexOf("active-1-true"),
	);
	expect(f.events.indexOf("inhibit-ack")).toBeLessThan(
		f.events.indexOf("link-up"),
	);
	expect(f.events.indexOf("link-up")).toBeLessThan(
		f.events.indexOf("active-1-true"),
	);
	expect(f.events.at(-1)).toBe("install-grant-not-ready");
	expect(f.baseline()?.context.apn).toBe("old.example");
	expect(await f.owner.close()).toBe(true);
	expect(f.events.indexOf("withdraw")).toBeLessThan(
		f.events.indexOf("cleanup"),
	);
	expect(f.events.at(-1)).toBe("release-MM");
	expect(await f.control.readContext(1)).toEqual({
		apn: "old.example",
		family: "ipv4",
	});
});

test("roaming refusal and unknown registration break the consecutive-read sequence", async () => {
	const f = fixture();
	await f.owner.start();
	await f.tick();
	await f.tick();
	f.set({ registration: "roaming" });
	await f.tick();
	f.set({ registration: "home" });
	for (let i = 0; i < 3; i++) await f.tick();
	expect(f.owner.phase).toBe("waiting-registration");
	f.set({ registration: "unknown" });
	await f.tick();
	expect(f.events.includes("active-1-true")).toBe(false);
});

test("lease refusal retries no hardware, and a foreign active context is preserved", async () => {
	const f = fixture();
	f.set({ allowMutation: false });
	expect(await f.owner.start()).toBe(false);
	expect(f.events).toEqual([]);
	f.set({ allowMutation: true, active: true });
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("blocked");
	expect(f.baseline()).toBeUndefined();
	expect(f.events.some((event) => event.startsWith("define"))).toBe(false);
});

test("Verizon remains unqualified, including the pre-registration owner", async () => {
	const f = fixture("verizon");
	expect(f.owner.cid).toBe(3);
	expect(await f.owner.start()).toBe(false);
	expect(f.events).toEqual([]);
});

test("SIM replacement and bus revocation withdraw before cleanup, never publish an old grant", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.events.length = 0;
	f.set({ sameSubscriber: false });
	await f.tick();
	expect(f.events).toEqual(["withdraw", "withdraw", "clear-grant", "withdraw"]);
	expect(await f.owner.close()).toBe(false);
	expect(f.events).not.toContain("cleanup");
	expect(f.events).not.toContain("release-MM");
	f.set({ active: false });
	expect(await f.owner.close()).toBe(true);
	expect(f.record()?.phase).toBe("parked");
	expect(f.events).not.toContain("active-1-false");
	expect(f.events.filter((event) => event === "define-1")).toHaveLength(0);
	expect(f.events.at(-1)).toBe("release-MM");
	const g = fixture();
	await g.owner.start();
	g.events.length = 0;
	g.revoke();
	expect(g.events).toEqual(["withdraw"]);
	await g.tick();
	expect(g.events).toEqual([
		"withdraw",
		"withdraw",
		"withdraw",
		"clear-grant",
		"cleanup",
		"release-MM",
	]);
});

test("health reconnect retains the original baseline; failed consumer withdrawal holds control", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.set({ cleanup: false });
	expect(await f.owner.reconnect()).toBe(false);
	expect(f.events.includes("active-1-false")).toBe(false);
	expect(f.events.includes("release-MM")).toBe(false);
	f.set({ cleanup: true });
	expect(await f.owner.reconnect()).toBe(true);
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("granted");
	expect(f.events.filter((event) => event === "durable-baseline")).toHaveLength(
		1,
	);
	expect(await f.owner.close()).toBe(true);
	expect(await f.control.readContext(1)).toEqual({
		apn: "old.example",
		family: "ipv4",
	});
});

test("the complete context baseline is restored and an outside tail-setting edit is preserved", async () => {
	const f = fixture();
	const settings = ["0.0.0.0", "0", "0"];
	f.set({ context: { apn: "", family: "ipv4v6", settings } });
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("granted");
	f.set({
		context: {
			apn: "broadband",
			family: "ipv4v6",
			settings: ["0.0.0.0", "1", "0"],
		},
	});
	expect(await f.owner.close()).toBe(false);
	expect(f.events).not.toContain("cleanup");
	expect(f.events).not.toContain("release-MM");
	expect(f.events).not.toContain("active-1-false");
	f.set({ context: { apn: "broadband", family: "ipv4v6", settings } });
	expect(await f.owner.close()).toBe(true);
	expect(await f.control.readContext(1)).toEqual({
		apn: "",
		family: "ipv4v6",
		settings,
	});
});

test("a failed handoff retains inhibition until its partial host state can be reversed", async () => {
	const f = fixture();
	f.set({ sameSubscriber: false, cleanup: false });
	await expect(f.owner.start()).rejects.toThrow("subscription changed");
	expect(f.owner.phase).toBe("blocked");
	expect(f.events).not.toContain("release-MM");
	f.set({ cleanup: true });
	expect(await f.owner.close()).toBe(true);
	expect(f.events.at(-1)).toBe("release-MM");
});

test("pending close forbids health recovery and later grant publication", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.events.length = 0;
	f.set({ cleanup: false });
	expect(await f.owner.close()).toBe(false);
	f.set({ cleanup: true });
	expect(await f.owner.reconnect()).toBe(false);
	await f.tick();
	expect(f.events).not.toContain("install-grant-not-ready");
	expect(f.events).not.toContain("active-1-false");
	expect(f.events).not.toContain("cleanup");
	expect(await f.owner.close()).toBe(true);
	expect(f.events.indexOf("active-1-false")).toBeLessThan(
		f.events.indexOf("cleanup"),
	);
	expect(f.events.indexOf("cleanup")).toBeLessThan(
		f.events.indexOf("release-MM"),
	);
	expect(await f.owner.close()).toBe(true);
});

test("close arriving during a grant withdrawal cannot be followed by a new grant", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 3; i++) await f.tick();
	const clear = f.deps.host.clearGrant;
	let clears = 0;
	f.deps.host.clearGrant = async () => {
		const result = await clear();
		if (++clears === 2) expect(await f.owner.close()).toBe(false);
		return result;
	};
	await f.tick();
	expect(f.events).toContain("active-1-true");
	expect(f.events).not.toContain("install-grant-not-ready");
	expect(f.owner.phase).toBe("withdrawn");
	expect(await f.owner.close()).toBe(true);
});

test("a SIM change during consumer withdrawal cannot install a captured old grant", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 3; i++) await f.tick();
	const clear = f.deps.host.clearGrant;
	let clears = 0;
	f.deps.host.clearGrant = async () => {
		const result = await clear();
		if (++clears === 2) f.set({ sameSubscriber: false });
		return result;
	};
	await f.tick();
	expect(f.events).not.toContain("install-grant-not-ready");
	expect(await f.owner.close()).toBe(false);
	expect(f.events).not.toContain("cleanup");
	f.set({ active: false });
	expect(await f.owner.close()).toBe(true);
});

test("bus revocation after activation preserves the guard and context inverse", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.events.length = 0;
	f.revoke();
	await f.tick();
	expect(await f.owner.close()).toBe(false);
	expect(f.record()?.activationOwned).toBe(true);
	expect(f.events).not.toContain("cleanup");
	expect(f.events).not.toContain("release-MM");
	expect(f.events).not.toContain("active-1-false");
});

test("an adopted matching active call is never reset by health or teardown", async () => {
	const f = fixture();
	f.set({ context: { apn: "broadband", family: "ipv4v6" }, active: true });
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("granted");
	expect(await f.owner.reconnect()).toBe(false);
	expect(await f.owner.close()).toBe(true);
	expect(f.record()?.phase).toBe("released");
	expect(
		f.events.some(
			(event) => event.startsWith("active-") || event.startsWith("define-"),
		),
	).toBe(false);
});

test("a foreign context change invalidates an otherwise active grant", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.events.length = 0;
	f.set({ context: { apn: "foreign.invalid", family: "ipv4v6" } });
	await f.tick();
	expect(f.owner.phase).toBe("waiting-registration");
	expect(f.events).not.toContain("install-grant-not-ready");
	expect(await f.owner.close()).toBe(false);
	expect(f.events).not.toContain("cleanup");
	expect(f.events).not.toContain("active-1-false");
});
