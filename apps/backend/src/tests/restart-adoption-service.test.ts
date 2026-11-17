import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ownsSessionSender,
	senderCensus,
} from "../modules/streaming/sender-ownership.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { getStreamingBackend } from "../modules/streaming/streaming-engine.ts";
import { srtlaSendExec } from "../modules/streaming/streamloop/exec-paths.ts";
import {
	spawnStreamingLoop,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";

const directory = process.env.CERAUI_RESTART_CONTRACT_DIR;
test.skipIf(!directory)(
	"owned service lifecycle refuses false sender adoption",
	async () => {
		if (!directory) return;
		let engine: "streaming" | "idle" = "streaming";
		let protectedStream = false;
		const session = createStreamSessionOrchestrator({
			...streamSessionProductionDeps,
			initialLiveness: "unknown",
			createAttemptId: () => "service",
			queryRuntime: async () => engine,
			setStreamingStatus: () => {},
			seedLifecycleState: () => {},
			setLifecycleState: () => {},
			markStreamingForOta: () => {
				protectedStream = true;
			},
			unmarkStreamingForOta: () => {
				protectedStream = false;
			},
			stopRuntime: async () => {
				engine = "idle";
			},
			onStreamStopped: () => {},
			onStreamCommitted: () => {},
			onStreamArmed: () => {},
			ensureShutdownProtection: async () => true,
			claimLaunchMarker: () => true,
			admitLifecycle: undefined,
			admitUpdate: undefined,
			awaitRecovery: undefined,
			recoveryPending: undefined,
			blockingMutation: undefined,
		});
		const pidFile = join(directory, "sender-pid");
		if (!existsSync(pidFile)) {
			const sender = spawnStreamingLoop(srtlaSendExec, ["300"], () => {});
			await Bun.sleep(30);
			expect(sender.proc.exitCode).toBe(null);
			expect(sender.proc.signalCode).toBe(null);
			expect(senderCensus()).toBe("present");
			writeFileSync(pidFile, String(sender.proc.pid));
			// The initial process remains until its owning service is restarted/killed.
			writeFileSync(join(directory, "ready"), "ready");
			await new Promise(() => {});
		} else {
			const oldPid = readFileSync(pidFile, "utf8");
			// systemd's control-group retirement killed the child, although the engine
			// session (represented by its authoritative streaming reply) remains.
			expect(existsSync(`/proc/${oldPid}`)).toBe(false);
			expect(ownsSessionSender()).toBe(false);
			const survivor = Bun.spawn([srtlaSendExec, "300"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			try {
				await Bun.sleep(30);
				expect(survivor.exitCode).toBe(null);
				expect(senderCensus()).toBe("present");
				expect(await session.reconcile()).toBe("reconciling");
				expect(survivor.exitCode).toBe(null);
				expect(survivor.signalCode).toBe(null);
				expect(streamSessionProductionDeps.senderAdmissionSafe?.()).toBe(false);
			} finally {
				survivor.kill("SIGTERM");
				await survivor.exited;
			}
			expect(await session.reconcile()).toBe("reconciling");
			expect(protectedStream).toBe(true);
			expect(session.streamLiveness()).toBe("unknown");
			expect(
				(
					await session.start({
						origin: "ui",
						launch: async () => {
							throw new Error("must not start");
						},
					})
				).result,
			).toBe("busy");
			expect(await session.reconcile()).toBe("reconciling");
			expect((await session.stop("operator")).result).toBe("stopped");
			expect(protectedStream).toBe(false);
			const start = await session.start({
				origin: "ui",
				launch: async () => ({ success: true }),
			});
			expect(start.result).toBe("started");
			const sender = spawnStreamingLoop(srtlaSendExec, ["300"], () => {});
			engine = "streaming";
			expect(await session.reconcile()).toBe("reconciling");
			const engineOwner = spyOn(
				getStreamingBackend(),
				"ownsLaunchedSession",
			).mockReturnValue(true);
			try {
				expect(ownsSessionSender()).toBe(true);
				engine = "streaming";
				expect(await session.reconcile()).toBe("streaming");
				expect(session.streamLiveness()).toBe("streaming");
			} finally {
				engineOwner.mockRestore();
				await stopProcessAndWait(sender);
			}
			expect(senderCensus()).toBe("absent");
			writeFileSync(join(directory, "passed"), "passed");
		}
	},
	360_000,
);
