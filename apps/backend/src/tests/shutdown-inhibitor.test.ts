import { describe, expect, test } from "bun:test";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	classifyPowerFailure,
	plannedPowerFailureMessage,
} from "../modules/system/disruptive-action-reservation.ts";
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

test("power failures preserve policy, session, command and uncertainty distinctions", () => {
	expect(classifyPowerFailure(1, "Access denied")).toBe("shutdown_inhibited");
	expect(classifyPowerFailure(1, "User demo is logged in on sshd.")).toBe(
		"other_users",
	);
	expect(classifyPowerFailure(127, "")).toBe("shutdown_unavailable");
	expect(classifyPowerFailure(1, "Failed to connect to bus")).toBe(
		"shutdown_unavailable",
	);
	expect(classifyPowerFailure(null, "")).toBe("shutdown_uncertain");
});

for (const ending of ["idle", "dispose"] as const) {
	test(`late asynchronous acquisition closes after ${ending}`, async () => {
		let finish!: (close: () => void) => void;
		let calls = 0,
			closed = 0;
		const lock = createShutdownInhibitor(() => {
			calls++;
			return new Promise<() => void>((resolve) => {
				finish = resolve;
			});
		});
		expect(lock.set("encoder", true)).toBe(false);
		expect(lock.set("carrying", true)).toBe(false);
		expect(calls).toBe(1);
		if (ending === "dispose") lock.dispose();
		else {
			lock.set("encoder", false);
			lock.set("carrying", false);
		}
		finish(() => {
			closed++;
		});
		await lock.pending();
		expect(closed).toBe(1);
		expect(lock.confirmed()).toBe(false);
	});
}
test("asynchronous acquisition confirms both owners and backs off failed attempts", async () => {
	let calls = 0,
		closed = 0;
	const lock = createShutdownInhibitor(async () => {
		if (++calls === 1) throw Error("silent bus");
		return () => {
			closed++;
		};
	});
	expect(lock.set("encoder", true)).toBe(false);
	await lock.pending();
	expect(lock.set("encoder", true)).toBe(false);
	expect(calls).toBe(1);
	await Bun.sleep(1050);
	expect(lock.set("carrying", true)).toBe(false);
	await lock.pending();
	expect(lock.set("encoder", true)).toBe(true);
	lock.set("encoder", false);
	expect(closed).toBe(0);
	lock.set("carrying", false);
	expect(closed).toBe(1);
});
test("Stop during asynchronous shutdown admission prevents media launch", async () => {
	let finish!: (allowed: boolean) => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let launched = false;
	let cancelled = false;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "attempt",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		ensureShutdownProtection: (_current, signal) => {
			signal?.addEventListener("abort", () => {
				cancelled = true;
			});
			entered();
			return new Promise<boolean>((resolve) => {
				finish = resolve;
			});
		},
	});
	const start = session.start({
		origin: "ui",
		launch: async () => {
			launched = true;
		},
	});
	await waiting;
	const stop = session.stop("operator");
	finish(true);
	expect((await start).result).toBe("cancelled");
	await stop;
	expect(launched).toBe(false);
	expect(cancelled).toBe(true);
});
