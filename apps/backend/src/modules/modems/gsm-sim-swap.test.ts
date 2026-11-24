import { describe, expect, test } from "bun:test";
import type { GsmProfileAudit } from "./gsm-duplicate-reconcile.ts";
import {
	defaultGsmSimSwapDeps,
	type GsmSimSwapDeps,
	parkedProfileKey,
	settleSimSwapProfiles,
} from "./gsm-sim-swap.ts";

/*
  A NetworkManager fixture for gsm autoconnect, following NM 1.52:
  nm_modem_check_connection_compatible() rejects a profile whose device-id
  differs, and compares sim-id / sim-operator-id only when the modem has
  reported them. Autoconnect then takes the armed compatible profile with the
  highest autoconnect-priority, the most recently used one first on a tie.
*/
interface Profile {
	uuid: string;
	name: string;
	deviceId: string;
	simId: string;
	autoconnect: "yes" | "no";
	priority: number;
	timestamp: number;
	activeOn?: string;
}

interface ModemView {
	deviceId: string;
	/** Undefined until ModemManager has reported the SIM to NetworkManager. */
	simId?: string;
}

function nmCompatible(profile: Profile, modem: ModemView): boolean {
	if (profile.deviceId && profile.deviceId !== modem.deviceId) return false;
	if (
		modem.simId !== undefined &&
		profile.simId &&
		profile.simId !== modem.simId
	)
		return false;
	return true;
}

function nmAutoconnectChoice(
	profiles: readonly Profile[],
	modem: ModemView,
): string | undefined {
	return profiles
		.filter((p) => p.autoconnect === "yes" && nmCompatible(p, modem))
		.sort((a, b) => b.priority - a.priority || b.timestamp - a.timestamp)[0]
		?.name;
}

const RM520 = "synthetic-rm520n-gl";
const DELL = "synthetic-dw5821e";
const FM350 = "synthetic-fm350-gl";
const DARK = "89000000000000000101";
const LIGHT = "89000000000000000202";
const WARP = "89000000000000000303";

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The layout after the swap: Dark Star moved to the Dell, Light Speed to the RM520. */
function swappedBox(): Profile[] {
	const p = (
		n: number,
		name: string,
		deviceId: string,
		simId: string,
		autoconnect: "yes" | "no",
		timestamp: number,
	): Profile => ({
		uuid: uuid(n),
		name,
		deviceId,
		simId,
		autoconnect,
		priority: 0,
		timestamp,
	});
	return [
		// Dark Star on the RM520, used until the swap.
		p(1, "gsm", RM520, DARK, "yes", 300),
		p(2, "gsm-6", DELL, DARK, "yes", 290),
		// Warp on the Dell before the swap: duplicates that linger.
		p(3, "gsm-1", DELL, WARP, "yes", 100),
		p(4, "gsm-3", DELL, WARP, "yes", 100),
		p(5, "gsm-8", FM350, WARP, "yes", 0),
		// The automatic profile CeraUI prepared for Light Speed on the RM520.
		p(6, "gsm-7", RM520, LIGHT, "no", 50),
		// A profile without a SIM id: matches any SIM by design.
		p(7, "generic", RM520, "", "yes", 10),
	];
}

const present: Record<string, ReadonlySet<string> | undefined> = {
	[RM520]: new Set([LIGHT]),
	[DELL]: new Set([DARK]),
	[FM350]: new Set([WARP]),
};

interface Harness {
	deps: GsmSimSwapDeps;
	records: Map<string, unknown>;
	calls: string[];
}

function harness(
	profiles: Profile[],
	sims: Record<string, ReadonlySet<string> | undefined> = present,
	opts: { failSet?: boolean } = {},
): Harness {
	const records = new Map<string, unknown>();
	const calls: string[] = [];
	const deps: GsmSimSwapDeps = {
		audit: async () =>
			profiles.map(
				(p): GsmProfileAudit => ({
					uuid: p.uuid,
					deviceId: p.deviceId,
					simId: p.simId,
					state: p.activeOn ? "activated" : "",
					autoconnect: p.autoconnect,
					timestamp: String(p.timestamp),
				}),
			),
		presentSims: async (deviceId) => sims[deviceId],
		setFields: async (id, fields) => {
			calls.push(`set ${id} ${JSON.stringify(fields)}`);
			if (opts.failSet) return false;
			const profile = profiles.find((p) => p.uuid === id);
			const value = fields["connection.autoconnect"];
			if (!profile || (value !== "yes" && value !== "no")) return false;
			profile.autoconnect = value;
			return true;
		},
		readParked: async (key) =>
			records.get(key) as Awaited<ReturnType<GsmSimSwapDeps["readParked"]>>,
		writeParked: async (key, record) => {
			calls.push(`${record ? "record" : "drop"} ${key}`);
			if (record) records.set(key, record);
			else records.delete(key);
		},
	};
	return { deps, records, calls };
}

const byName = (profiles: Profile[], name: string): Profile => {
	const found = profiles.find((p) => p.name === name);
	if (!found) throw new Error(name);
	return found;
};

describe("NetworkManager fixture", () => {
	test("before the SIM is known, the swapped-out SIM's profile wins", () => {
		expect(nmAutoconnectChoice(swappedBox(), { deviceId: RM520 })).toBe("gsm");
	});

	test("once the SIM is known, NetworkManager rejects it", () => {
		const profiles = swappedBox();
		expect(
			nmCompatible(byName(profiles, "gsm"), { deviceId: RM520, simId: LIGHT }),
		).toBe(false);
		expect(
			nmAutoconnectChoice(profiles, { deviceId: RM520, simId: LIGHT }),
		).toBe("generic");
	});
});

describe("settleSimSwapProfiles", () => {
	test("parks the other SIM's profile so the unknown-SIM window cannot pick it", async () => {
		const profiles = swappedBox();
		const { deps } = harness(profiles);
		const result = await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps);
		expect(result).toEqual({ parked: 1, rearmed: false });
		expect(byName(profiles, "gsm").autoconnect).toBe("no");
		// The profile without a SIM id is left as it was.
		expect(byName(profiles, "generic").autoconnect).toBe("yes");
		expect(nmAutoconnectChoice(profiles, { deviceId: RM520 })).toBe("generic");
		// Another device's profiles are not this modem's business.
		expect(byName(profiles, "gsm-6").autoconnect).toBe("yes");
	});

	test("parks the lingering duplicates for a SIM that left the modem", async () => {
		const profiles = swappedBox();
		const { deps } = harness(profiles);
		const result = await settleSimSwapProfiles(DELL, DARK, uuid(2), deps);
		expect(result.parked).toBe(2);
		expect(byName(profiles, "gsm-1").autoconnect).toBe("no");
		expect(byName(profiles, "gsm-3").autoconnect).toBe("no");
		expect(nmAutoconnectChoice(profiles, { deviceId: DELL })).toBe("gsm-6");
		expect(byName(profiles, "gsm-8").autoconnect).toBe("yes");
	});

	test("records the original value before disarming, and re-arms when the SIM is back", async () => {
		const profiles = swappedBox();
		const { deps, records, calls } = harness(profiles);
		await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps);
		const key = parkedProfileKey(uuid(1), RM520, DARK);
		expect(calls).toEqual([
			`record ${key}`,
			`set ${uuid(1)} {"connection.autoconnect":"no"}`,
		]);
		expect(records.get(key)).toEqual({
			version: 1,
			kind: "parked",
			key,
			original: "yes",
		});

		// Dark Star goes back into the RM520; Light Speed leaves.
		const back = harness(profiles, { ...present, [RM520]: new Set([DARK]) });
		back.records.set(key, records.get(key));
		const result = await settleSimSwapProfiles(RM520, DARK, uuid(1), back.deps);
		expect(result.rearmed).toBe(true);
		expect(byName(profiles, "gsm").autoconnect).toBe("yes");
		expect(back.records.has(key)).toBe(false);
		expect(
			nmAutoconnectChoice(profiles, { deviceId: RM520, simId: DARK }),
		).toBe("gsm");
		// gsm-7 is disarmed by preparation, not by parking: nothing to touch.
		expect(byName(profiles, "gsm-7").autoconnect).toBe("no");
	});

	test("a disarmed profile without a record stays disarmed", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles);
		const result = await settleSimSwapProfiles(RM520, LIGHT, uuid(6), {
			...deps,
			audit: async () => (await deps.audit()).filter((a) => a.uuid === uuid(6)),
		});
		expect(result).toEqual({ parked: 0, rearmed: false });
		expect(calls).toEqual([]);
		expect(byName(profiles, "gsm-7").autoconnect).toBe("no");
	});

	test("a record next to an armed profile is dropped without a write", async () => {
		const profiles = swappedBox();
		const { deps, records, calls } = harness(profiles, {
			...present,
			[RM520]: new Set([DARK]),
		});
		const key = parkedProfileKey(uuid(1), RM520, DARK);
		records.set(key, { version: 1, kind: "parked", key, original: "yes" });
		const result = await settleSimSwapProfiles(RM520, DARK, uuid(1), deps);
		expect(result.rearmed).toBe(false);
		expect(records.has(key)).toBe(false);
		// No profile write: gsm-7 for the absent SIM is already disarmed.
		expect(calls.filter((c) => c.startsWith("set"))).toEqual([]);
	});

	test("a failed disarm keeps the record", async () => {
		const profiles = swappedBox();
		const { deps, records } = harness(profiles, present, { failSet: true });
		const result = await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps);
		expect(result.parked).toBe(0);
		expect(records.has(parkedProfileKey(uuid(1), RM520, DARK))).toBe(true);
	});

	test("two identical modems holding both SIMs park nothing", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles, {
			...present,
			[RM520]: new Set([LIGHT, DARK]),
		});
		const result = await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps);
		expect(result.parked).toBe(0);
		expect(calls).toEqual([]);
	});

	test("an unreadable SIM in a modem with the same device id parks nothing", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles, {
			...present,
			[RM520]: undefined,
		});
		expect(
			(await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps)).parked,
		).toBe(0);
		expect(calls).toEqual([]);
	});

	test("a presence read that misses the modem's own SIM parks nothing", async () => {
		const profiles = swappedBox();
		const { deps } = harness(profiles, { ...present, [RM520]: new Set() });
		expect(
			(await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps)).parked,
		).toBe(0);
	});

	test("an active profile is never parked", async () => {
		const profiles = swappedBox();
		byName(profiles, "gsm").activeOn = "cdc-wdm1";
		const { deps } = harness(profiles);
		expect(
			(await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps)).parked,
		).toBe(0);
		expect(byName(profiles, "gsm").autoconnect).toBe("yes");
	});

	test("no candidates means no ModemManager reads", async () => {
		const profiles = swappedBox().filter((p) => p.deviceId === FM350);
		let reads = 0;
		const { deps } = harness(profiles);
		await settleSimSwapProfiles(FM350, WARP, uuid(5), {
			...deps,
			presentSims: async (id) => {
				reads += 1;
				return present[id];
			},
		});
		expect(reads).toBe(0);
	});

	test("a stale caller writes nothing", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles);
		await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps, () => false);
		expect(calls).toEqual([]);
	});
});

test("the parked record survives in the preparation store and is removed on re-arm", async () => {
	const profiles = swappedBox();
	const fake = harness(profiles).deps;
	const real = defaultGsmSimSwapDeps(async (id) => present[id]);
	const deps = { ...real, audit: fake.audit, setFields: fake.setFields };
	await settleSimSwapProfiles(RM520, LIGHT, uuid(6), deps);
	const key = parkedProfileKey(uuid(1), RM520, DARK);
	expect(await real.readParked(key)).toEqual({
		version: 1,
		kind: "parked",
		key,
		original: "yes",
	});
	await settleSimSwapProfiles(RM520, DARK, uuid(1), {
		...deps,
		presentSims: async () => new Set([DARK]),
	});
	expect(byName(profiles, "gsm").autoconnect).toBe("yes");
	expect(await real.readParked(key)).toBeUndefined();
});
