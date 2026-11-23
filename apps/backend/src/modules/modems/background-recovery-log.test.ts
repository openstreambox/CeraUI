import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	formatProdEntry,
	REDACTED,
	redact,
	type StructuredLogInfo,
} from "../../helpers/logger.ts";
import type { UplinkHealthRecord } from "../network/uplink-health/model.ts";
import {
	LIFECYCLE_HOLDERS,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../streaming/lifecycle-admission.ts";
import type { LinkCarryingState } from "../streaming/link-progress.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import { renderSourceMessage } from "../system/support-log-filter.ts";
import { RECOVERY_LIFECYCLE_HOLDERS } from "./background-recovery-codes.ts";
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
// left the box "streaming" with no sender, neither the data-session reconnect
// nor the redial acted, and nothing said why.

type Line = { level: string; message: string; meta?: Record<string, unknown> };
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
	test("the same cause logs once; a new one, and the release, log again", () => {
		noteBackgroundLeaseRefused("ready_redial", "k", "streaming_active");
		noteBackgroundLeaseRefused("ready_redial", "k", "streaming_active");
		noteBackgroundLeaseRefused("ready_redial", "k", "recovery_pending");
		noteBackgroundRecoveryClear("ready_redial", "k");
		noteBackgroundRecoveryClear("ready_redial", "k");
		expect(
			lines.map((l) => [l.level, l.message, l.meta?.refusal ?? null]),
		).toEqual([
			["warn", "modem recovery held back: lease refused", "streaming_active"],
			["warn", "modem recovery held back: lease refused", "recovery_pending"],
			["info", "modem recovery no longer held back", null],
		]);
	});

	test("modems and recovery kinds are tracked apart", () => {
		noteDeadPathHeld("a", "stream traffic on this link unknown");
		noteDeadPathHeld("b", "stream traffic on this link unknown");
		noteBackgroundLeaseRefused("ready_redial", "a", "streaming_active");
		expect(lines).toHaveLength(3);
	});

	test("a refusal names who holds the lifecycle; a new holder with the same code is a new cause", () => {
		noteBackgroundLeaseRefused(
			"data_session_reconnect",
			"k",
			"streaming_active",
		);
		const held = tryAcquireLifecycle("streaming");
		if (!held.admitted) throw new Error("admission refused");
		noteBackgroundLeaseRefused(
			"data_session_reconnect",
			"k",
			"streaming_active",
		);
		expect(lines.map((l) => l.meta?.lifecycleHolder)).toEqual([
			"none",
			"streaming",
		]);
		expect(lines[1]?.meta).toMatchObject({
			recovery: "data_session_reconnect",
			stableKey: "k",
			refusal: "streaming_active",
			recoveryPending: false,
		});
		held.lease.release();
	});

	test("the holder codes the support filter allows are the lifecycle's own", () => {
		expect([...RECOVERY_LIFECYCLE_HOLDERS].sort()).toEqual(
			[...LIFECYCLE_HOLDERS, "none"].sort(),
		);
	});
});

describe("through the production logger and the support export", () => {
	function exported(line: Line): Record<string, unknown> {
		const info = redact().transform({
			level: line.level,
			message: line.message,
			...line.meta,
		} as StructuredLogInfo) as StructuredLogInfo;
		const json = formatProdEntry(info);
		expect(json).not.toContain(REDACTED);
		return JSON.parse(renderSourceMessage("ceralive", json));
	}

	test("a lease refusal keeps its text and every bounded field", () => {
		const held = tryAcquireLifecycle("streaming");
		if (!held.admitted) throw new Error("admission refused");
		noteBackgroundLeaseRefused("first_activation", "k", "streaming_active");
		held.lease.release();
		const out = exported(lines[0] as Line);
		expect(out.msg).toBe("modem recovery held back: lease refused");
		expect(out.meta).toEqual({
			recovery: "first_activation",
			refusal: "streaming_active",
			lifecycleHolder: "streaming",
			recoveryPending: false,
		});
	});

	test("a dead path keeps its text and its reason code", () => {
		noteDeadPathHeld("k", "stream traffic on this link unknown");
		noteDeadPathHeld("j", "bearer not connected");
		const unknown = exported(lines[0] as Line);
		expect(unknown.msg).toBe("modem recovery held back: dead path left alone");
		expect(unknown.meta).toEqual({
			recovery: "data_session_reconnect",
			deadPath: "stream_traffic_unknown",
		});
		expect(exported(lines[1] as Line).meta).toEqual({
			recovery: "data_session_reconnect",
			deadPath: "session_not_connected",
		});
	});

	test("the release keeps its text and kind", () => {
		noteBackgroundLeaseRefused("ready_redial", "k", "mutation_in_progress");
		noteBackgroundRecoveryClear("ready_redial", "k");
		const out = exported(lines[1] as Line);
		expect(out.msg).toBe("modem recovery no longer held back");
		expect(out.meta).toEqual({ recovery: "ready_redial" });
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

type AloneState = {
	streaming: boolean;
	carrying: LinkCarryingState;
	refuse?: "streaming_active";
	attached: boolean;
};

function aloneModem(state: AloneState) {
	let now = 0;
	const wall = 1_800_000_000_000;
	const calls: string[] = [];
	setModem(2, modem());
	setDeadBearerDepsForTest({
		now: () => now,
		wallNow: () => wall,
		ids: () => (state.attached ? getModemIds() : []),
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
		poll: async (times = 1) => {
			for (let i = 0; i < times; i++) {
				now += 15_000;
				await runDeadBearerRecovery();
			}
		},
	};
}

const held = (l: Line) => l.message.startsWith("modem recovery held back");

describe("the data-session reconnect says why it leaves a dead path alone", () => {
	test("a stuck 'streaming' state with no sender rows: held back, said once", async () => {
		const m = aloneModem({
			streaming: true,
			carrying: "unknown",
			attached: true,
		});
		await m.poll(10);
		expect(m.calls).toEqual([]);
		expect(lines.map((l) => [l.message, l.meta?.deadPath])).toEqual([
			[
				"modem recovery held back: dead path left alone",
				"stream_traffic_unknown",
			],
		]);
	});

	test("once the stream is idle the reconnect may act; a refused lease is said, then the release", async () => {
		const state: AloneState = {
			streaming: true,
			carrying: "unknown",
			attached: true,
		};
		const m = aloneModem(state);
		await m.poll();
		state.streaming = false;
		state.refuse = "streaming_active";
		await m.poll(DEAD_BEARER_ALONE_HOLD_MS / 15_000 + 2);
		expect(m.calls).toEqual([]);
		delete state.refuse;
		await m.poll();
		expect(m.calls).toEqual(["down", "up"]);
		expect(
			lines.map((l) => [l.message, l.meta?.deadPath ?? l.meta?.refusal]),
		).toEqual([
			[
				"modem recovery held back: dead path left alone",
				"stream_traffic_unknown",
			],
			// The idle stream only waits out the alone hold: no longer held back.
			["modem recovery no longer held back", undefined],
			["modem recovery held back: lease refused", "streaming_active"],
			["modem recovery no longer held back", undefined],
		]);
	});

	test("veto, then the outage hold, then the same veto: said again", async () => {
		const state: AloneState = {
			streaming: true,
			carrying: "unknown",
			attached: true,
		};
		const m = aloneModem(state);
		await m.poll();
		state.streaming = false; // waits out the hold
		await m.poll();
		state.streaming = true; // the same veto returns
		await m.poll();
		expect(lines.filter(held)).toHaveLength(2);
	});

	test("a modem that leaves the roster is forgotten; its return is said afresh", async () => {
		const state: AloneState = {
			streaming: true,
			carrying: "unknown",
			attached: true,
		};
		const m = aloneModem(state);
		await m.poll();
		state.attached = false;
		await m.poll();
		state.attached = true;
		await m.poll();
		expect(lines.filter(held)).toHaveLength(2);
		// Forgetting is silent: no release line for a detached modem.
		expect(lines.filter((l) => !held(l))).toEqual([]);
	});
});
