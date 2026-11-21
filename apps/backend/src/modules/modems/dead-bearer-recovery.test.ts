import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import {
	DEAD_BEARER_ALONE_HOLD_MS,
	DEAD_BEARER_HOLD_MS,
	type DeadBearerInput,
	type DeadBearerMemory,
	decideDeadBearer,
	runDeadBearerRecovery,
	setDeadBearerDepsForTest,
} from "./dead-bearer-recovery.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "./modems-state.ts";
import { beginModemMutation } from "./mutation-lease.ts";

const UUID = "9b0c1f3e-4f4f-4a51-9a51-3a0d1b7e2c11";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";

function record(
	partial: Partial<UplinkHealthRecord> & Pick<UplinkHealthRecord, "state">,
	now: number,
): UplinkHealthRecord {
	return {
		iface: "wwan0",
		kind: "cellular",
		weight: partial.state === "up" ? 100 : 0,
		lastTransition: 0,
		staleAt: now + 15_000,
		probes: { successes: 0, failures: 3 },
		signals: {},
		...(partial.state === "down" ? { reason: "probe_failed" as const } : {}),
		...partial,
	};
}

function input(
	now: number,
	overrides: Partial<DeadBearerInput> = {},
	memory: DeadBearerMemory = { reconnects: 0 },
): DeadBearerInput {
	return {
		now,
		record: record({ state: "down" }, now),
		otherUplinkUp: true,
		nmState: "100",
		mmState: "connected",
		memory,
		...overrides,
	};
}

describe("decideDeadBearer", () => {
	test("a failed-probe outage past the hold with another uplink up reconnects", () => {
		expect(decideDeadBearer(input(DEAD_BEARER_HOLD_MS - 1)).action).toBe(
			"wait",
		);
		const decision = decideDeadBearer(input(DEAD_BEARER_HOLD_MS));
		expect(decision.action).toBe("reconnect");
		expect(decision.memory).toEqual({
			reconnects: 1,
			lastReconnect: DEAD_BEARER_HOLD_MS,
		});
	});

	test("with no other uplink up the hold is five minutes", () => {
		const alone = { otherUplinkUp: false };
		expect(
			decideDeadBearer(input(DEAD_BEARER_ALONE_HOLD_MS - 1, alone)).action,
		).toBe("wait");
		expect(
			decideDeadBearer(input(DEAD_BEARER_ALONE_HOLD_MS, alone)).action,
		).toBe("reconnect");
	});

	for (const [name, overrides] of [
		[
			"address loss",
			{ record: record({ state: "down", reason: "definitive_loss" }, 600_000) },
		],
		[
			"captive portal",
			{ record: record({ state: "down", reason: "captive_portal" }, 600_000) },
		],
		[
			"degraded",
			{
				record: record(
					{ state: "degraded", reason: "passive_congestion" },
					600_000,
				),
			},
		],
		["no record", { record: undefined }],
		[
			"stale evidence",
			{ record: record({ state: "down", staleAt: 600_000 }, 600_000) },
		],
		["bearer already down", { nmState: "30" }],
		["bearer activating", { nmState: "50" }],
		["unreadable NetworkManager state", { nmState: undefined }],
		["searching", { mmState: "searching" }],
		["unreadable ModemManager state", { mmState: undefined }],
	] as const) {
		test(`${name} never reconnects`, () => {
			expect(
				decideDeadBearer(input(600_000, overrides as Partial<DeadBearerInput>))
					.action,
			).not.toBe("reconnect");
		});
	}

	test("reconnects are spaced 60, 120, 240, 480, then 900 s apart", () => {
		let memory: DeadBearerMemory = { reconnects: 0 };
		const times: number[] = [];
		for (let now = DEAD_BEARER_HOLD_MS; now <= 4 * 3_600_000; now += 10_000) {
			const decision = decideDeadBearer(input(now, {}, memory));
			memory = decision.memory;
			if (decision.action === "reconnect") times.push(now);
		}
		const gaps = times
			.slice(1)
			.map((time, index) => time - (times[index] ?? 0));
		expect(gaps.slice(0, 5)).toEqual([
			60_000, 120_000, 240_000, 480_000, 900_000,
		]);
		for (const gap of gaps.slice(5)) expect(gap).toBe(900_000);
	});

	test("five minutes up reset the spacing; a shorter up spell does not", () => {
		const grown: DeadBearerMemory = { reconnects: 4, lastReconnect: 0 };
		let memory = grown;
		for (let now = 10_000; now < 10_000 + 120_000; now += 10_000)
			memory = decideDeadBearer(
				input(now, { record: record({ state: "up" }, now) }, memory),
			).memory;
		expect(memory.reconnects).toBe(4);
		for (let now = 130_000; now <= 10_000 + 300_000; now += 10_000)
			memory = decideDeadBearer(
				input(now, { record: record({ state: "up" }, now) }, memory),
			).memory;
		expect(memory.reconnects).toBe(0);
		const next = decideDeadBearer(
			input(
				400_000,
				{ record: record({ state: "down", lastTransition: 330_000 }, 400_000) },
				memory,
			),
		);
		expect(next.action).toBe("reconnect");
	});
});

describe("runDeadBearerRecovery", () => {
	let now: number;
	let health: UplinkHealthRecord | undefined;
	let others: UplinkHealthRecord[];
	let nmState: string | undefined;
	let mmState: string | undefined;
	let calls: string[];
	let ownerReads: number;

	function modem(): Modem {
		return {
			ifname: "wwan0",
			name: "Test modem",
			sim_network: "Test",
			network_type: { supported: {}, active: null },
			config: {
				conn: UUID,
				autoconfig: false,
				apn: "internet",
				username: "",
				password: "",
				roaming: false,
				network: "",
			},
		};
	}

	beforeEach(() => {
		now = 0;
		health = undefined;
		others = [];
		nmState = "100";
		mmState = "connected";
		calls = [];
		ownerReads = 0;
		for (const id of getModemIds()) removeModem(id);
		setModem(2, modem());
		setDeadBearerDepsForTest({
			now: () => now,
			ids: () => getModemIds(),
			stableKey: (id) => (id === 2 ? KEY : undefined),
			health: (iface) => (iface === "wwan0" ? health : undefined),
			healthList: () => [...(health ? [health] : []), ...others],
			nmState: async () => {
				ownerReads++;
				return nmState;
			},
			mmState: async () => {
				ownerReads++;
				return mmState;
			},
			disconnect: async (uuid) => {
				calls.push(`down ${uuid}`);
			},
			connect: async (uuid, timeout) => {
				calls.push(`up ${uuid} ${timeout}`);
				return true;
			},
		});
	});

	afterEach(() => {
		setDeadBearerDepsForTest(null);
		for (const id of getModemIds()) removeModem(id);
	});

	function goDown(at: number): void {
		health = record({ state: "down", lastTransition: at }, now);
	}

	test("a dead bearer is taken down and brought up once the hold has passed", async () => {
		others = [record({ iface: "eth0", kind: "ethernet", state: "up" }, 70_000)];
		goDown(0);
		now = 30_000;
		health = record({ state: "down", lastTransition: 0 }, now);
		expect(await runDeadBearerRecovery()).toEqual([]);
		now = 60_000;
		health = record({ state: "down", lastTransition: 0 }, now);
		expect(await runDeadBearerRecovery()).toEqual([2]);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
		now = 90_000;
		health = record({ state: "down", lastTransition: 0 }, now);
		others = [record({ iface: "eth0", kind: "ethernet", state: "up" }, now)];
		expect(await runDeadBearerRecovery()).toEqual([]);
	});

	test("a healthy link never reads the owners or reconnects", async () => {
		health = record({ state: "up" }, now);
		await runDeadBearerRecovery();
		expect(ownerReads).toBe(0);
		expect(calls).toEqual([]);
	});

	for (const guard of [
		"inhibit",
		"scanning",
		"skip",
		"lease",
		"identity",
	] as const) {
		test(`a dead bearer under ${guard} is left alone`, async () => {
			now = 600_000;
			others = [record({ iface: "eth0", kind: "ethernet", state: "up" }, now)];
			health = record({ state: "down", lastTransition: 0 }, now);
			const row = { ...modem() };
			if (guard === "inhibit") row.inhibit = true;
			if (guard === "scanning") row.is_scanning = true;
			setModem(2, row);
			const lease = guard === "lease" ? beginModemMutation(KEY) : undefined;
			if (lease && !lease.ok) throw new Error("lease refused");
			if (guard === "identity")
				setDeadBearerDepsForTest({
					now: () => now,
					ids: () => getModemIds(),
					stableKey: () => undefined,
					health: () => health,
					healthList: () => [...(health ? [health] : []), ...others],
					nmState: async () => nmState,
					mmState: async () => mmState,
					disconnect: async (uuid) => {
						calls.push(`down ${uuid}`);
					},
					connect: async () => true,
				});
			await runDeadBearerRecovery(guard === "skip" ? [2] : []);
			if (lease?.ok) lease.lease.release();
			expect(calls).toEqual([]);
		});
	}

	test("a modem that recovered while the lease was being taken is not touched", async () => {
		now = 600_000;
		others = [record({ iface: "eth0", kind: "ethernet", state: "up" }, now)];
		health = record({ state: "down", lastTransition: 0 }, now);
		let reads = 0;
		setDeadBearerDepsForTest({
			now: () => now,
			ids: () => getModemIds(),
			stableKey: (id) => (id === 2 ? KEY : undefined),
			health: () => health,
			healthList: () => [...(health ? [health] : []), ...others],
			nmState: async () => {
				reads++;
				// The second read happens under the lease: the bearer dropped.
				return reads === 1 ? "100" : "30";
			},
			mmState: async () => mmState,
			disconnect: async (uuid) => {
				calls.push(`down ${uuid}`);
			},
			connect: async () => true,
		});
		await runDeadBearerRecovery();
		expect(calls).toEqual([]);
	});

	test("overlapping polls reconnect once", async () => {
		now = 600_000;
		others = [record({ iface: "eth0", kind: "ethernet", state: "up" }, now)];
		health = record({ state: "down", lastTransition: 0 }, now);
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		setDeadBearerDepsForTest({
			now: () => now,
			ids: () => getModemIds(),
			stableKey: (id) => (id === 2 ? KEY : undefined),
			health: () => health,
			healthList: () => [...(health ? [health] : []), ...others],
			nmState: async () => nmState,
			mmState: async () => mmState,
			disconnect: async (uuid) => {
				calls.push(`down ${uuid}`);
				started.resolve();
				await release.promise;
			},
			connect: async (uuid) => {
				calls.push(`up ${uuid}`);
				return true;
			},
		});
		const first = runDeadBearerRecovery();
		await started.promise;
		await Promise.all([runDeadBearerRecovery(), runDeadBearerRecovery()]);
		release.resolve();
		await first;
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID}`]);
	});
});
