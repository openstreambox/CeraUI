import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { setup } from "../modules/setup.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { carryingTracker } from "../modules/system/carrying.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	POWER_BROKER_SOCKET,
	powerAdmissionArgv,
	publishPowerAdmissionStatus,
	readPowerAdmissionState,
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
	test("is used only when both its socket and its client are installed", () => {
		const all = () => true;
		expect(powerAdmissionArgv("poweroff", all)).toEqual([
			"/usr/bin/ceralive-poweroff",
			"--no-wait",
		]);
		expect(powerAdmissionArgv("reboot", all)).toEqual([
			"/usr/bin/ceralive-reboot",
			"--no-wait",
		]);
		expect(
			powerAdmissionArgv("poweroff", (path) => path !== POWER_BROKER_SOCKET),
		).toBeUndefined();
		expect(
			powerAdmissionArgv("reboot", (path) => path === POWER_BROKER_SOCKET),
		).toBeUndefined();
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
		const { seen, spawn } = spawnRecorder(0, "ADMITTED reboot\n");
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

	test("without the broker, plain systemctl keeps today's behaviour", async () => {
		const exists = spyOn(fs, "existsSync").mockReturnValue(false);
		const { seen, spawn } = spawnRecorder(0);
		try {
			await call(poweroffProcedure, undefined, {
				context: buildControlContext(),
			});
			expect(seen).toEqual([["systemctl", "poweroff"]]);
		} finally {
			spawn.mockRestore();
			exists.mockRestore();
		}
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
