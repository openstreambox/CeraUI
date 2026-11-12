import { expect, test } from "bun:test";
import {
	type CellularPreparationDeps,
	type PreparationRecord,
	preparationKey,
	prepareCellularActivation,
} from "./cellular-preparation.ts";
import type { CellularControlTarget } from "./modems.ts";
import { selectSubscription } from "./subscription-policy.ts";

const decision = selectSubscription({ homePlmn: "310260" });
if (decision.state !== "recognized") throw new Error("Policy fixture");
const policy = decision.policy;
const UUID = "121ca73b-9f75-42bd-a737-2c447ca44001";
function fixture(equipment = "000000000000001") {
	let generation = "epoch-one",
		raw: "N" | "Y" = "N",
		qmap = 1,
		initial = { apn: "foreign.invalid", family: "ipv4" as const };
	let autoconnect = "yes",
		live = true,
		setterFails = false,
		now = 0;
	const records = new Map<string, PreparationRecord>();
	const calls: string[] = [];
	const target = () =>
		({
			id: 1,
			key: "synthetic-usb-key",
			deviceId: "synthetic-device",
			simId: "89000000000000000000",
			equipment,
			subscriber: "000000000000001",
			generation,
			ifindex: "19",
			ifname: "wwan0",
			netDevice: "synthetic-net-device",
			usbDevice: "synthetic-usb",
			identity: {
				model: "RM520N-GL",
				firmware: "RM520NGLAAR01A08M4G",
				mode: "qmi",
			},
			initialEps: initial,
			sim: {} as never,
		}) as CellularControlTarget;
	const deps: CellularPreparationDeps = {
		target: async () => target(),
		present: async (value) => value.generation === generation && live,
		acquire: async () => {
			calls.push("acquire");
			return {
				valid: async () => true,
				verifySubscriber: async () => true,
				readAutoConnect: async () => {
					calls.push("qmap-read");
					return qmap;
				},
				disableAutoConnect: async () => {
					expect(
						[...records.values()].some(
							(r) => r.kind === "qmap" && r.original === qmap,
						),
					).toBe(true);
					calls.push("qmap-fix");
					qmap = 0;
					return true;
				},
				reset: async () => {
					calls.push("serial-reset");
					generation = "epoch-two";
				},
				close: async () => {
					calls.push("release");
				},
				registration: async () => true,
				registrationState: async () => "home",
				readContext: async () => undefined,
				contextActive: async () => undefined,
				readGrant: async () => undefined,
				readContextDns: async () => undefined,
				onRevoked: () => () => {},
				defineContext: async () => {},
				activateContext: async () => {},
				readIpv4Grant: async () => undefined,
			};
		},
		raw: async () => raw,
		writeRaw: async (_target, value) => {
			calls.push("raw");
			raw = value;
			return true;
		},
		setEps: async (_target, wanted) => {
			const record = [...records.values()].find((r) => r.kind === "eps");
			expect(record).toMatchObject({
				original: { apn: "foreign.invalid", family: "ipv4" },
				attempted: true,
				phase: "awaiting-usb",
			});
			calls.push("eps-set");
			if (setterFails) return false;
			initial = { ...wanted } as typeof initial;
			return true;
		},
		reset: async () => {
			calls.push("host-reset");
			generation = "epoch-three";
			return true;
		},
		read: async (key) => records.get(key),
		write: async (record) => {
			calls.push(
				`persist-${record.kind}-${"phase" in record ? record.phase : "baseline"}`,
			);
			records.set(record.key, structuredClone(record));
		},
		fields: async () =>
			[
				"synthetic-device",
				"89000000000000000000",
				"yes",
				"",
				autoconnect,
				"legacy",
			] as never,
		setFields: async (_uuid, fields) => {
			calls.push("profile-demote");
			autoconnect = fields["connection.autoconnect"] ?? autoconnect;
			return true;
		},
		intent: async () => undefined,
		journal: async (_key, _kind, _inverse, work) => {
			calls.push("armed");
			const result = await work({
				entry: {} as never,
				markExecuting: async () => {
					calls.push("executing");
				},
				markFailed: async () => {},
			});
			calls.push(result.confirmed ? "confirmed" : "blocked");
			return { ok: true, value: result.value };
		},
		now: () => now,
		autoConfigSupported: () => true,
	};
	return {
		deps,
		calls,
		records,
		target,
		current: async () => live,
		raw: () => raw,
		failSetter: () => {
			setterFails = true;
		},
		setQmap: (v: number) => {
			qmap = v;
		},
		move: (value: string) => {
			generation = value;
		},
		stale: () => {
			live = false;
		},
		age: () => {
			now = 80_000;
		},
	};
}
test("QMAP is baselined per unit and reread after USB return; EPS then raw-IP precede readiness", async () => {
	const f = fixture();
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("waiting-usb");
	expect(f.calls.indexOf("profile-demote")).toBeLessThan(
		f.calls.indexOf("acquire"),
	);
	expect(f.calls).not.toContain("eps-set");
	expect(f.calls).not.toContain("raw");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("pending");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("waiting-usb");
	expect(f.calls.filter((c) => c === "eps-set")).toHaveLength(1);
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("pending");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("ready");
	expect(f.raw()).toBe("Y");
	expect(f.calls.indexOf("host-reset")).toBeLessThan(f.calls.indexOf("raw"));
	const before = f.calls.length;
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("ready");
	expect(f.calls.length).toBe(before);
});
test("a failed EPS setter spends the pair's only attempt across another owner invocation", async () => {
	const f = fixture("000000000000002");
	f.setQmap(0);
	f.failSetter();
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("pending");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("blocked");
	f.move("another-usb-epoch");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("pending");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("blocked");
	expect(f.calls.filter((c) => c === "eps-set")).toHaveLength(1);
	expect(f.calls).not.toContain("raw");
});
test("unqualified carrier, stale generation and unknown firmware dispatch nothing", async () => {
	const f = fixture("000000000000003");
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			{ ...policy, qualified: false },
			f.current,
			f.deps,
		),
	).toBe("preserved");
	expect(
		await prepareCellularActivation(
			UUID,
			{
				...f.target(),
				identity: { ...f.target().identity, firmware: "unknown" },
			},
			policy,
			f.current,
			f.deps,
		),
	).toBe("preserved");
	f.stale();
	expect(
		await prepareCellularActivation(
			UUID,
			f.target(),
			policy,
			f.current,
			f.deps,
		),
	).toBe("pending");
	expect(f.calls).toEqual([]);
});
test("the EPS attempt key follows equipment and SIM, not USB slot", () => {
	expect(preparationKey("eps", "unit-a", "sim-a")).not.toBe(
		preparationKey("eps", "unit-b", "sim-a"),
	);
	expect(preparationKey("eps", "unit-a", "sim-a")).not.toBe(
		preparationKey("eps", "unit-a", "sim-b"),
	);
	expect(preparationKey("eps", "unit-a", "sim-a")).toHaveLength(64);
});

test("a new generic automatic profile delegates APN lookup to verified NM capability", async () => {
	const f = fixture("000000000000004");
	const target = {
		...f.target(),
		identity: {
			model: "DW5821e Snapdragon X20 LTE",
			firmware: "T77W968.F1.0.0.4.2.GC.010\n026",
			mode: "mbim" as const,
		},
	};
	let nmAuto = "no",
		apn = "internet";
	const { newCarrierIntent } = await import("./automatic-carrier-intent.ts");
	const identity = {
		uuid: UUID,
		deviceId: target.deviceId,
		simId: target.simId,
	};
	const deps = {
		...f.deps,
		fields: async () =>
			[
				target.deviceId,
				target.simId,
				nmAuto,
				apn,
				"no",
				`cellular-${UUID}`,
			] as never,
		intent: async () => newCarrierIntent(identity, "automatic"),
		setFields: async (_uuid: string, fields: Record<string, string>) => {
			nmAuto = fields["gsm.auto-config"] ?? nmAuto;
			apn = fields["gsm.apn"] ?? apn;
			return true;
		},
	};
	expect(
		await prepareCellularActivation(UUID, target, undefined, f.current, deps),
	).toBe("ready");
	expect(nmAuto).toBe("yes");
	expect(apn).toBe("");
	expect(f.calls).not.toContain("eps-set");
});

test("a replacement unit never inherits another unit's QMAP readback or baseline", async () => {
	const first = fixture("000000000000005");
	expect(
		await prepareCellularActivation(
			UUID,
			first.target(),
			policy,
			first.current,
			first.deps,
		),
	).toBe("waiting-usb");
	const replacement = fixture("000000000000006");
	replacement.setQmap(0);
	const deps = {
		...replacement.deps,
		read: first.deps.read,
		write: first.deps.write,
	};
	expect(
		await prepareCellularActivation(
			"121ca73b-9f75-42bd-a737-2c447ca44002",
			replacement.target(),
			policy,
			replacement.current,
			deps,
		),
	).toBe("pending");
	expect(
		[...first.records.values()]
			.filter((record) => record.kind === "qmap")
			.map((record) => record.original)
			.sort(),
	).toEqual([0, 1]);
	expect(replacement.calls).toContain("qmap-read");
	expect(replacement.calls).not.toContain("qmap-fix");
});
