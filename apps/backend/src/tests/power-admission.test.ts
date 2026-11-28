import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { getSpawnSite } from "../helpers/spawn-policy.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { setup } from "../modules/setup.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { carryingTracker } from "../modules/system/carrying.ts";
import {
	isDisruptiveActionPending,
	isPositiveDisruptiveFailure,
	type PowerSubmissionError,
} from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	brokerOutcome,
	logindOutcome,
	logindPowerArgv,
	POWER_BROKER_SOCKET,
	powerAdmissionArgv,
	publishPowerAdmissionStatus,
	readPowerAdmissionState,
	reconcileBrokerRequest,
	resetPowerAdmissionStatusForTest,
} from "../modules/system/power-admission.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";
import {
	poweroffProcedure,
	rebootProcedure,
	resetPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";

describe("the image's power broker", () => {
	test("counts as installed from its files, even when its socket is down", () => {
		const only = (path: string) => (p: string) => p === path;
		// Installed but the socket isn't there: still the broker (fails closed).
		expect(
			powerAdmissionArgv("poweroff", only("/usr/bin/ceralive-poweroff")),
		).toEqual(["/usr/bin/ceralive-poweroff", "--no-wait"]);
		expect(
			powerAdmissionArgv(
				"reboot",
				only("/usr/libexec/ceralive/ceralive-power-broker"),
			),
		).toEqual(["/usr/bin/ceralive-reboot", "--no-wait"]);
		// The socket alone doesn't make an image a broker image.
		expect(
			powerAdmissionArgv("poweroff", only(POWER_BROKER_SOCKET)),
		).toBeUndefined();
	});

	test("older images ask logind directly, never systemctl", () => {
		expect(logindPowerArgv("reboot")).toEqual([
			"busctl",
			"--system",
			"--timeout=25",
			"call",
			"org.freedesktop.login1",
			"/org/freedesktop/login1",
			"org.freedesktop.login1.Manager",
			"RebootWithFlags",
			"t",
			"0",
		]);
	});

	test("the client's answer: admitted with an id, definite refusal, or uncertain", () => {
		expect(
			brokerOutcome("reboot", 0, "ADMITTED reboot 0a1b2c3d4e5f\n", ""),
		).toEqual({ brokerRequestId: "0a1b2c3d4e5f" });
		expect(
			brokerOutcome("reboot", 0, "PENDING reboot 0a1b2c3d4e5f\n", ""),
		).toEqual({ brokerRequestId: "0a1b2c3d4e5f" });
		const thrown = (exitCode: number | null) => {
			try {
				brokerOutcome("poweroff", exitCode, "X\n", "");
			} catch (error) {
				return error as PowerSubmissionError;
			}
			throw new Error("no failure");
		};
		expect(thrown(1).exitCode).toBe(1); // refused: nothing submitted
		expect(thrown(75).exitCode).toBe(75); // broker unreachable: nothing submitted
		expect(thrown(70).exitCode).toBeNull(); // no answer: uncertain
		expect(thrown(null).exitCode).toBeNull();
		expect(isPositiveDisruptiveFailure(thrown(1))).toBe(true);
		expect(isPositiveDisruptiveFailure(thrown(70))).toBe(false);
	});

	test("logind's lost or timed-out answer is uncertain", () => {
		const exitOf = (code: number | null, stderr: string) => {
			try {
				logindOutcome("poweroff", code, stderr, "refused");
				return "ok";
			} catch (error) {
				return (error as PowerSubmissionError).exitCode;
			}
		};
		expect(exitOf(0, "")).toBe("ok");
		expect(
			exitOf(1, "Call failed: Access denied due to active block inhibitor"),
		).toBe(1);
		expect(exitOf(1, "Call failed: Connection timed out")).toBeNull();
		expect(exitOf(null, "")).toBeNull();
	});

	test("broker states map to what the UI says, and an old refusal fades", () => {
		const at =
			(state: string, time = 1000) =>
			() =>
				JSON.stringify({ state, time });
		expect(readPowerAdmissionState(at("idle"), 1000)).toBeUndefined();
		expect(readPowerAdmissionState(at("admitted"), 1000)).toBe("waiting");
		expect(readPowerAdmissionState(at("waiting"), 1000)).toBe("waiting");
		expect(readPowerAdmissionState(at("submitting"), 1000)).toBe("waiting");
		expect(readPowerAdmissionState(at("stuck"), 1000)).toBe("stuck");
		expect(readPowerAdmissionState(at("submitted"), 1000)).toBe("submitted");
		expect(readPowerAdmissionState(at("uncertain"), 1000)).toBe("uncertain");
		expect(readPowerAdmissionState(at("failed"), 1000)).toBe("failed");
		expect(readPowerAdmissionState(at("failed", 0), 1000)).toBeUndefined();
		expect(readPowerAdmissionState(() => "{", 1000)).toBeUndefined();
		expect(
			readPowerAdmissionState(() => {
				throw new Error("ENOENT");
			}, 1000),
		).toBeUndefined();
	});

	test("the notice changes once per state and goes away when idle", () => {
		resetPowerAdmissionStatusForTest();
		const shown = spyOn(notifications, "notificationBroadcast");
		const removed = spyOn(notifications, "notificationRemove");
		try {
			publishPowerAdmissionStatus(() => "waiting");
			publishPowerAdmissionStatus(() => "waiting");
			publishPowerAdmissionStatus(() => "stuck");
			publishPowerAdmissionStatus(() => "uncertain");
			publishPowerAdmissionStatus(() => undefined);
			expect(shown.mock.calls.map((c) => c[7])).toEqual([
				"notifications.powerWaitingForUpdate",
				"notifications.powerStuckOnUpdate",
				"notifications.powerUncertain",
			]);
			// Waiting and stuck can't be dismissed while the box still has to act.
			expect(shown.mock.calls.map((c) => c[5])).toEqual([false, false, true]);
			expect(removed).toHaveBeenCalledWith("power-admission");
		} finally {
			shown.mockRestore();
			removed.mockRestore();
			resetPowerAdmissionStatusForTest();
		}
	});
});

describe("local power actions through the RPC", () => {
	const saved = {
		NODE_ENV: process.env.NODE_ENV,
		MOCK_MODE: process.env.MOCK_MODE,
		CERALIVE_STREAMING_MARKER: process.env.CERALIVE_STREAMING_MARKER,
	};
	let dir = "";
	beforeEach(() => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		dir = mkdtempSync(join(tmpdir(), "power-admission-"));
		process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
		setStreamReconciliationCompletedForTest(true);
		resetOrchestratorRuntimeForTest();
		updateStatus(false);
		updateStreamLifecycleState("idle");
		resetPowerCommandRunner();
	});
	afterEach(() => {
		resetPowerCommandRunner();
		resetOrchestratorRuntimeForTest();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function spawnRecorder(exitCode: number, stdout = "") {
		const seen: unknown[] = [];
		const safe = Bun.spawnSync(["true"]);
		const spawn = spyOn(Bun, "spawnSync").mockImplementation((argv) => {
			seen.push(argv);
			return {
				...safe,
				exitCode,
				success: exitCode === 0,
				stdout: Buffer.from(stdout),
				stderr: Buffer.from(""),
			} as unknown as ReturnType<typeof Bun.spawnSync>;
		});
		return { seen, spawn };
	}

	test("with the broker installed, the admitted action goes to it, not systemctl", async () => {
		const exists = spyOn(fs, "existsSync").mockReturnValue(true);
		const { seen, spawn } = spawnRecorder(0, "ADMITTED reboot 0a1b2c3d4e5f\n");
		try {
			const result = await call(rebootProcedure, undefined, {
				context: buildControlContext(),
			});
			expect(result.success).toBe(true);
			expect(seen).toEqual([["/usr/bin/ceralive-reboot", "--no-wait"]]);
		} finally {
			spawn.mockRestore();
			exists.mockRestore();
		}
	});

	test("a broker refusal is a failed submission", async () => {
		const exists = spyOn(fs, "existsSync").mockReturnValue(true);
		const { spawn } = spawnRecorder(1, "REFUSED unverifiable caller\n");
		try {
			const result = await call(poweroffProcedure, undefined, {
				context: buildControlContext(),
			});
			expect(result.success).toBe(false);
			expect(result.failureReason).toBe("shutdown_unavailable");
		} finally {
			spawn.mockRestore();
			exists.mockRestore();
		}
	});

	test("without the broker, logind is asked directly (no systemctl fallback)", async () => {
		const exists = spyOn(fs, "existsSync").mockReturnValue(false);
		const { seen, spawn } = spawnRecorder(0);
		try {
			await call(poweroffProcedure, undefined, {
				context: buildControlContext(),
			});
			expect(seen).toEqual([logindPowerArgv("poweroff")]);
		} finally {
			spawn.mockRestore();
			exists.mockRestore();
		}
	});
});

test("the spawn registry names the commands the power runner spawns, and no systemctl", () => {
	const command = getSpawnSite("system.power")?.command ?? "";
	const broker = powerAdmissionArgv("poweroff", () => true) ?? [];
	for (const word of [
		broker[0],
		broker[1],
		...logindPowerArgv("reboot").slice(0, 2),
	])
		expect(command).toContain(String(word));
	expect(command).not.toContain("systemctl");
});

describe("the reservation follows the broker's answer for this request", () => {
	const saved = {
		NODE_ENV: process.env.NODE_ENV,
		MOCK_MODE: process.env.MOCK_MODE,
		CERALIVE_STREAMING_MARKER: process.env.CERALIVE_STREAMING_MARKER,
		CERALIVE_POWER_STATE: process.env.CERALIVE_POWER_STATE,
	};
	let dir = "";
	beforeEach(() => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		dir = mkdtempSync(join(tmpdir(), "power-reservation-"));
		process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
		setStreamReconciliationCompletedForTest(true);
		resetOrchestratorRuntimeForTest();
		updateStatus(false);
		updateStreamLifecycleState("idle");
		resetPowerCommandRunner();
		resetPowerAdmissionStatusForTest();
	});
	afterEach(() => {
		resetPowerCommandRunner();
		resetOrchestratorRuntimeForTest();
		resetPowerAdmissionStatusForTest();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	async function powerOffVia(exitCode: number, stdout: string) {
		const exists = spyOn(fs, "existsSync").mockReturnValue(true);
		const safe = Bun.spawnSync(["true"]);
		const spawn = spyOn(Bun, "spawnSync").mockImplementation(
			() =>
				({
					...safe,
					exitCode,
					success: exitCode === 0,
					stdout: Buffer.from(stdout),
					stderr: Buffer.from(""),
				}) as unknown as ReturnType<typeof Bun.spawnSync>,
		);
		try {
			return await call(poweroffProcedure, undefined, {
				context: buildControlContext(),
			});
		} finally {
			spawn.mockRestore();
			exists.mockRestore();
		}
	}

	test("admitted, then a later failure of that request releases the reservation", async () => {
		expect(
			(await powerOffVia(0, "ADMITTED poweroff 0a1b2c3d4e5f\n")).success,
		).toBe(true);
		expect(isDisruptiveActionPending()).toBe(true);
		reconcileBrokerRequest(() => ({ state: "waiting", id: "0a1b2c3d4e5f" }));
		reconcileBrokerRequest(() => ({ state: "failed", id: "ffffffffffff" }));
		expect(isDisruptiveActionPending()).toBe(true);
		reconcileBrokerRequest(() => ({ state: "failed", id: "0a1b2c3d4e5f" }));
		expect(isDisruptiveActionPending()).toBe(false);
	});

	// The broker's one record: the latest request at the top level, every
	// request of this boot under "requests" by id.
	const brokerRecord = (
		latest: { id: string; state: string },
		requests: Record<string, string>,
	) =>
		JSON.stringify({
			...latest,
			time: Date.now() / 1000,
			requests: Object.fromEntries(
				Object.entries(requests).map(([id, state]) => [
					id,
					{ id, state, time: Date.now() / 1000 },
				]),
			),
		});

	test("a newer request at the top of state.json can't hide this request's failure", async () => {
		process.env.CERALIVE_POWER_STATE = join(dir, "state.json");
		expect(
			(await powerOffVia(0, "ADMITTED poweroff 0a1b2c3d4e5f\n")).success,
		).toBe(true);
		// The broker refused this request, then admitted a newer one (the button).
		writeFileSync(
			join(dir, "state.json"),
			brokerRecord(
				{ id: "ffffffffffff", state: "waiting" },
				{ "0a1b2c3d4e5f": "failed", ffffffffffff: "waiting" },
			),
		);
		reconcileBrokerRequest();
		expect(isDisruptiveActionPending()).toBe(false);
	});

	test("a delayed heartbeat still finds the failure after many newer requests", async () => {
		process.env.CERALIVE_POWER_STATE = join(dir, "state.json");
		expect(
			(await powerOffVia(0, "ADMITTED poweroff 0a1b2c3d4e5f\n")).success,
		).toBe(true);
		const newer = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [
				i.toString(16).padStart(12, "0"),
				"failed",
			]),
		);
		writeFileSync(
			join(dir, "state.json"),
			brokerRecord(
				{ id: "000000000027", state: "failed" },
				{ ...newer, "0a1b2c3d4e5f": "failed" },
			),
		);
		reconcileBrokerRequest();
		expect(isDisruptiveActionPending()).toBe(false);
	});

	test("no record for this request keeps the reservation (the broker keeps a failure for a day)", async () => {
		process.env.CERALIVE_POWER_STATE = join(dir, "state.json");
		expect(
			(await powerOffVia(0, "ADMITTED poweroff 0a1b2c3d4e5f\n")).success,
		).toBe(true);
		writeFileSync(
			join(dir, "state.json"),
			brokerRecord(
				{ id: "ffffffffffff", state: "failed" },
				{ ffffffffffff: "failed" },
			),
		);
		reconcileBrokerRequest();
		expect(isDisruptiveActionPending()).toBe(true);
	});

	test("an older broker's state.json (no requests) releases only a failure under this id", async () => {
		process.env.CERALIVE_POWER_STATE = join(dir, "state.json");
		const record = (id: string, state: string) =>
			JSON.stringify({ state, id, time: Date.now() / 1000 });
		expect(
			(await powerOffVia(0, "ADMITTED poweroff 0a1b2c3d4e5f\n")).success,
		).toBe(true);
		writeFileSync(join(dir, "state.json"), record("ffffffffffff", "failed"));
		reconcileBrokerRequest();
		expect(isDisruptiveActionPending()).toBe(true);
		writeFileSync(join(dir, "state.json"), record("0a1b2c3d4e5f", "failed"));
		reconcileBrokerRequest();
		expect(isDisruptiveActionPending()).toBe(false);
	});

	test("an id that isn't the broker's shape is never used as a path", async () => {
		process.env.CERALIVE_POWER_STATE = join(dir, "state.json");
		fs.mkdirSync(join(dir, "requests"));
		writeFileSync(
			join(dir, "escape.json"),
			JSON.stringify({ state: "failed", id: "../escape" }),
		);
		expect(
			(await powerOffVia(0, "ADMITTED poweroff ../escape\n")).success,
		).toBe(true);
		reconcileBrokerRequest();
		expect(isDisruptiveActionPending()).toBe(true);
	});

	test("no answer keeps the reservation; a definite refusal releases it", async () => {
		expect((await powerOffVia(70, "NOANSWER\n")).success).toBe(false);
		expect(isDisruptiveActionPending()).toBe(true);
		resetOrchestratorRuntimeForTest();
		resetPowerCommandRunner();
		expect(
			(await powerOffVia(1, "REFUSED unverifiable caller\n")).success,
		).toBe(false);
		expect(isDisruptiveActionPending()).toBe(false);
	});
});

describe("the phone-only power-off exception waives only the restart hold", () => {
	const savedEngine = setup.engine;
	let dir = "";
	const savedMarker = process.env.CERALIVE_STREAMING_MARKER;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phone-exception-"));
		process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
		setup.engine = "none";
		setStreamReconciliationCompletedForTest(true);
		resetOrchestratorRuntimeForTest();
		updateStatus(false);
		updateStreamLifecycleState("idle");
		const now = performance.now();
		carryingTracker.start(now); // a backend restart within the boot
		carryingTracker.upload(now, { wlan0: 0 });
	});
	afterEach(() => {
		setup.engine = savedEngine;
		setStreamReconciliationCompletedForTest(true);
		if (savedMarker === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
		else process.env.CERALIVE_STREAMING_MARKER = savedMarker;
		rmSync(dir, { recursive: true, force: true });
	});

	test("only the restart hold: power-off is admitted", () => {
		expect(carryingTracker.startupChecking(performance.now())).toBe(true);
		expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
			allowed: true,
		});
	});

	test("reboot and other engines are not covered", () => {
		expect(getDisruptiveActionDecision({ powerAction: "reboot" })).toEqual({
			allowed: false,
			reason: "stream_liveness_unknown",
		});
		setup.engine = "ceracoder";
		expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
			allowed: false,
			reason: "stream_liveness_unknown",
		});
	});

	test("encoder uncertainty is not waived", () => {
		setStreamReconciliationCompletedForTest(false);
		expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
			allowed: false,
			reason: "stream_liveness_unknown",
		});
	});

	test("an unexplained streaming marker is not waived", () => {
		writeFileSync(process.env.CERALIVE_STREAMING_MARKER ?? "", "");
		expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
			allowed: false,
			reason: "stream_liveness_unknown",
		});
	});

	test("client traffic that is still qualifying is not waived", () => {
		const now = performance.now();
		carryingTracker.upload(now + 1_000, { wlan0: 500_000 }); // 4 Mbit/s
		expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
			allowed: false,
			reason: "stream_liveness_unknown",
		});
	});
});
