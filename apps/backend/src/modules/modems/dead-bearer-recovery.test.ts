import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import { setForwardActive } from "../streaming/forward-activity.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	DEAD_BEARER_AFTER_DIAL_MS,
	DEAD_BEARER_ALONE_HOLD_MS,
	DEAD_BEARER_HOLD_MS,
	DEAD_BEARER_MIN_FAILURES,
	type DeadBearerDeps,
	type DeadBearerInput,
	type DeadBearerMemory,
	decideDeadBearer,
	runDeadBearerRecovery,
	setDeadBearerDepsForTest,
} from "./dead-bearer-recovery.ts";
import {
	getModem,
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "./modems-state.ts";

const UUID = "9b0c1f3e-4f4f-4a51-9a51-3a0d1b7e2c11";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";
const WALL = 1_800_000_000_000;

function record(
	partial: Partial<UplinkHealthRecord> & Pick<UplinkHealthRecord, "state">,
	wall = WALL,
): UplinkHealthRecord {
	return {
		iface: "wwan0",
		kind: "cellular",
		weight: partial.state === "up" ? 100 : 0,
		lastTransition: wall,
		staleAt: wall + 15_000,
		probes: {
			successes: 0,
			failures: partial.state === "down" ? DEAD_BEARER_MIN_FAILURES : 0,
		},
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
		record: record({ state: "down" }),
		otherUplinkUp: true,
		owned: true,
		nativeAnswers: false,
		carryingStream: false,
		nmState: "100",
		mmState: "connected",
		lastDial: undefined,
		memory,
		...overrides,
	};
}

/** Feed the same input every 10 s; returns the times a reconnect was decided. */
function run(
	from: number,
	until: number,
	overrides: (now: number) => Partial<DeadBearerInput> = () => ({}),
	start: DeadBearerMemory = { reconnects: 0 },
): { times: number[]; memory: DeadBearerMemory } {
	let memory = start;
	const times: number[] = [];
	for (let now = from; now <= until; now += 10_000) {
		const decision = decideDeadBearer(input(now, overrides(now), memory));
		memory = decision.memory;
		if (decision.action === "reconnect") times.push(now);
	}
	return { times, memory };
}

describe("decideDeadBearer", () => {
	test("the hold counts from the first outage this module saw, on the monotonic clock", () => {
		// A wall-clock lastTransition far in the past must not skip the hold.
		const stale = { record: record({ state: "down", lastTransition: 0 }) };
		const first = decideDeadBearer(input(1_000, stale));
		expect(first.action).toBe("wait");
		expect(first.memory.downSince).toBe(1_000);
		expect(
			decideDeadBearer(
				input(1_000 + DEAD_BEARER_HOLD_MS - 1, stale, first.memory),
			).action,
		).toBe("wait");
		expect(
			decideDeadBearer(input(1_000 + DEAD_BEARER_HOLD_MS, stale, first.memory))
				.action,
		).toBe("reconnect");
	});

	test("with no independent uplink up the hold is five minutes", () => {
		const alone = () => ({ otherUplinkUp: false });
		expect(run(0, DEAD_BEARER_ALONE_HOLD_MS - 10_000, alone).times).toEqual([]);
		expect(run(0, DEAD_BEARER_ALONE_HOLD_MS, alone).times).toEqual([
			DEAD_BEARER_ALONE_HOLD_MS,
		]);
	});

	test("a link carrying the stream is never reconnected, however long health reads down", () => {
		expect(run(0, 3_600_000, () => ({ carryingStream: true })).times).toEqual(
			[],
		);
	});

	test("the outage restarts when the link carries stream traffic in between", () => {
		const { times } = run(0, 130_000, (now) => ({
			carryingStream: now === 50_000,
		}));
		// Seen again at 60 s, so the 60 s hold ends at 120 s, not at 60 s.
		expect(times).toEqual([120_000]);
	});

	test("fewer consecutive probe failures than the minimum never reconnect", () => {
		const few = () => ({
			record: record({
				state: "down",
				probes: { successes: 0, failures: DEAD_BEARER_MIN_FAILURES - 1 },
			}),
		});
		expect(run(0, 3_600_000, few).times).toEqual([]);
	});

	for (const [name, overrides] of [
		["a manual profile", { owned: false }],
		[
			"a translated modem whose native IPv6 still answers",
			{ nativeAnswers: true },
		],
		[
			"address loss",
			{ record: record({ state: "down", reason: "definitive_loss" }) },
		],
		[
			"a captive portal",
			{ record: record({ state: "down", reason: "captive_portal" }) },
		],
		[
			"passive congestion",
			{ record: record({ state: "degraded", reason: "passive_congestion" }) },
		],
		["no record", { record: undefined }],
		["a bearer already down", { nmState: "30" }],
		["a bearer activating", { nmState: "50" }],
		["an unreadable NetworkManager state", { nmState: undefined }],
		["a modem searching", { mmState: "searching" }],
	] as const) {
		test(`${name} never reconnects`, () => {
			expect(
				run(0, 3_600_000, () => overrides as Partial<DeadBearerInput>).times,
			).toEqual([]);
		});
	}

	test("no reconnect within a minute of any dial of the same modem", () => {
		const dialledAt = DEAD_BEARER_HOLD_MS - 10_000;
		const { times } = run(0, 160_000, () => ({ lastDial: dialledAt }));
		expect(times).toEqual([dialledAt + DEAD_BEARER_AFTER_DIAL_MS]);
	});

	test("reconnects are spaced at least 60, 120, 240, 480, then 900 s apart", () => {
		const { times } = run(0, 4 * 3_600_000);
		const gaps = times
			.slice(1)
			.map((time, index) => time - (times[index] ?? 0));
		// After a reconnect the outage has to be seen again for the 60 s hold, so
		// the first gap is one poll longer than the spacing alone.
		expect(gaps[0]).toBe(70_000);
		expect(gaps.slice(1, 5)).toEqual([120_000, 240_000, 480_000, 900_000]);
		for (const gap of gaps.slice(5)) expect(gap).toBe(900_000);
	});

	test("five minutes up reset the spacing; a shorter spell does not", () => {
		const grown: DeadBearerMemory = { reconnects: 4, lastReconnect: 0 };
		const up = () => ({ record: record({ state: "up" }) });
		const short = run(10_000, 120_000, up, grown).memory;
		expect(short.reconnects).toBe(4);
		const long = run(10_000, 320_000, up, grown).memory;
		expect(long.reconnects).toBe(0);
		expect(run(400_000, 460_000, () => ({}), long).times).toEqual([460_000]);
	});
});

describe("runDeadBearerRecovery", () => {
	let now: number;
	let wall: number;
	let health: UplinkHealthRecord | undefined;
	let others: UplinkHealthRecord[];
	let clatParents: Record<string, string>;
	let tunHealth: UplinkHealthRecord | undefined;
	/** The modem's own record stops refreshing (its probes stopped reporting). */
	let healthFrozen: boolean;
	/** The translator's record stops refreshing too. */
	let tunFrozen: boolean;
	let streaming: boolean;
	let telemetryRows: { iface: string; stale: boolean }[];
	let autoconnect: string;
	let grant: boolean;
	let nmState: string | undefined;
	let mmState: string | undefined;
	let connectResult: boolean;
	let dials: Map<string, number>;
	let calls: string[];
	let ownerReads: number;
	let onDisconnect: (() => Promise<void>) | undefined;

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

	function deps(): Partial<DeadBearerDeps> {
		return {
			now: () => now,
			wallNow: () => wall,
			ids: () => getModemIds(),
			stableKey: (id) => (id === 2 ? KEY : undefined),
			health: (iface) =>
				iface === "wwan0" ? health : iface === "clat7" ? tunHealth : undefined,
			healthList: () => [
				...(health ? [health] : []),
				...(tunHealth ? [tunHealth] : []),
				...others,
			],
			clatParent: (iface) => clatParents[iface],
			clatTun: (parent) =>
				Object.keys(clatParents).find((tun) => clatParents[tun] === parent),
			streaming: () => streaming,
			telemetry: () =>
				streaming
					? {
							links: telemetryRows.map((row) => ({
								iface: row.iface,
								rtt_ms: 80,
								nak_count: 0,
								weight_percent: 100,
								stale: row.stale,
							})),
							lastReadMs: wall - 1_000,
						}
					: null,
			readAutoconnect: async () => {
				ownerReads++;
				return autoconnect;
			},
			automaticReady: async () => grant,
			nmState: async () => {
				ownerReads++;
				return nmState;
			},
			mmState: async () => mmState,
			lastDial: (key) => dials.get(key),
			noteDial: (key) => {
				dials.set(key, now);
			},
			disconnect: async (uuid) => {
				calls.push(`down ${uuid}`);
				await onDisconnect?.();
			},
			connect: async (uuid, timeout) => {
				calls.push(`up ${uuid} ${timeout}`);
				return connectResult;
			},
		};
	}

	const eth = () =>
		record({ iface: "eth0", kind: "ethernet", state: "up" }, wall);
	const dead = () => record({ state: "down" }, wall);
	const tunDead = () =>
		record({ iface: "clat7", kind: "other", state: "down" }, wall);
	const tunUp = () =>
		record({ iface: "clat7", kind: "other", state: "up" }, wall);

	/** Polls every 15 s until `until`, keeping health fresh. */
	async function pollUntil(until: number): Promise<number[]> {
		const reconnectedAt: number[] = [];
		while (now < until) {
			now += 15_000;
			wall += 15_000;
			if (health && !healthFrozen)
				health =
					health.state === "down" ? dead() : record({ state: "up" }, wall);
			if (tunHealth && !tunFrozen)
				tunHealth = tunHealth.state === "down" ? tunDead() : tunUp();
			others = others.map((other) => ({ ...other, staleAt: wall + 15_000 }));
			const before = calls.length;
			await runDeadBearerRecovery();
			if (calls.length > before) reconnectedAt.push(now);
		}
		return reconnectedAt;
	}

	beforeEach(() => {
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		setForwardActive(false);
		now = 0;
		wall = WALL;
		health = undefined;
		others = [];
		clatParents = {};
		tunHealth = undefined;
		healthFrozen = false;
		tunFrozen = false;
		streaming = false;
		telemetryRows = [];
		autoconnect = "no";
		grant = true;
		nmState = "100";
		mmState = "connected";
		connectResult = true;
		dials = new Map();
		calls = [];
		ownerReads = 0;
		onDisconnect = undefined;
		for (const id of getModemIds()) removeModem(id);
		setModem(2, modem());
		setDeadBearerDepsForTest(deps());
	});

	afterEach(() => {
		setDeadBearerDepsForTest(null);
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		for (const id of getModemIds()) removeModem(id);
	});

	test("a dead bearer is taken down and brought up once the hold has passed", async () => {
		others = [eth()];
		health = dead();
		const at = await pollUntil(120_000);
		expect(at).toEqual([75_000]);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
		expect(dials.get(KEY)).toBe(75_000);
	});

	test("a modem carrying the stream is left alone even when its probes fail", async () => {
		others = [eth()];
		health = dead();
		streaming = true;
		telemetryRows = [{ iface: "wwan0", stale: false }];
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	test("a stale sender row while streaming does not protect a dead link", async () => {
		others = [eth()];
		health = dead();
		streaming = true;
		telemetryRows = [{ iface: "wwan0", stale: true }];
		expect(await pollUntil(120_000)).toEqual([75_000]);
	});

	test("the same modem's translator or a tunnel is not an independent uplink", async () => {
		health = dead();
		others = [
			record({ iface: "clat7", kind: "other", state: "up" }, wall),
			record({ iface: "wg0", kind: "other", state: "up" }, wall),
		];
		const at = await pollUntil(DEAD_BEARER_ALONE_HOLD_MS + 30_000);
		expect(at).toEqual([DEAD_BEARER_ALONE_HOLD_MS + 15_000]);
	});

	/*
	  An IPv6-only modem with a live CLAT translation carries an IPv4 stream
	  through its clat TUN, so the TUN's own health record is the evidence. A
	  dead bearer keeps the translator's lease up for minutes; skipping such a
	  modem left it dead for that whole time and then for the hold again.
	*/
	test("a translated modem is judged by its translator: a live translator keeps it", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunUp();
		health = dead();
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	test("a translated modem whose translator and native path both fail is reconnected", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = dead();
		expect(await pollUntil(120_000)).toEqual([75_000]);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
	});

	test("a translated modem whose native IPv6 still answers is not reconnected", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = record({ state: "up" }, wall);
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	/*
	  A native record that reads `up` but stopped refreshing is unknown, not an
	  answer: the veto lifts and the translator's record decides, as it does for
	  a translated modem with no native record at all.
	*/
	test("a stale native `up` does not veto a translated modem's reconnect", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = record({ state: "up" }, wall - 3_600_000);
		healthFrozen = true;
		expect(await pollUntil(120_000)).toEqual([75_000]);
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
	});

	test("the native veto lifts once its record stops refreshing", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = record({ state: "up" }, wall);
		// Native IPv6 answers for five minutes, then its record goes quiet.
		expect(await pollUntil(300_000)).toEqual([]);
		healthFrozen = true;
		// Stale from 315 s (staleAt is not after the wall clock), then the hold.
		expect(await pollUntil(420_000)).toEqual([375_000]);
	});

	test("an expired translator outage is not evidence once the native veto lifts", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = record({ state: "up" }, wall);
		expect(await pollUntil(300_000)).toEqual([]);
		// Both records go quiet while the lease stays usable; the bearer may
		// have recovered after the last probe.
		healthFrozen = true;
		tunFrozen = true;
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	test("a translator outage that goes quiet mid-hold restarts the hold", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = dead();
		// The outage is first seen at 15 s; at 45 s, short of the hold, the
		// translator's record stops refreshing.
		expect(await pollUntil(45_000)).toEqual([]);
		tunFrozen = true;
		expect(await pollUntil(90_000)).toEqual([]);
		// Fresh again from 105 s: the hold counts from there.
		tunFrozen = false;
		expect(await pollUntil(200_000)).toEqual([165_000]);
	});

	test("a translated modem with no record for its translator yet is left alone", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		others = [eth(), record({ iface: "clat9", kind: "other", state: "down" })];
		health = dead();
		// clat7 is the translation, but only an unrelated TUN has a record.
		expect(await pollUntil(600_000)).toEqual([]);
	});

	test("a stream carried on the translator's row vetoes the reconnect", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = dead();
		streaming = true;
		telemetryRows = [{ iface: "clat7", stale: false }];
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	test("the outage keeps its start when the translator's lease runs out", async () => {
		// Alone, as in the harness: no other uplink, the dead bearer keeps the
		// lease up for about 210 s, then the translation is withdrawn.
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = dead();
		const reconnectedAt: number[] = [];
		while (now < DEAD_BEARER_ALONE_HOLD_MS + 60_000) {
			now += 15_000;
			wall += 15_000;
			health = dead();
			if (now >= 210_000) {
				clatParents = {};
				tunHealth = undefined;
			} else tunHealth = tunDead();
			const before = calls.length;
			await runDeadBearerRecovery();
			if (calls.length > before) reconnectedAt.push(now);
		}
		expect(reconnectedAt).toEqual([DEAD_BEARER_ALONE_HOLD_MS + 15_000]);
	});

	test("a manual profile is never reconnected", async () => {
		others = [eth()];
		health = dead();
		autoconnect = "yes";
		expect(await pollUntil(3_600_000)).toEqual([]);
		autoconnect = "no";
		grant = false;
		expect(await pollUntil(7_200_000)).toEqual([]);
	});

	test("a failed up raises the data-call warning once and is returned for broadcast", async () => {
		others = [eth()];
		health = dead();
		connectResult = false;
		now = 60_000;
		wall += 60_000;
		health = dead();
		others = [eth()];
		expect(await runDeadBearerRecovery()).toEqual([]);
		now = 120_000;
		wall += 60_000;
		health = dead();
		others = [eth()];
		expect(await runDeadBearerRecovery()).toEqual([2]);
		expect(getModem(2)?.data_connection_failed).toBe(true);
		now = 400_000;
		wall += 280_000;
		health = dead();
		others = [eth()];
		expect(await runDeadBearerRecovery()).toEqual([]);
	});

	test("a healthy link never reads the owners or reconnects", async () => {
		health = record({ state: "up" }, wall);
		await pollUntil(600_000);
		expect(ownerReads).toBe(0);
		expect(calls).toEqual([]);
	});

	test("no reconnect within a minute of a redial of the same modem", async () => {
		others = [eth()];
		health = dead();
		dials.set(KEY, 60_000);
		const at = await pollUntil(150_000);
		expect(at).toEqual([120_000]);
	});

	for (const guard of [
		"inhibit",
		"scanning",
		"skip",
		"held lease",
		"stream launch",
		"forwarding",
	] as const) {
		test(`a dead bearer under ${guard} is left alone`, async () => {
			others = [eth()];
			health = dead();
			const row = { ...modem() };
			if (guard === "inhibit") row.inhibit = true;
			if (guard === "scanning") row.is_scanning = true;
			setModem(2, row);
			const lease =
				guard === "held lease" ? tryAcquireModemMutation(KEY) : undefined;
			const launch =
				guard === "stream launch"
					? tryAcquireLifecycle("streaming")
					: undefined;
			if (guard === "forwarding") setForwardActive(true);
			while (now < 600_000) {
				now += 15_000;
				wall += 15_000;
				health = dead();
				others = [eth()];
				await runDeadBearerRecovery(guard === "skip" ? [2] : []);
			}
			if (lease?.admitted) lease.lease.release();
			if (launch?.admitted) launch.lease.release();
			setForwardActive(false);
			expect(calls).toEqual([]);
		});
	}

	test("a bearer that dropped while the lease was being taken is not touched", async () => {
		others = [eth()];
		health = dead();
		let reads = 0;
		setDeadBearerDepsForTest({
			...deps(),
			nmState: async () => {
				reads++;
				// Reads before the reconnect is due say connected; the read under
				// the lease says the bearer has dropped in the meantime.
				return now >= 75_000 && reads % 2 === 0 ? "30" : "100";
			},
		});
		await pollUntil(90_000);
		expect(calls).toEqual([]);
	});

	test("overlapping polls reconnect once", async () => {
		others = [eth()];
		health = dead();
		await pollUntil(60_000);
		now = 75_000;
		wall += 15_000;
		health = dead();
		others = [eth()];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		onDisconnect = async () => {
			started.resolve();
			await release.promise;
		};
		const first = runDeadBearerRecovery();
		await started.promise;
		await Promise.all([runDeadBearerRecovery(), runDeadBearerRecovery()]);
		release.resolve();
		await first;
		expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
	});
});
