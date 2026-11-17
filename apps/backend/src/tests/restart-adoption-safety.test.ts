import { expect, test } from "bun:test";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

for (const sender of [
	"dead",
	"identity-mismatch",
	"healthy-external",
] as const) {
	test(`${sender}: engine streaming alone never establishes live adoption`, async () => {
		let protectedStream = false;
		let launches = 0;
		let runtime: "idle" | "streaming" = "streaming";
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "restart",
			setStreamingStatus: () => {},
			queryRuntime: async () => runtime,
			canReconcileStreaming: () => false,
			markStreamingForOta: () => {
				protectedStream = true;
			},
			unmarkStreamingForOta: () => {
				protectedStream = false;
			},
			stopRuntime: async () => {
				runtime = "idle";
			},
		});
		expect(await session.reconcile()).toBe("reconciling");
		expect(session.streamLiveness()).toBe("unknown");
		expect(protectedStream).toBe(true);
		expect(
			(
				await session.start({
					origin: "ui",
					launch: async () => {
						launches++;
						return { success: true };
					},
				})
			).result,
		).toBe("busy");
		expect(launches).toBe(0);
		expect(await session.reconcile()).toBe("reconciling");
		expect((await session.stop("operator")).result).toBe("stopped");
		expect(session.streamLiveness()).toBe("idle");
		expect(protectedStream).toBe(false);
	});
}

// The census cannot authorize adoption: name matches only block replacement.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ownsSessionSender,
	senderCensus,
	unownedSenderCensus,
} from "../modules/streaming/sender-ownership.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";

test("sender handles require the configured executable and a live unreaped child", () => {
	const process = (
		spawnfile: string,
		exitCode: number | null,
		signalCode: string | null,
	) => ({ spawnfile, proc: { exitCode, signalCode } }) as StreamingProcess;
	expect(
		ownsSessionSender(
			[process("/owned/srtla_send", null, null)],
			"/owned/srtla_send",
		),
	).toBe(true);
	expect(
		ownsSessionSender(
			[process("/other/srtla_send", null, null)],
			"/owned/srtla_send",
		),
	).toBe(false);
	expect(
		ownsSessionSender(
			[process("/owned/srtla_send", 0, null)],
			"/owned/srtla_send",
		),
	).toBe(false);
	expect(
		ownsSessionSender(
			[process("/owned/srtla_send", null, "SIGKILL")],
			"/owned/srtla_send",
		),
	).toBe(false);
});

test("sender census preserves an external survivor and unreadable presence stays unknown", () => {
	const root = mkdtempSync(join(tmpdir(), "sender-census-"));
	try {
		expect(senderCensus(root)).toBe("absent");
		mkdirSync(join(root, "123"));
		writeFileSync(join(root, "123/comm"), "srtla_send\n");
		expect(senderCensus(root)).toBe("present");
		expect(ownsSessionSender([])).toBe(false);
		rmSync(join(root, "123/comm"));
		mkdirSync(join(root, "123/comm"));
		expect(senderCensus(root)).toBe("unknown");
		expect(senderCensus(join(root, "missing"))).toBe("unknown");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a retained launched generation can reconcile a healthy owned sender", async () => {
	let verifiedGeneration: number | undefined;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "owned",
		setStreamingStatus: () => {},
		queryRuntime: async () => "streaming",
		stopRuntime: async () => {},
		canReconcileStreaming: (generation) => {
			verifiedGeneration = generation;
			return generation !== undefined;
		},
	});
	expect(
		(
			await session.start({
				origin: "ui",
				launch: async () => ({ success: true }),
			})
		).result,
	).toBe("started");
	expect(await session.reconcile()).toBe("streaming");
	expect(verifiedGeneration).toBe(1);
});

test("an idle engine cannot release protection while an external sender remains", async () => {
	let held = false;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "external",
		queryRuntime: async () => "idle",
		canReconcileIdle: () => false,
		senderAdmissionSafe: () => false,
		setStreamingStatus: () => {},
		stopRuntime: async () => {
			throw new Error("sender_ownership_unproven");
		},
		markStreamingForOta: () => {
			held = true;
		},
	});
	expect(await session.reconcile()).toBe("reconciling");
	expect(held).toBe(true);
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
	expect((await session.stop("operator")).result).toBe("stop_failed");
	session.noteEngineStatus({ type: "status", state: "idle", streaming: false });
	expect(session.streamLiveness()).toBe("unknown");
	expect(held).toBe(true);
});

test("the unowned census subtracts only live child handles by exact process id", () => {
	const root = mkdtempSync(join(tmpdir(), "sender-unowned-"));
	const row = (pid: number, parent: number, name = "srtla_send") => {
		mkdirSync(join(root, String(pid)));
		writeFileSync(join(root, `${pid}/comm`), `${name}\n`);
		// A process name with spaces and parentheses must not shift the fields.
		writeFileSync(
			join(root, `${pid}/stat`),
			`${pid} (${name} (x) y) S ${parent} 1 1 0 -1\n`,
		);
	};
	const handle = (
		pid: number,
		exitCode: number | null = null,
		signalCode: string | null = null,
	) => ({ spawnfile: "x", proc: { pid, exitCode, signalCode } }) as never;
	try {
		row(41, 7);
		expect(unownedSenderCensus([handle(41)], root, 7)).toBe("absent");
		expect(unownedSenderCensus([], root, 7)).toBe("present");
		expect(unownedSenderCensus([handle(41, 0)], root, 7)).toBe("present");
		expect(unownedSenderCensus([handle(41, null, "SIGTERM")], root, 7)).toBe(
			"present",
		);
		expect(unownedSenderCensus([handle(41)], root, 8)).toBe("present");
		row(42, 1, "sleep");
		expect(unownedSenderCensus([handle(41)], root, 7)).toBe("absent");
		rmSync(join(root, "41/stat"));
		mkdirSync(join(root, "41/stat"));
		expect(unownedSenderCensus([handle(41)], root, 7)).toBe("unknown");
		expect(unownedSenderCensus([], join(root, "missing"), 7)).toBe("unknown");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an engine-ended session retires owned children before idle, and stays protected if it cannot", async () => {
	for (const retirement of ["stopped", "failed"] as const) {
		let owned = true;
		let held = false;
		let stops = 0;
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "owned-idle",
			setStreamingStatus: () => {},
			queryRuntime: async () => "idle",
			ownedSessionRemains: () => owned,
			markStreamingForOta: () => {
				held = true;
			},
			unmarkStreamingForOta: () => {
				held = false;
			},
			stopRuntime: async () => {
				stops++;
				if (retirement === "failed") throw new Error("stop_timeout");
				owned = false;
			},
		});
		expect(
			(await session.start({ origin: "ui", launch: async () => {} })).result,
		).toBe("started");
		session.noteEngineStatus({
			type: "status",
			state: "idle",
			streaming: false,
		});
		expect(session.snapshot().state).toBe("reconciling");
		expect(held).toBe(true);
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(stops).toBe(1);
		if (retirement === "stopped") {
			expect(session.snapshot().state).toBe("idle");
			expect(session.streamLiveness()).toBe("idle");
			expect(held).toBe(false);
		} else {
			expect(session.snapshot().state).toBe("reconciling");
			expect(session.streamLiveness()).toBe("unknown");
			expect(held).toBe(true);
			// A reconcile that sees the idle engine tries the same retirement again.
			expect(await session.reconcile()).toBe("reconciling");
			expect(stops).toBe(2);
		}
	}
});

test("liveness unknown is published for interlocks outside the session", async () => {
	const published: boolean[] = [];
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "published",
		setStreamingStatus: () => {},
		queryRuntime: async () => "streaming",
		canReconcileStreaming: () => false,
		setLivenessUnconfirmed: (unconfirmed) => published.push(unconfirmed),
		stopRuntime: async () => {},
	});
	expect(published.at(-1)).toBe(false);
	expect(await session.reconcile()).toBe("reconciling");
	expect(published.at(-1)).toBe(true);
	expect((await session.stop("operator")).result).toBe("stopped");
	expect(published.at(-1)).toBe(false);
});
