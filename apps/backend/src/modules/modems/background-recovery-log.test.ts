import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../streaming/lifecycle-admission.ts";
import type { LinkCarryingState } from "../streaming/link-progress.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	noteBackgroundLeaseRefused,
	noteBackgroundRecoveryClear,
	noteDeadPathHeld,
	setBackgroundRecoveryLoggerForTest,
} from "./background-recovery-log.ts";
import {
	DEAD_BEARER_ALONE_HOLD_MS,
	DEAD_BEARER_MIN_FAILURES,
	runDeadBearerRecovery,
	setDeadBearerDepsForTest,
} from "./dead-bearer-recovery.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "./modems-state.ts";

// A recovery that is held back used to leave no trace: after an encoder kill
// left the box "streaming" with no sender, neither the dead-bearer reconnect
// nor the redial acted, and nothing said why. Each modem and recovery kind now
// logs its reason when it changes, and once when the recovery may act again.

type Line = { level: string; message: string; meta?: unknown };
let lines: Line[];

beforeEach(() => {
	lines = [];
	setBackgroundRecoveryLoggerForTest({
		info: (message, meta) => lines.push({ level: "info", message, meta }),
		warn: (message, meta) => lines.push({ level: "warn", message, meta }),
	});
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

afterEach(() => {
	setBackgroundRecoveryLoggerForTest(undefined);
	setDeadBearerDepsForTest(null);
	resetLifecycleInterlock();
	for (const id of getModemIds()) removeModem(id);
});

describe("once per change", () => {
	test("the same reason logs once; a new one, and the release, log again", () => {
		noteBackgroundLeaseRefused("ready redial", "k", "streaming_active");
		noteBackgroundLeaseRefused("ready redial", "k", "streaming_active");
		noteBackgroundLeaseRefused("ready redial", "k", "recovery_pending");
		noteBackgroundRecoveryClear("ready redial", "k");
		noteBackgroundRecoveryClear("ready redial", "k");
		expect(lines.map((l) => [l.level, l.message])).toEqual([
			["warn", "modem ready redial held back: lease refused: streaming_active"],
			["warn", "modem ready redial held back: lease refused: recovery_pending"],
			["info", "modem ready redial no longer held back"],
		]);
	});

	test("modems and recovery kinds are tracked apart", () => {
		noteDeadPathHeld("a", "stream traffic on this link unknown");
		noteDeadPathHeld("b", "stream traffic on this link unknown");
		noteBackgroundLeaseRefused("ready redial", "a", "streaming_active");
		expect(lines).toHaveLength(3);
	});

	test("a refusal names who holds the lifecycle", () => {
		const held = tryAcquireLifecycle("streaming");
		if (!held.admitted) throw new Error("admission refused");
		noteBackgroundLeaseRefused(
			"dead-bearer reconnect",
			"k",
			"streaming_active",
		);
		expect(lines[0]?.meta).toMatchObject({
			stableKey: "k",
			refusal: "streaming_active",
			lifecycleHolder: "streaming",
			recoveryPending: false,
		});
		held.lease.release();
	});
});

const UUID = "9b0c1f3e-4f4f-4a51-9a51-3a0d1b7e2c11";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";

function down(iface: string, wall: number): UplinkHealthRecord {
	return {
		iface,
		kind: "cellular",
		state: "down",
		weight: 0,
		lastTransition: wall,
		staleAt: wall + 15_000,
		probes: { successes: 0, failures: DEAD_BEARER_MIN_FAILURES },
		signals: {},
		reason: "probe_failed",
	};
}

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

describe("the dead-bearer reconnect says why it leaves a dead path alone", () => {
	function aloneModem(state: {
		streaming: boolean;
		carrying: LinkCarryingState;
		refuse?: "streaming_active";
	}) {
		let now = 0;
		const wall = 1_800_000_000_000;
		const calls: string[] = [];
		setModem(2, modem());
		setDeadBearerDepsForTest({
			now: () => now,
			wallNow: () => wall,
			ids: () => getModemIds(),
			stableKey: (id) => (id === 2 ? KEY : undefined),
			health: (iface) => (iface === "wwan0" ? down("wwan0", wall) : undefined),
			healthList: () => [down("wwan0", wall)],
			clatParent: () => undefined,
			clatTun: () => undefined,
			streaming: () => state.streaming,
			carrying: () => state.carrying,
			readAutoconnect: async () => "no",
			automaticReady: async () => true,
			nmState: async () => "100",
			mmState: async () => "connected",
			lastDial: () => undefined,
			noteDial: () => {},
			disconnect: async () => {
				calls.push("down");
			},
			connect: async () => {
				calls.push("up");
				return true;
			},
			mutate: async (_key, run) =>
				state.refuse
					? { ok: false as const, refusal: state.refuse }
					: { ok: true as const, value: await run() },
		});
		return {
			calls,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	test("a stuck 'streaming' state with no sender rows: held back, said once", async () => {
		// The state an encoder kill left: is_streaming true, nothing carrying
		// is known for the link.
		const state = { streaming: true, carrying: "unknown" as LinkCarryingState };
		const m = aloneModem(state);
		for (let i = 0; i < 10; i++) {
			m.advance(15_000);
			await runDeadBearerRecovery();
		}
		expect(m.calls).toEqual([]);
		expect(lines.map((l) => l.message)).toEqual([
			"modem dead-bearer reconnect held back: stream traffic on this link unknown",
		]);
	});

	test("once the stream is idle the reconnect may act; a refused lease is said", async () => {
		const state: {
			streaming: boolean;
			carrying: LinkCarryingState;
			refuse?: "streaming_active";
		} = { streaming: true, carrying: "unknown" };
		const m = aloneModem(state);
		m.advance(15_000);
		await runDeadBearerRecovery();
		// The stream ends idle; the path stays dead past the alone hold.
		state.streaming = false;
		state.refuse = "streaming_active";
		for (let t = 0; t <= DEAD_BEARER_ALONE_HOLD_MS + 15_000; t += 15_000) {
			m.advance(15_000);
			await runDeadBearerRecovery();
		}
		expect(m.calls).toEqual([]);
		expect(lines.map((l) => l.message)).toEqual([
			"modem dead-bearer reconnect held back: stream traffic on this link unknown",
			"modem dead-bearer reconnect held back: lease refused: streaming_active",
		]);
		// The lease frees: the reconnect runs and says it is no longer held.
		delete state.refuse;
		m.advance(15_000);
		await runDeadBearerRecovery();
		expect(m.calls).toEqual(["down", "up"]);
		expect(lines.at(-1)?.message).toBe(
			"modem dead-bearer reconnect no longer held back",
		);
	});
});
