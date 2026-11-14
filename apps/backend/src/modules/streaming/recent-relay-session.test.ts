import { expect, test } from "bun:test";
import { createRecentRelaySession } from "./recent-relay-session.ts";

// The keyed relay authorizes by stream ID, so host, port and stream ID are the
// whole credential the key needs.
test("1000 retries require the exact recently valid destination and stream ID", () => {
	let now = 0;
	const recent = createRecentRelaySession(() => now);
	expect(recent.possiblyBusy("a", "SRT connect failed (reason 1000)")).toBe(
		false,
	);
	recent.valid("a");
	expect(recent.possiblyBusy("a", "SRT connect failed (reason 1000)")).toBe(
		true,
	);
	expect(recent.possiblyBusy("b", "SRT connect failed (reason 1000)")).toBe(
		false,
	);
	expect(recent.possiblyBusy("a", "SRT connect failed (reason 1001)")).toBe(
		false,
	);
	// A wrong passphrase (libsrt BADSECRET, reason 10) is an auth failure, never
	// a busy session; reason 8 (VERSION) is not busy either.
	expect(recent.possiblyBusy("a", "SRT connect failed (reason 10)")).toBe(
		false,
	);
	expect(recent.possiblyBusy("a", "SRT connect failed (reason 8)")).toBe(false);
	// The field's own engine message.
	expect(
		recent.possiblyBusy(
			"a",
			"internal engine error: transport connect: SRT connect failed (reason 1000)",
		),
	).toBe(true);
	expect(recent.possiblyBusy("a", undefined)).toBe(false);
	now = 45001;
	expect(recent.possiblyBusy("a", "SRT connect failed (reason 1000)")).toBe(
		false,
	);
});

test("a long-running valid session gets a bounded quick-restart window at Stop", () => {
	let now = 0;
	const recent = createRecentRelaySession(() => now);
	recent.valid("same");
	now = 7200000;
	recent.stopped();
	expect(recent.possiblyBusy("same", "SRT connect failed (reason 1000)")).toBe(
		true,
	);
	now += 45001;
	recent.stopped(); // Repeated Stop must never extend eligibility.
	expect(recent.possiblyBusy("same", "SRT connect failed (reason 1000)")).toBe(
		false,
	);
});

test("busy-session retries relaunch the complete session with short bounded backoff", async () => {
	const { runStartWithRetry } = await import("./stream-start-retry.ts");
	const { StreamStartFailure } = await import("./start-failure-taxonomy.ts");
	let now = 0,
		launches = 0;
	const delays: number[] = [];
	const result = await runStartWithRetry({
		attemptId: "test",
		launch: async () => {
			launches++;
			throw new StreamStartFailure(
				{
					attemptId: "test",
					phase: "start-rpc",
					class: "engine_internal",
					code: "relay_session_busy",
					retriable: true,
				},
				"idle",
			);
		},
		classifyUnknown: () => {
			throw new Error("unexpected");
		},
		cancelled: () => false,
		onLaunchTimeout: async () => {},
		setCancelWait: () => {},
		schedule: (callback, delay) => {
			delays.push(delay);
			now += delay;
			queueMicrotask(callback);
			return 0;
		},
		cancelTimer: () => {},
		scheduleDeadline: () => 0,
		cancelDeadline: () => {},
		cleanupDeadlineMs: 1000,
		now: () => now,
	});
	expect(result.result).toBe("failed");
	expect(launches).toBe(5);
	expect(delays).toEqual([1000, 2000, 4000, 8000]);
});
