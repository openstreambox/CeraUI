import { describe, expect, test } from "bun:test";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { plannedPowerFailureMessage } from "../modules/system/disruptive-action-reservation.ts";
import { createShutdownInhibitor } from "../modules/system/shutdown-inhibitor.ts";

describe("shutdown inhibitor ownership", () => {
	for (const owner of ["encoder", "carrying"] as const) {
		test(`${owner} takes and releases a single block lease`, () => {
			let taken = 0,
				released = 0;
			const lock = createShutdownInhibitor(() => {
				taken++;
				return () => {
					released++;
				};
			});
			expect(lock.set(owner, true)).toBe(true);
			lock.set(owner, true);
			expect(taken).toBe(1);
			lock.set(owner, false);
			lock.dispose();
			expect(released).toBe(1);
		});
	}
	test("neither owner releases the other owner's protection", () => {
		let released = 0;
		const lock = createShutdownInhibitor(() => () => {
			released++;
		});
		lock.set("encoder", true);
		lock.set("carrying", true);
		lock.set("encoder", false);
		expect(released).toBe(0);
		lock.set("carrying", false);
		expect(released).toBe(1);
	});
	test("failed acquisition remains retryable and never reports protection", () => {
		let attempts = 0;
		const lock = createShutdownInhibitor(() => {
			if (++attempts === 1) throw Error("unavailable");
			return () => {};
		});
		expect(lock.set("carrying", true)).toBe(false);
		expect(lock.set("carrying", true)).toBe(true);
	});
	test("exit cleanup closes once and prevents reacquisition", () => {
		let released = 0;
		const lock = createShutdownInhibitor(() => () => {
			released++;
		});
		lock.set("encoder", true);
		lock.dispose();
		lock.dispose();
		expect(released).toBe(1);
		expect(lock.set("encoder", true)).toBe(false);
	});
	test("failure to acquire refuses launch before any media effect", async () => {
		let launched = false;
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "attempt",
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			ensureShutdownProtection: () => false,
		});
		const result = await session.start({
			origin: "ui",
			launch: async () => {
				launched = true;
			},
		});
		expect(result.result).toBe("failed");
		expect(launched).toBe(false);
		expect(session.streamLiveness()).toBe("idle");
	});
});

test("unacknowledged power submission never claims it was refused", () => {
	for (const code of [null, 137, 143])
		expect(plannedPowerFailureMessage(code)).toContain(
			"could not be confirmed",
		);
	expect(plannedPowerFailureMessage(1)).toContain("was not run");
});
