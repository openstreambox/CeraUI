import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { PowerSubmissionError } from "../modules/system/disruptive-action-reservation.ts";
import { createShutdownInhibitor } from "../modules/system/shutdown-inhibitor.ts";
import {
	initShutdownProtection,
	setShutdownProtection,
} from "../modules/system/shutdown-protection.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import {
	poweroffProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";

function countingLock() {
	const counts = { taken: 0, released: 0 };
	const lock = createShutdownInhibitor(() => {
		counts.taken++;
		return () => {
			counts.released++;
		};
	});
	return { lock, counts, held: () => counts.taken - counts.released === 1 };
}

describe("an admitted power action yields this process's own lock", () => {
	test("yield closes the lease and keeps the owners; retaking reacquires", () => {
		const { lock, counts, held } = countingLock();
		lock.set("carrying", true);
		expect(held()).toBe(true);
		const retake = lock.yieldForPowerAction();
		expect(held()).toBe(false);
		expect(lock.confirmed()).toBe(false);
		// Owners keep reporting while yielded, but nothing reacquires.
		expect(lock.set("encoder", true)).toBe(false);
		expect(counts.taken).toBe(1);
		retake();
		expect(held()).toBe(true);
		expect(counts.taken).toBe(2);
		retake();
		expect(counts.taken).toBe(2);
	});

	test("retaking with no owners left takes nothing", () => {
		const { lock, counts } = countingLock();
		lock.set("carrying", true);
		const retake = lock.yieldForPowerAction();
		expect(lock.set("carrying", false)).toBe(true);
		retake();
		expect(counts.taken).toBe(1);
		expect(lock.confirmed()).toBe(false);
	});

	test("an acquisition that completes while yielded is closed at once", async () => {
		let resolve: (close: () => void) => void = () => {};
		let released = 0;
		const lock = createShutdownInhibitor(
			() =>
				new Promise<() => void>((done) => {
					resolve = done;
				}),
		);
		expect(lock.set("encoder", true)).toBe(false);
		const pending = lock.pending();
		lock.yieldForPowerAction();
		resolve(() => {
			released++;
		});
		await pending;
		expect(released).toBe(1);
		expect(lock.confirmed()).toBe(false);
	});

	test("exit cleanup after a yield neither reacquires nor double-closes", () => {
		const { lock, counts } = countingLock();
		lock.set("encoder", true);
		const retake = lock.yieldForPowerAction();
		lock.dispose();
		retake();
		expect(counts).toEqual({ taken: 1, released: 1 });
	});
});

describe("local power-off through the RPC", () => {
	const saved = {
		NODE_ENV: process.env.NODE_ENV,
		MOCK_MODE: process.env.MOCK_MODE,
		CERALIVE_STREAMING_MARKER: process.env.CERALIVE_STREAMING_MARKER,
	};
	const counts = { taken: 0, released: 0 };
	const held = () => counts.taken - counts.released === 1;
	let dir = "";
	initShutdownProtection(() => {
		counts.taken++;
		return () => {
			counts.released++;
		};
	});

	beforeEach(() => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		dir = mkdtempSync(join(tmpdir(), "power-yield-"));
		process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
		setStreamReconciliationCompletedForTest(true);
		resetOrchestratorRuntimeForTest();
		updateStatus(false);
		updateStreamLifecycleState("idle");
		// The gate admits power-off, yet this process still holds its lock: the
		// phone-only startup check, or a release that has not landed yet.
		setShutdownProtection("carrying", true);
	});
	afterEach(() => {
		setShutdownProtection("carrying", false);
		resetPowerCommandRunner();
		resetOrchestratorRuntimeForTest();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	test("the command runs with this process's lock released", async () => {
		expect(held()).toBe(true);
		const seen: boolean[] = [];
		setPowerCommandRunner(() => {
			seen.push(held());
		});
		const result = await call(poweroffProcedure, undefined, {
			context: buildControlContext(),
		});
		expect(result.success).toBe(true);
		expect(seen).toEqual([false]);
	});

	test("a refused submission takes the lock again", async () => {
		setPowerCommandRunner((command) => {
			throw new PowerSubmissionError(command, 1, "refused", "Access denied");
		});
		const result = await call(poweroffProcedure, undefined, {
			context: buildControlContext(),
		});
		expect(result.success).toBe(false);
		expect(held()).toBe(true);
	});
});
