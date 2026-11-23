import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterlockBridge } from "../modules/modems/transition-engine.ts";
import { defaultUsbModeDispatchDeps } from "../modules/modems/usb-mode-transition.ts";
import type { ArmedStreamMarkerDeps } from "../modules/streaming/armed-stream-marker.ts";
import * as engineRuntimeState from "../modules/streaming/engine-runtime-state.ts";
import { setForwardActive } from "../modules/streaming/forward-activity.ts";
import {
	clearOtaStreamingMarker,
	otaStreamingMarkerPath,
} from "../modules/streaming/ota-streaming-marker.ts";
import { senderCensusProcRoot } from "../modules/streaming/sender-ownership.ts";
import {
	getStreamLifecycleState,
	seedStreamLifecycleState,
} from "../modules/streaming/stream-lifecycle-status.ts";
import { runStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import {
	createStreamSessionOrchestrator,
	type StreamSessionOrchestratorDeps,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import {
	getStreamingProcesses,
	type StreamingProcess,
	spawnForwardLoop,
	spawnStreamingLoop,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";
import {
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";

// Production paths with a private process table. Every child here is owned and
// retired through its own handle; nothing is signalled by name.
let procRoot = "";
let previousRoot: string | undefined;
let engine: "idle" | "streaming" | "unknown" = "idle";
const children: StreamingProcess[] = [];

beforeEach(() => {
	previousRoot = process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT;
	procRoot = mkdtempSync(join(tmpdir(), "sender-census-"));
	process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = procRoot;
	engine = "idle";
	spyOn(engineRuntimeState, "queryEngineRuntimeStreaming").mockImplementation(
		async () => engine,
	);
});

afterEach(async () => {
	for (const child of children.splice(0)) await stopProcessAndWait(child);
	mock.restore();
	setForwardActive(false);
	updateStatus(false);
	seedStreamLifecycleState("idle");
	notificationRemove("stream_recovery_failed");
	clearOtaStreamingMarker();
	process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = previousRoot;
	rmSync(procRoot, { recursive: true, force: true });
});

/** A process-table row that reads as a sender named `srtla_send`. */
function listSender(pid: number, parent = process.pid): void {
	mkdirSync(join(procRoot, String(pid)));
	writeFileSync(join(procRoot, `${pid}/comm`), "srtla_send\n");
	writeFileSync(
		join(procRoot, `${pid}/stat`),
		`${pid} (srtla_send) S ${parent} ${pid} ${pid} 0 -1 4194560 0 0 0 0\n`,
	);
}

/** Like the kernel, the private table drops a child's row once it is reaped. */
function tracked(child: StreamingProcess): StreamingProcess {
	children.push(child);
	listSender(child.proc.pid);
	const row = join(procRoot, String(child.proc.pid));
	void child.proc.exited.then(() =>
		rmSync(row, { recursive: true, force: true }),
	);
	return child;
}

function forwardChild(): StreamingProcess {
	return tracked(spawnForwardLoop("sleep", ["60"], () => {}));
}

function sessionChild(): StreamingProcess {
	return tracked(spawnStreamingLoop("sleep", ["60"], () => {}));
}

/** The real OTA marker owner, on the preload's private marker path. */
const marker = {
	get held() {
		return existsSync(otaStreamingMarkerPath());
	},
};

function productionSession(
	overrides: Partial<StreamSessionOrchestratorDeps> = {},
) {
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		createAttemptId: () => "sender-ownership",
		onStreamStopped: () => {},
		onStreamCommitted: () => {},
		onStreamArmed: () => {},
		ensureShutdownProtection: async () => true,
		claimLaunchMarker: () => true,
		admitUpdate: undefined,
		awaitRecovery: undefined,
		recoveryPending: undefined,
		blockingMutation: undefined,
		...overrides,
	});
	return { session, marker };
}

test("ordinary unit tests read a private, empty process table", () => {
	expect(senderCensusProcRoot()).toBe(procRoot);
	process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = previousRoot;
	expect(senderCensusProcRoot()).not.toBe("/proc");
	expect(senderCensusProcRoot().startsWith(tmpdir())).toBe(true);
});

test("an owned forwarding sender does not make an idle engine unconfirmed", async () => {
	forwardChild();
	setForwardActive(true);
	expect(streamSessionProductionDeps.canReconcileIdle?.()).toBe(true);
	expect(await streamSessionProductionDeps.queryRuntime()).toBe("idle");
	expect(streamSessionProductionDeps.senderAdmissionSafe?.()).toBe(true);
	// Confirmed cleanup of an idle engine succeeds while forwarding continues.
	await streamSessionProductionDeps.stopRuntime(0);

	const { session, marker } = productionSession();
	expect(await session.reconcile()).toBe("idle");
	expect(session.streamLiveness()).toBe("idle");
	let launches = 0;
	const start = await session.start({
		origin: "ui",
		launch: async () => {
			launches++;
		},
	});
	// The forwarding exclusion answers, exactly as before the census existed.
	expect(start).toMatchObject({
		result: "failed",
		failure: { class: "start_invalid", code: "streaming_active" },
	});
	expect(launches).toBe(0);
	expect(session.snapshot().state).toBe("idle");
	expect(session.streamLiveness()).toBe("idle");
	expect(getStreamLifecycleState()).toBe("idle");
	expect(marker.held).toBe(false);

	// An engine idle status or reconnect while forwarding stays idle, so the
	// forward can readmit itself after its own reset.
	session.noteEngineStatus({ type: "status", state: "idle", streaming: false });
	expect(session.streamLiveness()).toBe("idle");
	expect(await session.reconcile()).toBe("idle");
	expect(getStreamLifecycleState()).toBe("idle");
	expect((await session.stop("operator")).result).toBe("stopped");
});

test("a stale or reused process id never counts as an owned sender", async () => {
	const stale = forwardChild();
	await stopProcessAndWait(stale);
	await Bun.sleep(0);
	// The kernel reused the reaped PID for another sender.
	listSender(stale.proc.pid);
	expect(streamSessionProductionDeps.canReconcileIdle?.()).toBe(false);
	expect(streamSessionProductionDeps.senderAdmissionSafe?.()).toBe(false);
	rmSync(join(procRoot, String(stale.proc.pid)), { recursive: true });

	// A live handle whose PID now belongs to a process we did not start.
	const live = forwardChild();
	rmSync(join(procRoot, String(live.proc.pid)), { recursive: true });
	listSender(live.proc.pid, 1);
	expect(streamSessionProductionDeps.canReconcileIdle?.()).toBe(false);
	rmSync(join(procRoot, String(live.proc.pid)), { recursive: true });
	listSender(live.proc.pid);
	expect(streamSessionProductionDeps.canReconcileIdle?.()).toBe(true);

	// Owning one sender never hides an unowned one beside it.
	listSender(999_999);
	expect(streamSessionProductionDeps.canReconcileIdle?.()).toBe(false);
	expect(await streamSessionProductionDeps.queryRuntime()).toBe("unknown");
	await expect(streamSessionProductionDeps.stopRuntime(0)).rejects.toThrow(
		"sender_ownership_unproven",
	);
});

test("a census-only Start refusal does not change the lifecycle or protection", async () => {
	const { session, marker } = productionSession();
	expect(await session.reconcile()).toBe("idle");
	listSender(999_999);
	let launches = 0;
	const refused = await session.start({
		origin: "ui",
		launch: async () => {
			launches++;
		},
	});
	expect(refused).toMatchObject({
		result: "failed",
		failure: { class: "start_invalid", code: "sender_ownership_unproven" },
	});
	expect(launches).toBe(0);
	expect(session.snapshot().state).toBe("idle");
	expect(getStreamLifecycleState()).toBe("idle");
	expect(marker.held).toBe(false);

	// The lifecycle exclusion still answers first.
	setForwardActive(true);
	expect(
		await session.start({ origin: "ui", launch: async () => {} }),
	).toMatchObject({ result: "failed", failure: { code: "streaming_active" } });
	expect(launches).toBe(0);
});

test("an engine-ended session retires its own sender through the handle before idle", async () => {
	const { session, marker } = productionSession();
	let sender: StreamingProcess | undefined;
	const started = await session.start({
		origin: "ui",
		launch: async () => {
			sender = sessionChild();
		},
	});
	expect(started.result).toBe("started");
	expect(session.streamLiveness()).toBe("streaming");
	if (!sender) throw new Error("launch did not run");
	const owned = sender;

	session.noteEngineStatus({ type: "status", state: "idle", streaming: false });
	// Retirement owns the cleanup flight; a Start cannot overlap it.
	expect(
		(await session.start({ origin: "ui", launch: async () => {} })).result,
	).toBe("busy");
	for (let turn = 0; turn < 200 && session.snapshot().state !== "idle"; turn++)
		await Bun.sleep(5);
	expect(owned.proc.signalCode ?? owned.proc.exitCode).not.toBe(null);
	expect(getStreamingProcesses()).not.toContain(owned);
	expect(session.snapshot().state).toBe("idle");
	expect(session.streamLiveness()).toBe("idle");
	expect(marker.held).toBe(false);
	expect(getIsStreaming()).toBe(false);

	let relaunched = 0;
	const again = await session.start({
		origin: "ui",
		launch: async () => {
			relaunched++;
		},
	});
	expect(again.result).toBe("started");
	expect(relaunched).toBe(1);
});

test("an unconfirmed engine session keeps network interlocks closed without a live projection", async () => {
	engine = "streaming";
	const { session, marker } = productionSession({
		stopRuntime: async () => {
			engine = "idle";
		},
	});
	expect(await session.reconcile()).toBe("reconciling");
	expect(session.streamLiveness()).toBe("unknown");
	expect(marker.held).toBe(true);
	expect(getIsStreaming()).toBe(false);
	expect(defaultUsbModeDispatchDeps.isBlockedByLiveState()).toBe(true);
	expect((await createInterlockBridge("usb-1").canDisrupt()).allow).toBe(false);

	expect((await session.stop("operator")).result).toBe("stopped");
	expect(session.streamLiveness()).toBe("idle");
	expect(defaultUsbModeDispatchDeps.isBlockedByLiveState()).toBe(false);
});

test("restoration after a service restart does not blame an engine restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "restore-wording-"));
	const bootId = "11111111-1111-4111-8111-111111111111";
	const armed = join(directory, "armed.json");
	writeFileSync(
		armed,
		JSON.stringify({ armedAt: 1, bootId, config: { pipeline: "hdmi" } }),
	);
	const markerDeps: ArmedStreamMarkerDeps = {
		markerPath: armed,
		readBootId: () => bootId,
		readMarker: (path) => readFileSync(path, "utf8"),
		writeMarker: (path, text) => writeFileSync(path, text),
		removeMarker: (path) => rmSync(path, { force: true }),
	};
	try {
		let now = 0;
		let launches = 0;
		const outcome = await runStreamRestoration({
			marker: markerDeps,
			awaitRecovery: async () => undefined,
			runtimeState: async () => "unknown",
			lifecycleState: () => "reconciling",
			launch: async () => {
				launches++;
				return { ok: true };
			},
			now: () => now,
			wait: async () => {
				now += 100;
			},
			unknownDeadlineMs: 200,
		});
		expect(outcome).toMatchObject({
			result: "failed",
			reason: "runtime_state_unknown",
		});
		expect(launches).toBe(0);
		const notice = notificationExists("stream_recovery_failed");
		expect(notice?.key).toBe("notifications.streamRecoveryFailedAfterRestart");
		expect(notice?.msg).not.toContain("engine");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
