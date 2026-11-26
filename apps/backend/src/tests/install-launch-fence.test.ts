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
