import { expect, test } from "bun:test";
import {
	type CarrierIntent,
	newCarrierIntent,
} from "./automatic-carrier-intent.ts";
import {
	createDisarmedProfile,
	type ProfileCreationDeps,
	restoreCreatedProfile,
} from "./automatic-profile-creation.ts";

const UUID = "6c52ad1a-312a-4b91-a58b-000000000001";
const pair = { deviceId: "synthetic-device", simId: "89000000000000000000" };
const fields = {
	type: "gsm",
	ifname: "",
	autoconnect: "yes" as const,
	"connection.autoconnect-retries": 2,
	"ipv6.method": "auto",
	"gsm.device-id": pair.deviceId,
	"gsm.sim-id": pair.simId,
	"gsm.apn": "",
	"gsm.auto-config": "yes" as const,
	"gsm.username": "",
	"gsm.password": "",
	"gsm.password-flags": "4",
	"gsm.home-only": "no",
	"gsm.network-id": "",
};
function fixture() {
	let saved: Record<string, string | number> | undefined;
	let intent: CarrierIntent | undefined;
	let inverse: Record<string, unknown> = {};
	let present = true;
	let current = true;
	let state = "";
	let partial = false;
	let refuseDelete = false;
	let onArmed = () => {};
	const events: string[] = [];
	const deps: ProfileCreationDeps = {
		uuid: () => UUID,
		list: async () => (saved ? [`${UUID}:gsm:${state}`] : []),
		fields: async (_uuid, names) =>
			saved
				? (names.map((name) => String(saved?.[name] ?? "")) as never)
				: undefined,
		add: async (fields) => {
			events.push("add");
			saved = { ...fields, "connection.autoconnect": fields.autoconnect };
			return partial ? undefined : UUID;
		},
		remove: async () => {
			events.push("delete");
			if (refuseDelete) return false;
			saved = undefined;
			return true;
		},
		pairPresent: async () => present,
		readIntent: async () => intent,
		writeIntent: async (_identity, value) => {
			events.push(value ? "intent" : "intent-absent");
			intent = value;
		},
		journal: async (_key, _kind, before, work) => {
			inverse = { ...before };
			events.push("armed");
			onArmed();
			const result = await work({
				entry: {} as never,
				markExecuting: async () => {
					events.push("executing");
				},
				markFailed: async () => {},
			});
			events.push(result.confirmed ? "confirmed" : "blocked");
			return { ok: true, value: result.value };
		},
	};
	return {
		deps,
		events,
		saved: () => saved,
		intent: () => intent,
		manual: () => {
			intent = newCarrierIntent({ uuid: UUID, ...pair }, "manual");
		},
		inverse: () => inverse,
		current: async () => current,
		setPresent: (v: boolean) => {
			present = v;
		},
		stale: () => {
			current = false;
		},
		seed: () => {
			saved = {
				...fields,
				"connection.id": "foreign",
				"connection.autoconnect": "no",
			};
		},
		setState: (v: string) => {
			state = v;
		},
		setName: (v: string) => {
			if (saved) saved["connection.id"] = v;
		},
		partial: () => {
			partial = true;
		},
		refuseDelete: () => {
			refuseDelete = true;
		},
		onArmed: (f: () => void) => {
			onArmed = f;
		},
	};
}
test("a preallocated profile is journaled, pair-bound and disarmed before publication", async () => {
	const f = fixture();
	expect(
		await createDisarmedProfile("key", pair, fields, f.current, f.deps),
	).toEqual({ state: "created", uuid: UUID });
	expect(f.events).toEqual([
		"armed",
		"executing",
		"intent",
		"add",
		"confirmed",
	]);
	expect(f.saved()).toMatchObject({
		"connection.uuid": UUID,
		"connection.id": `cellular-${UUID}`,
		autoconnect: "no",
	});
	expect(f.intent()?.mode).toBe("automatic");
});
test("an existing pair, even with another profile name, cannot create a clone", async () => {
	const f = fixture();
	f.seed();
	expect(
		await createDisarmedProfile("key", pair, fields, f.current, f.deps),
	).toEqual({ state: "pending" });
	expect(f.events).toEqual([]);
});
test("missing identity, stale admission and failed arming have no creation effects", async () => {
	const f = fixture();
	f.setPresent(false);
	expect(
		await createDisarmedProfile("key", pair, fields, f.current, f.deps),
	).toEqual({ state: "pending" });
	f.setPresent(true);
	f.onArmed(f.stale);
	expect(
		await createDisarmedProfile("key", pair, fields, f.current, f.deps),
	).toEqual({ state: "pending" });
	expect(f.events).not.toContain("add");
	expect(f.events).not.toContain("intent");
});
test("lost add confirmation is cleaned by exact UUID, without a surviving intent", async () => {
	const f = fixture();
	f.partial();
	expect(
		await createDisarmedProfile("key", pair, fields, f.current, f.deps),
	).toEqual({ state: "attempted" });
	expect(f.events).toEqual([
		"armed",
		"executing",
		"intent",
		"add",
		"delete",
		"intent-absent",
		"confirmed",
	]);
	expect(f.saved()).toBeUndefined();
	expect(f.intent()).toBeUndefined();
});
test("failed cleanup retains the block and authority for restart recovery", async () => {
	const f = fixture();
	f.partial();
	f.refuseDelete();
	expect(
		await createDisarmedProfile("key", pair, fields, f.current, f.deps),
	).toEqual({ state: "attempted" });
	expect(f.events.at(-1)).toBe("blocked");
	expect(f.intent()).toBeDefined();
});
test("replay never deletes an active, renamed or moved-pair profile", async () => {
	const f = fixture();
	await createDisarmedProfile("key", pair, fields, f.current, f.deps);
	f.setState("activated");
	expect(await restoreCreatedProfile("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	f.setState("");
	f.setName("foreign");
	expect(await restoreCreatedProfile("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	f.setName(`cellular-${UUID}`);
	f.setPresent(false);
	expect(await restoreCreatedProfile("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	expect(f.events).not.toContain("delete");
	f.setPresent(true);
	expect(await restoreCreatedProfile("key", f.inverse(), f.deps)).toBe(
		"restored",
	);
	expect(f.saved()).toBeUndefined();
	expect(f.intent()).toBeUndefined();
});

test("replay preserves an explicitly manual profile even when it is inactive and disarmed", async () => {
	const f = fixture();
	await createDisarmedProfile("key", pair, fields, f.current, f.deps);
	f.manual();
	expect(await restoreCreatedProfile("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	expect(f.events).not.toContain("delete");
	expect(f.intent()?.mode).toBe("manual");
});
