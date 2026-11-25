import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPrivateJsonKeys } from "../../helpers/private-json-state.ts";
import * as runner from "../../helpers/run.ts";
import { parseCarrierIntentSlot } from "./automatic-carrier-intent.ts";
import { parsePreparationRecord } from "./cellular-preparation-state.ts";
import {
	auditGsmProfiles,
	auditGsmProfilesComplete,
	classifyGsmDuplicate,
	type GsmProfileAudit,
	reconcileDuplicateGsmProfiles,
} from "./gsm-duplicate-reconcile.ts";
import { isProfileParked, parkedProfileKey } from "./gsm-sim-park-store.ts";
import {
	defaultGsmSimSwapDeps,
	type GsmSimSwapDeps,
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

function audits(profiles: readonly Profile[]): GsmProfileAudit[] {
	return profiles.map((p) => ({
		uuid: p.uuid,
		deviceId: p.deviceId,
		simId: p.simId,
		state: p.activeOn ? "activated" : "",
		autoconnect: p.autoconnect,
		timestamp: String(p.timestamp),
	}));
}

function harness(
	profiles: Profile[],
	sims: Record<string, ReadonlySet<string> | undefined> = present,
	opts: { failSet?: boolean; failStore?: "read" | "write" } = {},
	records: Map<string, unknown> = new Map(),
): Harness {
	const calls: string[] = [];
	const deps: GsmSimSwapDeps = {
		audit: async () => audits(profiles),
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
		readParked: async (key) => {
			if (opts.failStore === "read") throw new Error("store unreadable");
			return records.get(key) as Awaited<
				ReturnType<GsmSimSwapDeps["readParked"]>
			>;
		},
		writeParked: async (key, record) => {
			if (opts.failStore === "write") throw new Error("store unwritable");
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

const parkedRecord = (key: string) => ({ version: 1, key, original: "yes" });

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
		const result = await settleSimSwapProfiles(RM520, LIGHT, deps);
		expect(result).toEqual({ parked: 1, rearmed: 0, complete: true });
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
		const result = await settleSimSwapProfiles(DELL, DARK, deps);
		expect(result.parked).toBe(2);
		expect(byName(profiles, "gsm-1").autoconnect).toBe("no");
		expect(byName(profiles, "gsm-3").autoconnect).toBe("no");
		expect(nmAutoconnectChoice(profiles, { deviceId: DELL })).toBe("gsm-6");
		expect(byName(profiles, "gsm-8").autoconnect).toBe("yes");
	});

	test("records the original value before disarming, and re-arms every parked profile when the SIM is back", async () => {
		const profiles = swappedBox();
		const { deps, records, calls } = harness(profiles);
		await settleSimSwapProfiles(DELL, DARK, deps);
		const keys = [3, 4].map((n) => parkedProfileKey(uuid(n), DELL, WARP));
		expect(calls).toEqual([
			`record ${keys[0]}`,
			`set ${uuid(3)} {"connection.autoconnect":"no"}`,
			`record ${keys[1]}`,
			`set ${uuid(4)} {"connection.autoconnect":"no"}`,
		]);
		expect(records.get(keys[0] ?? "")).toEqual(parkedRecord(keys[0] ?? ""));

		// Warp goes back into the Dell; Dark Star leaves.
		const back = harness(
			profiles,
			{ ...present, [DELL]: new Set([WARP]), [FM350]: new Set() },
			{},
			records,
		);
		const result = await settleSimSwapProfiles(DELL, WARP, back.deps);
		// Both duplicates, not only the one selected for the modem.
		expect(result.rearmed).toBe(2);
		expect(byName(profiles, "gsm-1").autoconnect).toBe("yes");
		expect(byName(profiles, "gsm-3").autoconnect).toBe("yes");
		expect(records.size).toBe(1);
		expect(records.has(parkedProfileKey(uuid(2), DELL, DARK))).toBe(true);
	});

	test("a disarmed profile without a record stays disarmed", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles);
		await settleSimSwapProfiles(RM520, LIGHT, {
			...deps,
			audit: async () => (await deps.audit()).filter((a) => a.uuid === uuid(6)),
		});
		expect(calls).toEqual([]);
		expect(byName(profiles, "gsm-7").autoconnect).toBe("no");
	});

	test("a record next to an armed profile is spent and dropped without a write", async () => {
		const profiles = swappedBox();
		const key = parkedProfileKey(uuid(1), RM520, DARK);
		const { deps, records, calls } = harness(
			profiles,
			{ ...present, [RM520]: new Set([DARK]) },
			{},
			new Map([[key, parkedRecord(key)]]),
		);
		const result = await settleSimSwapProfiles(RM520, DARK, deps);
		expect(result.rearmed).toBe(0);
		expect(records.has(key)).toBe(false);
		expect(calls.filter((c) => c.startsWith("set"))).toEqual([]);
	});

	test("a failed disarm keeps the record", async () => {
		const profiles = swappedBox();
		const { deps, records } = harness(profiles, present, { failSet: true });
		expect((await settleSimSwapProfiles(RM520, LIGHT, deps)).parked).toBe(0);
		expect(records.has(parkedProfileKey(uuid(1), RM520, DARK))).toBe(true);
	});

	test("an unwritable store skips parking without a profile write", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles, present, { failStore: "write" });
		expect(await settleSimSwapProfiles(DELL, DARK, deps)).toEqual({
			parked: 0,
			rearmed: 0,
			complete: false,
		});
		expect(calls).toEqual([]);
		expect(byName(profiles, "gsm-1").autoconnect).toBe("yes");
	});

	test("an unreadable store skips re-arm and leaves the profile disarmed", async () => {
		const profiles = swappedBox();
		byName(profiles, "gsm").autoconnect = "no";
		const { deps, calls } = harness(
			profiles,
			{ ...present, [RM520]: new Set([DARK]) },
			{ failStore: "read" },
		);
		expect((await settleSimSwapProfiles(RM520, DARK, deps)).rearmed).toBe(0);
		expect(calls.filter((c) => c.startsWith("set"))).toEqual([]);
	});

	test("two identical modems holding both SIMs park nothing", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles, {
			...present,
			[RM520]: new Set([LIGHT, DARK]),
		});
		expect((await settleSimSwapProfiles(RM520, LIGHT, deps)).parked).toBe(0);
		expect(calls).toEqual([]);
	});

	test("an unreadable SIM in a modem with the same device id parks nothing", async () => {
		const profiles = swappedBox();
		const { deps, calls } = harness(profiles, {
			...present,
			[RM520]: undefined,
		});
		expect((await settleSimSwapProfiles(RM520, LIGHT, deps)).parked).toBe(0);
		expect(calls).toEqual([]);
	});

	test("a presence read that misses the modem's own SIM parks nothing", async () => {
		const profiles = swappedBox();
		const { deps } = harness(profiles, { ...present, [RM520]: new Set() });
		expect((await settleSimSwapProfiles(RM520, LIGHT, deps)).parked).toBe(0);
	});

	test("a profile up on this modem for an absent SIM is parked too", async () => {
		const profiles = swappedBox();
		byName(profiles, "gsm").activeOn = "cdc-wdm1";
		const { deps } = harness(profiles);
		expect((await settleSimSwapProfiles(RM520, LIGHT, deps)).parked).toBe(1);
		// Still up (autoconnect does not take a connection down); not armed for
		// the next boot's window.
		expect(byName(profiles, "gsm").activeOn).toBe("cdc-wdm1");
		expect(nmAutoconnectChoice(profiles, { deviceId: RM520 })).toBe("generic");
	});

	test("no candidates means no ModemManager reads", async () => {
		const profiles = swappedBox().filter((p) => p.deviceId === FM350);
		let reads = 0;
		const { deps } = harness(profiles);
		await settleSimSwapProfiles(FM350, WARP, {
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
		await settleSimSwapProfiles(RM520, LIGHT, deps, () => false);
		expect(calls).toEqual([]);
	});
});

describe("parking and the duplicate cleanup", () => {
	test("a parked duplicate is never pruned, even disarmed, idle and never used", () => {
		const duplicate: GsmProfileAudit = {
			uuid: uuid(4),
			deviceId: DELL,
			simId: WARP,
			state: "",
			autoconnect: "no",
			timestamp: "0",
		};
		expect(classifyGsmDuplicate(duplicate, uuid(3))).toBe("prune");
		expect(classifyGsmDuplicate(duplicate, uuid(3), true)).toBe("retain");
	});

	test("the SIM coming back keeps both duplicates through cleanup and re-arm", async () => {
		const profiles = swappedBox();
		byName(profiles, "gsm-3").timestamp = 0;
		const parking = harness(profiles);
		await settleSimSwapProfiles(DELL, DARK, parking.deps);
		// gsm-3 was never used and has a sibling for Warp: it stays armed.
		expect(byName(profiles, "gsm-1").autoconnect).toBe("no");
		expect(byName(profiles, "gsm-3").autoconnect).toBe("yes");

		// Warp is back in the Dell: registration reconciles first, then the
		// settle step re-arms.
		const removed: string[] = [];
		await reconcileDuplicateGsmProfiles(
			DELL,
			WARP,
			uuid(3),
			{ "gsm.apn": "internet" },
			{
				audit: async () => audits(profiles),
				setFields: async () => true,
				remove: async (id) => {
					removed.push(id);
					return true;
				},
				isParked: async (id, deviceId, simId) =>
					parking.records.has(parkedProfileKey(id, deviceId, simId)),
			},
		);
		expect(removed).toEqual([]);
		const back = harness(
			profiles,
			{ ...present, [DELL]: new Set([WARP]), [FM350]: new Set() },
			{},
			parking.records,
		);
		// Dark Star's own profile on the Dell is parked in turn.
		expect(await settleSimSwapProfiles(DELL, WARP, back.deps)).toEqual({
			parked: 1,
			rearmed: 1,
			complete: true,
		});
		expect(profiles.map((p) => p.uuid)).toContain(uuid(4));
	});

	test("an older build's duplicate cleanup finds no parked profile to delete", async () => {
		// Every profile never used, so every disarmed one is a prune candidate
		// for the base classifier (it knows nothing of park records).
		const profiles = swappedBox().map((p) => ({ ...p, timestamp: 0 }));
		const deps = harness(profiles).deps;
		const before = new Map(profiles.map((p) => [p.uuid, p.autoconnect]));
		await settleSimSwapProfiles(RM520, LIGHT, deps);
		await settleSimSwapProfiles(DELL, DARK, deps);
		const parked = profiles.filter(
			(p) => before.get(p.uuid) === "yes" && p.autoconnect === "no",
		);
		// The singleton Dark Star profile on the RM520 is still parked.
		expect(parked.map((p) => p.name)).toEqual(["gsm"]);
		for (const profile of parked)
			for (const keep of profiles)
				if (
					keep.uuid !== profile.uuid &&
					keep.deviceId === profile.deviceId &&
					keep.simId === profile.simId
				)
					expect(
						classifyGsmDuplicate(
							audits([profile])[0] as GsmProfileAudit,
							keep.uuid,
						),
					).not.toBe("prune");
	});
});

describe("an incomplete settle", () => {
	test("a SIM that cannot be seen leaves it incomplete, so it is tried again", async () => {
		const profiles = swappedBox();
		const { deps } = harness(profiles, { ...present, [DELL]: undefined });
		expect(await settleSimSwapProfiles(DELL, DARK, deps)).toEqual({
			parked: 0,
			rearmed: 0,
			complete: false,
		});
	});

	test("a failed re-arm write leaves it incomplete and keeps the record", async () => {
		const profiles = swappedBox();
		byName(profiles, "gsm").autoconnect = "no";
		const key = parkedProfileKey(uuid(1), RM520, DARK);
		const records = new Map<string, unknown>([[key, parkedRecord(key)]]);
		const { deps } = harness(
			profiles,
			{ ...present, [RM520]: new Set([DARK]) },
			{ failSet: true },
			records,
		);
		const result = await settleSimSwapProfiles(RM520, DARK, deps);
		expect(result.complete).toBe(false);
		expect(records.has(key)).toBe(true);
	});

	test("a profile audit that missed a profile leaves it incomplete and writes nothing", async () => {
		const profiles = swappedBox();
		const fake = harness(profiles);
		const result = await settleSimSwapProfiles(RM520, LIGHT, {
			...fake.deps,
			audit: async () => undefined,
		});
		expect(result).toEqual({ parked: 0, rearmed: 0, complete: false });
		expect(fake.calls).toEqual([]);
	});

	test("the complete audit refuses a profile whose settings could not be read", async () => {
		const run = spyOn(runner, "run").mockImplementation(
			async (_binary, args) => {
				if (args.includes("uuid,type,state"))
					return `${uuid(1)}:gsm:\n${uuid(2)}:gsm:\n`;
				if (args.at(-1) === uuid(2)) throw new Error("profile unreadable");
				return `${RM520}\n${DARK}\nyes\n300`;
			},
		);
		try {
			expect(await auditGsmProfilesComplete()).toBeUndefined();
			// The cleanup's own audit keeps skipping it, as before.
			expect((await auditGsmProfiles()).map((a) => a.uuid)).toEqual([uuid(1)]);
		} finally {
			run.mockRestore();
		}
	});

	test("the complete audit reads nmcli's LF-terminated inventory and refuses a truncated record", async () => {
		let truncated = false;
		const run = spyOn(runner, "run").mockImplementation(
			async (_binary, args) => {
				if (args.includes("uuid,type,state"))
					return `${uuid(1)}:gsm:\n${uuid(2)}:802-11-wireless:\n`;
				return truncated
					? `${RM520}\n${DARK}\n`
					: `${RM520}\n${DARK}\nyes\n300\n`;
			},
		);
		try {
			expect((await auditGsmProfilesComplete())?.map((a) => a.uuid)).toEqual([
				uuid(1),
			]);
			truncated = true;
			expect(await auditGsmProfilesComplete()).toBeUndefined();
		} finally {
			run.mockRestore();
		}
	});

	test("the complete audit refuses an inventory record cut short before its state", async () => {
		let inventory = `${uuid(1)}:gsm:\n`;
		const run = spyOn(runner, "run").mockImplementation(
			async (_binary, args) => {
				if (args.includes("uuid,type,state")) return inventory;
				return `${RM520}\n${DARK}\nyes\n300\n`;
			},
		);
		try {
			expect((await auditGsmProfilesComplete())?.map((a) => a.uuid)).toEqual([
				uuid(1),
			]);
			inventory = `${uuid(1)}:gsm\n`;
			expect(await auditGsmProfilesComplete()).toBeUndefined();
			// The cleanup's own audit reads it as before.
			expect((await auditGsmProfiles()).map((a) => a.uuid)).toEqual([uuid(1)]);
		} finally {
			run.mockRestore();
		}
	});

	test("nothing to do is complete", async () => {
		const profiles = swappedBox();
		const { deps } = harness(profiles);
		expect((await settleSimSwapProfiles(FM350, WARP, deps)).complete).toBe(
			true,
		);
	});
});

describe("the park store", () => {
	test("records survive in their own store and are removed on re-arm", async () => {
		const profiles = swappedBox();
		const fake = harness(profiles).deps;
		const real = defaultGsmSimSwapDeps(async (id) => present[id]);
		const deps = { ...real, audit: fake.audit, setFields: fake.setFields };
		await settleSimSwapProfiles(RM520, LIGHT, deps);
		const key = parkedProfileKey(uuid(1), RM520, DARK);
		expect(await real.readParked(key)).toEqual(parkedRecord(key));
		expect(await isProfileParked(uuid(1), RM520, DARK)).toBe(true);
		await settleSimSwapProfiles(RM520, DARK, {
			...deps,
			presentSims: async () => new Set([DARK]),
		});
		expect(byName(profiles, "gsm").autoconnect).toBe("yes");
		expect(await real.readParked(key)).toBeUndefined();
		expect(await isProfileParked(uuid(1), RM520, DARK)).toBe(false);
	});
});

describe("rollback to a build without parking", () => {
	test("every store the boot inventory parses stays readable by the base parsers", async () => {
		const profiles = swappedBox();
		const fake = harness(profiles).deps;
		const real = defaultGsmSimSwapDeps(async (id) => present[id]);
		await settleSimSwapProfiles(DELL, DARK, {
			...real,
			audit: fake.audit,
			setFields: fake.setFields,
		});
		// What an older build is left with: two disarmed profiles in
		// NetworkManager and records only in the park store.
		expect(byName(profiles, "gsm-1").autoconnect).toBe("no");
		expect(await isProfileParked(uuid(3), DELL, WARP)).toBe(true);
		const parkKey = parkedProfileKey(uuid(3), DELL, WARP);
		for (const [dir, parse] of [
			[
				process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
				parsePreparationRecord,
			],
			[
				process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR,
				parseCarrierIntentSlot,
			],
		] as const) {
			if (dir === undefined) throw new Error("test store not configured");
			for (const key of await listPrivateJsonKeys({ dir })) {
				expect(key).not.toBe(parkKey);
				const value: unknown = JSON.parse(
					readFileSync(join(dir, `${key}.json`), "utf8"),
				);
				expect(() => parse(value, key)).not.toThrow();
			}
		}
		// The base parser rejects a record of this shape, which is why it lives
		// in its own store.
		expect(() =>
			parsePreparationRecord(
				{ version: 1, kind: "parked", key: parkKey, original: "yes" },
				parkKey,
			),
		).toThrow();
	});
});
