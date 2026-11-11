import { expect, test } from "bun:test";
import {
	type AutomaticFamilyDeps,
	automaticBearerFamilyEligible,
	reconcileAutomaticBearerFamily,
	restoreAutomaticBearerFamily,
} from "./automatic-bearer-family.ts";
import type { ReadyModemSim } from "./modem-registration.ts";

function fixture() {
	const pair = { deviceId: "synthetic-device", simId: "synthetic-sim" };
	const original: Record<string, string> = {
		"ipv4.method": "auto",
		"ipv6.method": "ignore",
		"ipv6.never-default": "no",
		"ipv6.ip6-privacy": "-1",
		"ipv6.ignore-auto-dns": "no",
	};
	let fields = { ...original };
	let livePair = { ...pair };
	let present = true;
	let ignoreWrite = false;
	let refuseWrite = false;
	let partialFailure = false;
	let onExecuting = () => {};
	let onJournal = () => {};
	const calls: string[] = [];
	let inverse: Readonly<Record<string, unknown>> = {};
	const deps: AutomaticFamilyDeps = {
		readFields: async (_uuid, names) =>
			names.map((name) =>
				name === "gsm.device-id"
					? livePair.deviceId
					: name === "gsm.sim-id"
						? livePair.simId
						: fields[name],
			),
		writeFields: async (_uuid, next) => {
			calls.push("write");
			if (partialFailure) {
				partialFailure = false;
				refuseWrite = true;
				fields = { ...fields, "ipv6.method": "auto" };
				return false;
			}
			if (refuseWrite) return false;
			if (!ignoreWrite) fields = { ...fields, ...next };
			return true;
		},
		pairPresent: async () => present,
		journal: async (_key, _kind, before, work) => {
			inverse = before;
			calls.push("armed");
			onJournal();
			const result = await work({
				entry: {} as never,
				markExecuting: async () => {
					calls.push("executing");
					onExecuting();
				},
				markFailed: async () => {},
			});
			calls.push(result.confirmed ? "confirmed" : "blocked");
			return { ok: true, value: result.value };
		},
	};
	return {
		pair,
		original,
		deps,
		calls,
		fields: () => fields,
		inverse: () => inverse,
		setPresent: (v: boolean) => {
			present = v;
		},
		setLivePair: (v: typeof pair) => {
			livePair = v;
		},
		setIgnoreWrite: (v: boolean) => {
			ignoreWrite = v;
		},
		setPartialFailure: () => {
			partialFailure = true;
		},
		setRefuseWrite: (v: boolean) => {
			refuseWrite = v;
		},
		onExecuting: (f: () => void) => {
			onExecuting = f;
		},
		onJournal: (f: () => void) => {
			onJournal = f;
		},
	};
}

test("stored family writes are journaled, verified and idempotent", async () => {
	const f = fixture();
	expect(
		await reconcileAutomaticBearerFamily(
			"key",
			"uuid",
			f.pair,
			() => true,
			f.deps,
		),
	).toBe("updated");
	expect(f.calls).toEqual(["armed", "executing", "write", "confirmed"]);
	expect(f.fields()).toMatchObject({
		"ipv6.method": "auto",
		"ipv6.never-default": "yes",
		"ipv6.ignore-auto-dns": "yes",
	});
	expect(f.inverse()).toMatchObject({
		format: "automatic-bearer-family-v1",
		fields: f.original,
	});
	expect(
		await reconcileAutomaticBearerFamily(
			"key",
			"uuid",
			f.pair,
			() => true,
			f.deps,
		),
	).toBe("unchanged");
	expect(f.calls.filter((x) => x === "write")).toHaveLength(1);
});

test("manual intent or missing/moved SIM cannot mutate", async () => {
	const f = fixture();
	expect(
		await reconcileAutomaticBearerFamily(
			"key",
			"uuid",
			f.pair,
			() => false,
			f.deps,
		),
	).toBe("refused");
	f.setLivePair({ ...f.pair, simId: "other" });
	expect(
		await reconcileAutomaticBearerFamily(
			"key",
			"uuid",
			f.pair,
			() => true,
			f.deps,
		),
	).toBe("refused");
	expect(f.calls).toEqual([]);
});

test("identity and intent are rechecked after journal arming and executing", async () => {
	for (const stage of ["armed", "executing"]) {
		const f = fixture();
		if (stage === "armed") f.onJournal(() => f.setPresent(false));
		else f.onExecuting(() => f.setPresent(false));
		expect(
			await reconcileAutomaticBearerFamily(
				"key",
				"uuid",
				f.pair,
				() => true,
				f.deps,
			),
		).toBe("refused");
		expect(f.calls).not.toContain("write");
	}
});

test("silent setter is not accepted as an update and baseline remains recoverable", async () => {
	const f = fixture();
	f.setIgnoreWrite(true);
	expect(
		await reconcileAutomaticBearerFamily(
			"key",
			"uuid",
			f.pair,
			() => true,
			f.deps,
		),
	).toBe("failed");
	expect(f.calls.at(-1)).toBe("confirmed");
	expect(f.fields()).toEqual(f.original);
});

test("rollback is pair-bound, readback-verified and refuses unknown journal shapes", async () => {
	const f = fixture();
	await reconcileAutomaticBearerFamily(
		"key",
		"uuid",
		f.pair,
		() => true,
		f.deps,
	);
	expect(await restoreAutomaticBearerFamily("key", {}, f.deps)).toBe("failed");
	f.setLivePair({ ...f.pair, simId: "other" });
	expect(await restoreAutomaticBearerFamily("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	f.setLivePair(f.pair);
	f.setIgnoreWrite(true);
	expect(await restoreAutomaticBearerFamily("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	f.setIgnoreWrite(false);
	expect(await restoreAutomaticBearerFamily("key", f.inverse(), f.deps)).toBe(
		"restored",
	);
	expect(f.fields()).toEqual(f.original);
});

test("partial write with an unverified inverse stays blocked", async () => {
	const f = fixture();
	f.setPartialFailure();
	expect(
		await reconcileAutomaticBearerFamily(
			"key",
			"uuid",
			f.pair,
			() => true,
			f.deps,
		),
	).toBe("failed");
	expect(f.calls.at(-1)).toBe("blocked");
});

test("empty pairing evidence cannot authorize profile writes", async () => {
	const f = fixture();
	for (const pair of [
		{ ...f.pair, deviceId: "" },
		{ ...f.pair, simId: "" },
	])
		expect(
			await reconcileAutomaticBearerFamily(
				"key",
				"uuid",
				pair,
				() => true,
				f.deps,
			),
		).toBe("refused");
	expect(f.calls).toEqual([]);
});

test("runtime eligibility uses subscription evidence and exact transport admission", () => {
	const ready: ReadyModemSim = {
		modemInfo: {
			"modem.generic.sim": "/org/freedesktop/ModemManager1/SIM/0",
			"modem.generic.state": "registered",
			"modem.generic.model": "RM520N-GL",
			"modem.generic.revision": "RM520NGLAAR01A08M4G",
			"modem.generic.ports": ["control (qmi)", "uplink (net)"],
			"modem.generic.current-modes": "allowed: 4g; preferred: none",
			"modem.generic.supported-modes": [],
			"modem.generic.access-technologies": [],
			"modem.generic.device-identifier": "synthetic-device",
			"modem.generic.equipment-identifier": "000000000000000",
			"modem.generic.signal-quality.value": 50,
		},
		simInfo: {
			"sim.properties.iccid": "89000000000000000000",
			"sim.properties.operator-code": "310260",
			"sim.properties.gid1": "6910",
		},
	};
	expect(automaticBearerFamilyEligible(ready)).toBe(true);
	expect(
		automaticBearerFamilyEligible({
			...ready,
			modemInfo: { ...ready.modemInfo, "modem.generic.revision": "unknown" },
		}),
	).toBe(false);
	expect(
		automaticBearerFamilyEligible({
			...ready,
			simInfo: { ...ready.simInfo, "sim.properties.operator-code": "00101" },
		}),
	).toBe(false);
	expect(
		automaticBearerFamilyEligible({
			...ready,
			simInfo: { ...ready.simInfo, "sim.properties.operator-code": "311480" },
		}),
	).toBe(false);
	expect(
		automaticBearerFamilyEligible({
			...ready,
			modemInfo: {
				...ready.modemInfo,
				"modem.generic.ports": ["uplink (net)"],
			},
		}),
	).toBe(false);
});
