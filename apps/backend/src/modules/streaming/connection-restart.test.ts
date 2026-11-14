import { describe, expect, test } from "bun:test";
import {
	type ConnectionRestartDeps,
	createAutoRestart,
	requestConnectionRestart,
} from "./connection-restart.ts";
import { createStaleLinkNotice } from "./stale-link-notice.ts";

function fixture(overrides: Partial<ConnectionRestartDeps> = {}) {
	const calls: string[] = [];
	const notice = createStaleLinkNotice({
		now: () => 0,
		token: () => "tok",
		show: () => {},
		remove: () => calls.push("remove"),
		log: () => {},
	});
	let generation: number | undefined = 9;
	let intent = true;
	const deps: ConnectionRestartDeps = {
		generation: () => generation,
		take: notice.take,
		isStreaming: () => true,
		captureStopIntent: () => () => intent,
		stop: async () => {
			calls.push("stop");
			return { result: "stopped" };
		},
		start: async () => {
			calls.push("start");
			return { result: "started" };
		},
		announce: () => calls.push("announce"),
		log: () => {},
		...overrides,
	};
	return {
		deps,
		notice,
		calls,
		setGeneration: (next: number | undefined) => {
			generation = next;
		},
		operatorStops: () => {
			intent = false;
		},
	};
}

describe("restart connection tap", () => {
	test("a current offer restarts the whole session: Stop, then Start", async () => {
		const f = fixture();
		f.notice.offer(9, { count: 1 });
		const request = requestConnectionRestart("tok", f.deps);
		expect(request.output).toEqual({ success: true, result: "restarting" });
		expect(await request.done).toBe("started");
		// The operator asked for it: no announcement afterwards.
		expect(f.calls).toEqual(["remove", "stop", "start"]);
	});

	test("nothing restarts without the offer that is on screen", async () => {
		const f = fixture();
		const request = requestConnectionRestart("tok", f.deps);
		expect(request.output).toEqual({ success: false, result: "refused" });
		await request.done;
		expect(f.calls).toEqual([]);
	});

	test("an offer from an earlier session is refused", async () => {
		const f = fixture();
		f.notice.offer(9, { count: 1 });
		f.setGeneration(10);
		expect(requestConnectionRestart("tok", f.deps).output).toEqual({
			success: false,
			result: "refused",
		});
		f.setGeneration(undefined);
		expect(requestConnectionRestart("tok", f.deps).output).toEqual({
			success: false,
			result: "refused",
		});
		expect(f.calls).toEqual([]);
	});

	test("no restart when the stream is not running", async () => {
		const f = fixture({ isStreaming: () => false });
		f.notice.offer(9, { count: 1 });
		expect(requestConnectionRestart("tok", f.deps).output).toEqual({
			success: false,
			result: "refused",
		});
		expect(f.calls).toEqual([]);
	});

	test("a second tap does not restart twice", async () => {
		const f = fixture();
		f.notice.offer(9, { count: 1 });
		await requestConnectionRestart("tok", f.deps).done;
		const again = requestConnectionRestart("tok", f.deps);
		expect(again.output).toEqual({ success: false, result: "refused" });
		await again.done;
		expect(f.calls.filter((call) => call === "stop")).toHaveLength(1);
	});

	test("an operator Stop during the restart wins: no Start", async () => {
		const f = fixture();
		f.deps = {
			...f.deps,
			stop: async () => {
				f.calls.push("stop");
				f.operatorStops();
				return { result: "stopped" };
			},
		};
		f.notice.offer(9, { count: 1 });
		expect(await requestConnectionRestart("tok", f.deps).done).toBe(
			"cancelled",
		);
		expect(f.calls).toEqual(["remove", "stop"]);
	});

	test("a failed Stop does not start", async () => {
		const f = fixture({
			stop: async () => ({ result: "stop_failed" }),
		});
		f.notice.offer(9, { count: 1 });
		expect(await requestConnectionRestart("tok", f.deps).done).toBe(
			"stop_failed",
		);
		expect(f.calls).toEqual(["remove"]);
	});

	test("production wiring stops for reconfigure and starts from the UI origin", async () => {
		const owner = await import("./stream-session-orchestrator.ts");
		const { spyOn } = await import("bun:test");
		const { connectionRestartDeps } = await import("./connection-restart.ts");
		const stop = spyOn(owner, "stopStreamSession").mockResolvedValue({
			result: "stopped",
		});
		const start = spyOn(owner, "startStreamSession").mockResolvedValue({
			result: "started",
			attemptId: "a",
		});
		try {
			const deps = await connectionRestartDeps(
				{} as unknown as import("ws").default,
			);
			await deps.stop();
			await deps.start();
			expect(stop).toHaveBeenCalledWith("reconfigure");
			expect(start.mock.calls[0]?.[0].origin).toBe("ui");
		} finally {
			stop.mockRestore();
			start.mockRestore();
		}
	});
});

describe("automatic restart when nothing else carries the stream", () => {
	function auto() {
		let clock = 0;
		return {
			restarts: createAutoRestart(() => clock, 300_000),
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	test("restarts the whole session once and announces it after Start", async () => {
		const f = fixture();
		const a = auto();
		const request = a.restarts.request(9, f.deps);
		expect(request.result).toBe("restarting");
		expect(await request.done).toBe("started");
		expect(f.calls).toEqual(["stop", "start", "announce"]);
	});

	test("cannot repeat within the cooldown, and can after it", async () => {
		const f = fixture();
		const a = auto();
		await a.restarts.request(9, f.deps).done;
		a.advance(299_999);
		expect(a.restarts.request(9, f.deps).result).toBe("held");
		a.advance(1);
		expect(a.restarts.request(9, f.deps).result).toBe("restarting");
	});

	test("one restart at a time", async () => {
		const release = Promise.withResolvers<{ result: string }>();
		const f = fixture({ start: () => release.promise });
		const a = createAutoRestart(() => 0, 0);
		const first = a.request(9, f.deps);
		expect(a.request(9, f.deps).result).toBe("held");
		release.resolve({ result: "started" });
		await first.done;
		expect(f.calls.filter((call) => call === "stop")).toHaveLength(1);
	});

	test("never for a session that is no longer the running one", async () => {
		const f = fixture();
		f.setGeneration(10);
		expect(auto().restarts.request(9, f.deps).result).toBe("not_current");
		const idle = fixture({ isStreaming: () => false });
		expect(auto().restarts.request(9, idle.deps).result).toBe("not_current");
		expect([...f.calls, ...idle.calls]).toEqual([]);
	});

	test("says nothing when the new session did not start", async () => {
		const f = fixture({ start: async () => ({ result: "failed" }) });
		expect(await auto().restarts.request(9, f.deps).done).toBe("failed");
		expect(f.calls).not.toContain("announce");
	});

	test("an operator Stop during it wins, and nothing is announced", async () => {
		const f = fixture();
		f.deps = {
			...f.deps,
			stop: async () => {
				f.calls.push("stop");
				f.operatorStops();
				return { result: "stopped" };
			},
		};
		expect(await auto().restarts.request(9, f.deps).done).toBe("cancelled");
		expect(f.calls).toEqual(["stop"]);
	});
});
