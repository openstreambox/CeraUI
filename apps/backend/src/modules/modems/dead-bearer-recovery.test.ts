import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isLinkTeardownPending,
	resetLinkTeardownPendingForTest,
	setLinkTeardownPending,
} from "../network/link-teardown-pending.ts";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import { setForwardActive } from "../streaming/forward-activity.ts";
import {
	currentLifecycleHolder,
	isModemMutationHeld,
	LINK_TEARDOWN_MAX_HOLD_MS,
	type LifecycleLease,
	linkTeardownSettled,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import type { LinkCarryingState } from "../streaming/link-progress.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	DEAD_BEARER_AFTER_DIAL_MS,
	DEAD_BEARER_ALONE_HOLD_MS,
	DEAD_BEARER_HOLD_MS,
	DEAD_BEARER_MAX_HOLD_RESTARTS,
	DEAD_BEARER_MIN_FAILURES,
	type DeadBearerDeps,
	type DeadBearerInput,
	type DeadBearerMemory,
	decideDeadBearer,
	type NmDeviceState,
	runDeadBearerRecovery,
	seedPendingTeardowns,
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
		stream: "idle",
		nmState: "100",
		mmState: "connected",
		lastDial: undefined,
		streamCycle: 0,
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
		expect(run(0, 3_600_000, () => ({ stream: "carrying" })).times).toEqual([]);
	});

	test("while streaming, unknown link traffic never reconnects", () => {
		expect(run(0, 3_600_000, () => ({ stream: "unknown" })).times).toEqual([]);
	});

	test("while streaming, a link the sender reports as carrying nothing is reconnected after the hold", () => {
		expect(
			run(0, DEAD_BEARER_HOLD_MS, () => ({ stream: "not_carrying" })).times,
		).toEqual([DEAD_BEARER_HOLD_MS]);
	});

	for (const between of ["carrying", "unknown"] as const) {
		test(`the outage restarts when the link's traffic reads ${between} in between`, () => {
			const { times } = run(0, 130_000, (now) => ({
				stream: now === 50_000 ? between : "not_carrying",
			}));
			// Seen again at 60 s, so the 60 s hold ends at 120 s, not at 60 s.
			expect(times).toEqual([120_000]);
		});
	}

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
	let streaming: boolean;
	let carrying: Record<string, LinkCarryingState>;
	let autoconnect: string;
	let grant: boolean;
	let nmState: string | undefined;
	let mmState: string | undefined;
	let connectResult: boolean;
	let dials: Map<string, number>;
	let calls: string[];
	let ownerReads: number;
	let onDisconnect: (() => Promise<void>) | undefined;
	/** The modem's NM device as NetworkManager would report it. */
	let device: NmDeviceState | undefined;
	/** What the device reads once the `down` was issued. */
	let afterDown: NmDeviceState | undefined;
	let sleeps: number;
	/** `nmcli device status` fails: the device lookup cannot answer. */
	let lookupFails: boolean;

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
			carrying: (iface) => carrying[iface] ?? "unknown",
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
				device = afterDown;
				await onDisconnect?.();
			},
			connect: async (uuid, timeout) => {
				calls.push(`up ${uuid} ${timeout}`);
				device = { state: "100", connection: uuid };
				return connectResult;
			},
			resolveDevice: async () => (lookupFails ? undefined : "cdc-wdm0"),
			deviceState: async () => device,
			sleep: async (ms) => {
				sleeps++;
				now += ms;
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
			if (health?.state === "down") health = dead();
			if (tunHealth)
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
		streaming = false;
		carrying = {};
		autoconnect = "no";
		grant = true;
		nmState = "100";
		mmState = "connected";
		connectResult = true;
		dials = new Map();
		calls = [];
		ownerReads = 0;
		onDisconnect = undefined;
		device = { state: "100", connection: UUID };
		afterDown = { state: "30", connection: undefined };
		sleeps = 0;
		lookupFails = false;
		resetLinkTeardownPendingForTest();
		for (const id of getModemIds()) removeModem(id);
		setModem(2, modem());
		setDeadBearerDepsForTest(deps());
	});

	afterEach(() => {
		setDeadBearerDepsForTest(null);
		resetLinkTeardownPendingForTest();
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
		carrying = { wwan0: "carrying" };
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	test("while streaming, a link without traffic evidence is left alone", async () => {
		others = [eth()];
		health = dead();
		streaming = true;
		expect(await pollUntil(3_600_000)).toEqual([]);
	});

	test("while streaming, a link the sender reports as carrying nothing is reconnected", async () => {
		others = [eth()];
		health = dead();
		streaming = true;
		carrying = { wwan0: "not_carrying" };
		expect(await pollUntil(120_000)).toEqual([75_000]);
	});

	/*
	  The reconnect runs under a journal-only key, which never refuses a Stream
	  Start, and its owner reads await. These pin that a stream admitted, gone
	  live or ended during those reads stops the teardown, and that no stream is
	  admitted while the link goes down.
	*/
	/** Runs `during` in the first `times` owner reads made under the lease. */
	function duringLeasedReads(during: () => void, times = 1): void {
		let left = times;
		const base = deps();
		setDeadBearerDepsForTest({
			...base,
			mmState: async (id) => {
				if (left > 0 && isModemMutationHeld(KEY)) {
					left--;
					during();
				}
				return (await base.mmState?.(id)) ?? mmState;
			},
		});
	}

	describe("a stream never starts into a teardown", () => {
		test("a Start admitted during the owner reads is not taken down", async () => {
			others = [eth()];
			health = dead();
			let admission: LifecycleLease | undefined;
			duringLeasedReads(() => {
				const admitted = tryAcquireLifecycle("streaming");
				// The background lease stays journal-only: the Start is admitted.
				expect(admitted.admitted).toBe(true);
				if (admitted.admitted) admission = admitted.lease;
			});
			expect(await pollUntil(75_000)).toEqual([]);
			expect(admission).toBeDefined();
			// The launch failed and released. The skip restarted the outage hold
			// (seen again at 90 s) and charged no spacing.
			admission?.release();
			expect(await pollUntil(150_000)).toEqual([150_000]);
			expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
		});

		test("a stream that went live during the owner reads is not taken down", async () => {
			others = [eth()];
			health = dead();
			duringLeasedReads(() => {
				streaming = true;
			});
			expect(await pollUntil(600_000)).toEqual([]);
			expect(calls).toEqual([]);
		});

		test("a stream that ends during the owner reads skips this poll and restarts the hold", async () => {
			others = [eth()];
			health = dead();
			streaming = true;
			carrying = { wwan0: "not_carrying" };
			duringLeasedReads(() => {
				streaming = false;
			});
			expect(await pollUntil(75_000)).toEqual([]);
			expect(dials.get(KEY)).toBeUndefined();
			expect(await pollUntil(135_000)).toEqual([]);
			expect(await pollUntil(150_000)).toEqual([150_000]);
		});

		test("no stream or restoration is admitted while the link goes down; one is once it is down", async () => {
			others = [eth()];
			health = dead();
			streaming = true;
			carrying = { wwan0: "not_carrying" };
			const events: string[] = [];
			onDisconnect = async () => {
				// Engine loss: retirement clears the flag, restoration tries to start.
				streaming = false;
				const during = tryAcquireLifecycle("streaming");
				events.push(`admitted during down: ${during.admitted}`);
				events.push(`holder: ${currentLifecycleHolder()}`);
				events.push(`start waits: ${linkTeardownSettled() !== undefined}`);
			};
			const base = deps();
			setDeadBearerDepsForTest({
				...base,
				connect: async (uuid, timeout) => {
					const before = tryAcquireLifecycle("streaming");
					events.push(`admitted before up: ${before.admitted}`);
					if (before.admitted) before.lease.release();
					return (await base.connect?.(uuid, timeout)) ?? true;
				},
			});
			expect(await pollUntil(75_000)).toEqual([75_000]);
			expect(events).toEqual([
				"admitted during down: false",
				"holder: modem-transition",
				"start waits: true",
				"admitted before up: true",
			]);
		});

		test("a down that throws still releases the interlock", async () => {
			others = [eth()];
			health = dead();
			onDisconnect = async () => {
				throw new Error("nmcli failed");
			};
			await pollUntil(75_000);
			expect(currentLifecycleHolder()).toBeUndefined();
			expect(linkTeardownSettled()).toBeUndefined();
		});

		test("a link teardown is skipped while another transition holds the interlock", async () => {
			others = [eth()];
			health = dead();
			let transition: LifecycleLease | undefined;
			duringLeasedReads(() => {
				const held = tryAcquireLifecycle("modem-transition");
				if (held.admitted) transition = held.lease;
			});
			expect(await pollUntil(75_000)).toEqual([]);
			transition?.release();
			// Another modem's change is not stream activity: no hold restart, so
			// the next poll reconnects.
			expect(await pollUntil(90_000)).toEqual([90_000]);
		});

		test("a bookkeeping failure after the hold still releases it", async () => {
			others = [eth()];
			health = dead();
			setDeadBearerDepsForTest({
				...deps(),
				noteDial: () => {
					throw new Error("dial clock unavailable");
				},
			});
			await pollUntil(75_000);
			expect(calls).toEqual([]);
			expect(currentLifecycleHolder()).toBeUndefined();
			expect(linkTeardownSettled()).toBeUndefined();
		});

		test("a stream admitted and ended during the owner reads still skips", async () => {
			others = [eth()];
			health = dead();
			duringLeasedReads(() => {
				const admitted = tryAcquireLifecycle("streaming");
				if (admitted.admitted) admitted.lease.release();
			});
			expect(await pollUntil(75_000)).toEqual([]);
			expect(calls).toEqual([]);
		});
	});

	/*
	  The hold ends only when NetworkManager shows the device has let go of the
	  connection, at most LINK_TEARDOWN_MAX_HOLD_MS. A link whose deactivation has
	  not settled stays out of the bond until a later poll reads it settled, and
	  the profile is brought back only onto a free device.
	*/
	describe("the teardown settles before a stream may use the link set", () => {
		test("the interlock is held until the device reads disconnected", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "110", connection: UUID };
			const seen: string[] = [];
			setDeadBearerDepsForTest({
				...deps(),
				sleep: async (ms) => {
					seen.push(
						`${currentLifecycleHolder()} pending ${isLinkTeardownPending("wwan0")}`,
					);
					now += ms;
					if (sleeps++ === 2) device = { state: "30", connection: undefined };
				},
			});
			expect(await pollUntil(75_000)).toHaveLength(1);
			expect(seen).toEqual([
				"modem-transition pending true",
				"modem-transition pending true",
				"modem-transition pending true",
			]);
			expect(calls).toEqual([`down ${UUID}`, `up ${UUID} 45`]);
			expect(currentLifecycleHolder()).toBeUndefined();
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("a down that never settles releases at the bound and keeps the link out of the bond until a poll reads it settled", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "110", connection: UUID };
			const start = 75_000;
			expect(await pollUntil(75_000)).toHaveLength(1);
			expect(now - start).toBeGreaterThanOrEqual(LINK_TEARDOWN_MAX_HOLD_MS);
			expect(currentLifecycleHolder()).toBeUndefined();
			expect(linkTeardownSettled()).toBeUndefined();
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			// No `up` onto a device still deactivating.
			expect(calls).toEqual([`down ${UUID}`]);
			// Still deactivating at the next poll: still excluded.
			await pollUntil(now + 15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			device = { state: "30", connection: undefined };
			await pollUntil(now + 15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("an nmcli down that times out (exit 3) with deactivation pending: restoration waits out the hold, then bonds without the link, and no up follows", async () => {
			others = [eth()];
			health = dead();
			streaming = true;
			carrying = { wwan0: "not_carrying" };
			// nmcli gives up and nmDisconnect answers false; NM is still deactivating.
			afterDown = { state: "110", connection: UUID };
			const events: string[] = [];
			setDeadBearerDepsForTest({
				...deps(),
				disconnect: async (uuid) => {
					calls.push(`down ${uuid}`);
					device = afterDown;
					// Engine loss: retirement clears the flag, restoration tries to start.
					streaming = false;
					const during = tryAcquireLifecycle("streaming");
					events.push(
						`restoration admitted during the hold: ${during.admitted}`,
					);
					return false;
				},
			});
			await pollUntil(75_000);
			const after = tryAcquireLifecycle("streaming");
			events.push(`restoration admitted after the bound: ${after.admitted}`);
			if (after.admitted) after.lease.release();
			expect(events).toEqual([
				"restoration admitted during the hold: false",
				"restoration admitted after the bound: true",
			]);
			// The bond leaves the still-deactivating link out, and nothing dials it.
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			expect(calls).toEqual([`down ${UUID}`]);
		});

		test("a down whose nmcli child hangs still releases the hold at the bound", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "110", connection: UUID };
			setDeadBearerDepsForTest({
				...deps(),
				disconnect: (uuid) => {
					calls.push(`down ${uuid}`);
					device = afterDown;
					return new Promise(() => {});
				},
			});
			await pollUntil(75_000);
			expect(now - 75_000).toBeGreaterThanOrEqual(LINK_TEARDOWN_MAX_HOLD_MS);
			expect(currentLifecycleHolder()).toBeUndefined();
			expect(linkTeardownSettled()).toBeUndefined();
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			expect(calls).toEqual([`down ${UUID}`]);
		});

		test("an overlapping status poll during the down neither lifts the mark nor lets it lapse (exit 3, then deactivating)", async () => {
			others = [eth()];
			health = dead();
			// nmcli gives up at once while NM still reads the connection activated.
			afterDown = { state: "100", connection: UUID };
			let overlapped = false;
			setDeadBearerDepsForTest({
				...deps(),
				sleep: async (ms) => {
					now += ms;
					if (!overlapped) {
						overlapped = true;
						// The next 30 s poll is not awaited by the previous one.
						await runDeadBearerRecovery();
						expect(isLinkTeardownPending("wwan0")).toBe(true);
						device = { state: "110", connection: UUID };
					}
				},
			});
			await pollUntil(75_000);
			expect(currentLifecycleHolder()).toBeUndefined();
			expect(device?.state).toBe("110");
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			expect(calls).toEqual([`down ${UUID}`]);
		});

		test("an unsettled teardown re-marks its link even if the mark was lifted meanwhile", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "110", connection: UUID };
			let lifted = false;
			setDeadBearerDepsForTest({
				...deps(),
				sleep: async (ms) => {
					now += ms;
					if (!lifted) {
						lifted = true;
						setLinkTeardownPending(["wwan0"], false);
					}
				},
			});
			await pollUntil(75_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
		});

		test("a mark no profiled modem owns is lifted", async () => {
			setLinkTeardownPending(["wwan0", "wwan5"], true);
			// wwan0 re-enumerated without a profile; wwan5 belongs to no modem.
			setModem(2, { ...modem(), config: undefined });
			await pollUntil(15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
			expect(isLinkTeardownPending("wwan5")).toBe(false);
		});

		test("a mark whose profile no device carries any more is lifted", async () => {
			setLinkTeardownPending(["wwan0"], true);
			setDeadBearerDepsForTest({ ...deps(), resolveDevice: async () => null });
			await pollUntil(15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("a poll whose device lookup fails keeps the mark, and a link still deactivating is re-marked on every poll", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "110", connection: UUID };
			await pollUntil(75_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			// `nmcli device status` fails for one poll.
			lookupFails = true;
			await pollUntil(now + 15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			// Lifted by anything else meanwhile: the next poll that reads 110
			// marks it again.
			lookupFails = false;
			setLinkTeardownPending(["wwan0"], false);
			await pollUntil(now + 15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			device = { state: "30", connection: undefined };
			await pollUntil(now + 15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("a device that frees up just after the bound still gets no up", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "110", connection: UUID };
			let lastBoundRead = false;
			setDeadBearerDepsForTest({
				...deps(),
				deviceState: async () => {
					if (now - 75_000 < LINK_TEARDOWN_MAX_HOLD_MS) return device;
					if (!lastBoundRead) {
						lastBoundRead = true;
						return device;
					}
					return { state: "30", connection: undefined };
				},
			});
			await pollUntil(75_000);
			expect(calls).toEqual([`down ${UUID}`]);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
		});

		test("an unreadable device keeps the link excluded", async () => {
			others = [eth()];
			health = dead();
			afterDown = undefined;
			await pollUntil(75_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			await pollUntil(now + 15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
		});

		test("after a restart, a link NetworkManager still shows deactivating is excluded until it settles", async () => {
			device = { state: "110", connection: UUID };
			await seedPendingTeardowns();
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			await pollUntil(15_000);
			expect(isLinkTeardownPending("wwan0")).toBe(true);
			device = { state: "30", connection: undefined };
			await pollUntil(30_000);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("the startup scan leaves a settled link alone", async () => {
			await seedPendingTeardowns();
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("no up when another profile took the device after the down", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "100", connection: "other-profile" };
			expect(await pollUntil(75_000)).toHaveLength(1);
			expect(calls).toEqual([`down ${UUID}`]);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
		});

		test("no up when the device is not yet free", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "20", connection: undefined };
			expect(await pollUntil(75_000)).toHaveLength(1);
			expect(calls).toEqual([`down ${UUID}`]);
		});

		test("a down that left the connection up is not followed by an up", async () => {
			others = [eth()];
			health = dead();
			afterDown = { state: "100", connection: UUID };
			expect(await pollUntil(75_000)).toHaveLength(1);
			expect(calls).toEqual([`down ${UUID}`]);
			expect(isLinkTeardownPending("wwan0")).toBe(false);
			expect(currentLifecycleHolder()).toBeUndefined();
		});
	});

	describe("stream activity restarts the outage hold, a bounded number of times", () => {
		test("a stream that came and went between two polls restarts the hold", async () => {
			others = [eth()];
			health = dead();
			expect(await pollUntil(60_000)).toEqual([]);
			const admitted = tryAcquireLifecycle("streaming");
			if (admitted.admitted) admitted.lease.release();
			// Seen again at 75 s, so the 60 s hold ends at 135 s.
			expect(await pollUntil(150_000)).toEqual([135_000]);
		});

		test("the restart count starts again with each outage", async () => {
			others = [eth()];
			health = dead();
			const flap = () => {
				const admitted = tryAcquireLifecycle("streaming");
				if (admitted.admitted) admitted.lease.release();
			};
			duringLeasedReads(flap, DEAD_BEARER_MAX_HOLD_RESTARTS + 1);
			// Three flaps (75, 150, 225 s) use up this outage's restarts.
			expect(await pollUntil(240_000)).toEqual([]);
			// The bearer drops for a poll: no outage, the count resets.
			nmState = "20";
			expect(await pollUntil(255_000)).toEqual([]);
			nmState = "100";
			// New outage from 270 s; the fourth flap at 330 s restarts it again,
			// so the reconnect waits for the hold from 345 s.
			expect(await pollUntil(420_000)).toEqual([405_000]);
		});

		test("a stream flapping at every eligible poll defers recovery at most the cap", async () => {
			others = [eth()];
			health = dead();
			const flap = () => {
				const admitted = tryAcquireLifecycle("streaming");
				if (admitted.admitted) admitted.lease.release();
			};
			duringLeasedReads(flap, DEAD_BEARER_MAX_HOLD_RESTARTS + 1);
			// Skips at 75, 150 and 225 s restart the hold; the skip at 300 s does
			// not, so the next quiet poll reconnects.
			expect(await pollUntil(330_000)).toEqual([315_000]);
		});

		test("a stream that goes live with unknown traffic during the owner reads counts against the cap", async () => {
			others = [eth()];
			health = dead();
			duringLeasedReads(() => {
				const admitted = tryAcquireLifecycle("streaming");
				if (admitted.admitted) {
					// Live, and the sender has no verdict on this link yet.
					streaming = true;
					admitted.lease.release();
				}
			}, DEAD_BEARER_MAX_HOLD_RESTARTS + 1);
			const at: number[] = [];
			while (now < 330_000) {
				at.push(...(await pollUntil(now + 15_000)));
				// The stream stopped again before the next poll.
				streaming = false;
			}
			// The same cap as a stream that came and went: no `down` while it
			// was live, and the outage's age is kept, not cleared.
			expect(at).toEqual([315_000]);
		});
	});

	test("an outage that ends during the owner reads is forgotten even when the device lookup fails", async () => {
		others = [eth()];
		health = dead();
		duringLeasedReads(() => {
			health = record({ state: "up" }, wall);
			// `nmcli device status` fails for this poll.
			lookupFails = true;
		});
		expect(await pollUntil(75_000)).toEqual([]);
		lookupFails = false;
		health = dead();
		// Down again from 90 s: a new outage with its own 60 s hold.
		expect(await pollUntil(165_000)).toEqual([150_000]);
	});

	test("between streams the link's traffic is not consulted", async () => {
		others = [eth()];
		health = dead();
		carrying = { wwan0: "carrying" };
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

	test("a translated modem with no record for its translator yet is left alone", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		others = [eth(), record({ iface: "clat9", kind: "other", state: "down" })];
		health = dead();
		// clat7 is the translation, but only an unrelated TUN has a record.
		expect(await pollUntil(600_000)).toEqual([]);
	});

	test("a stream the translator carries vetoes the reconnect", async () => {
		others = [eth()];
		clatParents = { clat7: "wwan0" };
		tunHealth = tunDead();
		health = dead();
		streaming = true;
		// linkCarryingState folds the translator's rows into its modem.
		carrying = { wwan0: "carrying" };
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

	for (const change of [
		"carrying",
		"unknown",
		"new slot at the same name",
		"healthy path",
	] as const) {
		test(`a final owner read cannot send down after the path becomes ${change}`, async () => {
			health = dead();
			streaming = true;
			carrying = { wwan0: "not_carrying" };
			let key = KEY;
			let reads = 0;
			setDeadBearerDepsForTest({
				...deps(),
				stableKey: () => key,
				mmState: async () => {
					// The second read in the due poll holds the real background key.
					if (now === DEAD_BEARER_ALONE_HOLD_MS && ++reads === 2) {
						if (change === "new slot at the same name") key = `${KEY}.2`;
						else if (change === "healthy path")
							health = record({ state: "up" }, wall);
						else carrying = { wwan0: change };
					}
					return "connected";
				},
			});
			await runDeadBearerRecovery();
			now = DEAD_BEARER_ALONE_HOLD_MS;
			wall += now;
			health = dead();
			await runDeadBearerRecovery();
			expect(reads).toBe(2);
			expect(calls).toEqual([]);
			expect(dials.size).toBe(0);
		});
	}

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
