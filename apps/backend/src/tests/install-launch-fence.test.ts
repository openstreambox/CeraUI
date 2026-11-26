/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
	createInstallLaunchFence,
	InstallAttemptEndedError,
} from "../modules/system/install-launch-fence.ts";

const never = () => {
	throw new Error("not expected");
};
const permitted = () => null;

describe("the install launch fence", () => {
	it("a stream that enters first ends the attempt: nothing is submitted", async () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		let cancelled = 0;
		expect(await fence.admitStream(() => cancelled++)).toBe("cancelled");
		expect(attempt.state()).toBe("ended");
		let launched = 0;
		await expect(
			fence.submit(attempt, {
				refusal: permitted,
				refuse: never,
				launch: async () => {
					launched++;
				},
				refused: never,
			}),
		).rejects.toBeInstanceOf(InstallAttemptEndedError);
		expect(launched).toBe(0);
		expect(cancelled).toBe(1);
		// Decided once: a second stream finds it ended, and cancels nothing.
		expect(await fence.admitStream(never)).toBe("ended");
	});

	it("a stream that arrives during the submission waits and finds a launched unit", async () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		const systemdRun = Promise.withResolvers<void>();
		const order: string[] = [];
		const submitted = fence.submit(attempt, {
			refusal: permitted,
			refuse: never,
			launch: async () => {
				order.push("systemd-run called");
				await systemdRun.promise;
				order.push("systemd-run returned");
			},
			refused: never,
		});
		const admitted = fence.admitStream(never).then((verdict) => {
			order.push(`stream: ${verdict}`);
			return verdict;
		});
		await Bun.sleep(5);
		// Neither pending-and-cancellable nor submitted is visible meanwhile.
		expect(order).toEqual(["systemd-run called"]);
		expect(attempt.state()).toBe("pending");
		systemdRun.resolve();
		await submitted;
		expect(await admitted).toBe("submitted");
		expect(order).toEqual([
			"systemd-run called",
			"systemd-run returned",
			"stream: submitted",
		]);
		expect(fence.launched()).toBe(true);
	});

	it("reads the refusal inside the section, right before the launch", async () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		const reasons: string[] = [];
		let launched = 0;
		await expect(
			fence.submit(attempt, {
				refusal: () => "discovery_failed",
				refuse: (reason) => reasons.push(reason),
				launch: async () => {
					launched++;
				},
				refused: never,
			}),
		).rejects.toBeInstanceOf(InstallAttemptEndedError);
		expect(reasons).toEqual(["discovery_failed"]);
		expect(launched).toBe(0);
		expect(attempt.state()).toBe("ended");
	});

	it("a submission that definitively failed ends the attempt with its error", async () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		const errors: unknown[] = [];
		const refusal = new Error("systemd-run: unit refused");
		await expect(
			fence.submit(attempt, {
				refusal: permitted,
				refuse: never,
				launch: async () => {
					throw refusal;
				},
				refused: (error) => errors.push(error),
			}),
		).rejects.toBe(refusal);
		expect(errors).toEqual([refusal]);
		expect(attempt.state()).toBe("ended");
		// A stream after that meets a settled refusal, not a launched unit.
		expect(await fence.admitStream(never)).toBe("ended");
		expect(fence.launched()).toBe(false);
	});

	it("an attempt ends once, and a start that joins a waiting one is the same attempt", () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		expect(fence.begin()).toBe(attempt);
		expect(fence.end(attempt)).toBe(true);
		expect(fence.end(attempt)).toBe(false);
		const next = fence.begin();
		expect(next).not.toBe(attempt);
		// The older attempt can no longer end or submit anything.
		expect(fence.end(attempt)).toBe(false);
		expect(next.pending()).toBe(true);
	});

	it("a start that was not accepted leaves no attempt, and a found unit counts as launched", async () => {
		const fence = createInstallLaunchFence();
		expect(await fence.admitStream(never)).toBe("none");
		const attempt = fence.begin();
		fence.drop(attempt);
		expect(fence.current()).toBeNull();
		fence.adopt();
		expect(await fence.admitStream(never)).toBe("submitted");
	});

	it("a start that is declined leaves the install before it as the current one", async () => {
		const fence = createInstallLaunchFence();
		// An install that ended before launch.
		const ended = fence.begin();
		fence.end(ended);
		// A start is asked for and declined: it was never an attempt.
		const declined = fence.begin();
		expect(fence.current()).toBe(declined);
		fence.drop(declined);
		expect(fence.current()).toBe(ended);
		expect(ended.state()).toBe("ended");
		// A stream then meets the ended install, not a missing one.
		expect(await fence.admitStream(never)).toBe("ended");
		// The same over a launched unit.
		fence.adopt();
		const launched = fence.current();
		fence.drop(fence.begin());
		expect(fence.current()).toBe(launched);
		expect(fence.launched()).toBe(true);
		// A start that is admitted does take its place.
		const admitted = fence.begin();
		expect(fence.current()).toBe(admitted);
		expect(fence.owns(admitted)).toBe(true);
	});

	it("the attempt before it is kept only until the start is decided", () => {
		const fence = createInstallLaunchFence();
		const ended = fence.begin();
		fence.end(ended);
		// Admitted: the install before it is let go, so nothing can bring it
		// back as the current one later.
		const admitted = fence.begin();
		fence.admit(admitted);
		fence.drop(admitted);
		expect(fence.current()).toBeNull();
		// Declined: put back once, and not held on to by the declined start.
		const again = fence.begin();
		fence.end(again);
		const declined = fence.begin();
		fence.drop(declined);
		expect(fence.current()).toBe(again);
		fence.drop(declined);
		expect(fence.current()).toBe(again);
	});

	it("only the pending current attempt owns the install", async () => {
		const fence = createInstallLaunchFence();
		const first = fence.begin();
		expect(fence.owns(first)).toBe(true);
		fence.end(first);
		expect(fence.owns(first)).toBe(false);
		// A newer attempt owns it; the older one never does again.
		const second = fence.begin();
		expect(fence.owns(second)).toBe(true);
		expect(fence.owns(first)).toBe(false);
		await fence.submit(second, {
			refusal: permitted,
			refuse: never,
			launch: async () => {},
			refused: never,
		});
		// Submitted, the install is the unit's: nothing is done "before launch".
		expect(fence.owns(second)).toBe(false);
	});

	it("an ended attempt drains until its last wait has returned", async () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		const run = fence.hold(attempt);
		const launcher = fence.hold(attempt);
		// Pending, it is simply the install in progress.
		expect(fence.draining()).toBe(false);
		await fence.drained();
		fence.end(attempt);
		expect(fence.draining()).toBe(true);
		let drained = false;
		const waiting = fence.drained().then(() => {
			drained = true;
		});
		run();
		run();
		await Bun.sleep(1);
		expect(drained).toBe(false);
		expect(fence.draining()).toBe(true);
		launcher();
		await waiting;
		expect(fence.draining()).toBe(false);
		// A replaced attempt that still drains keeps the updater too.
		const next = fence.begin();
		const hold = fence.hold(next);
		fence.end(next);
		fence.begin();
		expect(fence.draining()).toBe(true);
		hold();
		expect(fence.draining()).toBe(false);
	});

	it("a submitted attempt does not drain: its unit holds the updater", async () => {
		const fence = createInstallLaunchFence();
		const attempt = fence.begin();
		fence.hold(attempt);
		await fence.submit(attempt, {
			refusal: permitted,
			refuse: never,
			launch: async () => {},
			refused: never,
		});
		expect(fence.draining()).toBe(false);
	});

	it("a failed turn does not block the next one", async () => {
		const fence = createInstallLaunchFence();
		const first = fence.begin();
		await expect(
			fence.submit(first, {
				refusal: permitted,
				refuse: never,
				launch: async () => {
					throw new Error("refused");
				},
				refused: () => {},
			}),
		).rejects.toThrow("refused");
		const second = fence.begin();
		await fence.submit(second, {
			refusal: permitted,
			refuse: never,
			launch: async () => {},
			refused: never,
		});
		expect(second.state()).toBe("submitted");
	});
});
