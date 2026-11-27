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
		beginRestart: () => {
			calls.push("restarting");
			return () => calls.push("restarted");
		},
		stop: async () => {
			calls.push("stop");
			return { result: "stopped" };
		},
		start: async () => {
			calls.push("start");
			return { result: "started" };
		},
		announce: (kind) => calls.push(`announce:${kind}`),
		reconnect: (stillWanted) =>
			calls.push(stillWanted() ? "reconnect" : "reconnect:unwanted"),
		announceFailure: (failed) => calls.push(`failed:${failed}`),
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
		expect(f.calls).toEqual([
			"remove",
			"restarting",
			"stop",
			"start",
			"restarted",
		]);
	});

	test("nothing restarts without the offer that is on screen", async () => {
		const f = fixture();
		const request = requestConnectionRestart("tok", f.deps);
		expect(request.output).toEqual({
			success: false,
			result: "refused",
			error: "offer_not_current",
		});
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
			error: "offer_not_current",
		});
		f.setGeneration(undefined);
		expect(requestConnectionRestart("tok", f.deps).output).toEqual({
			success: false,
			result: "refused",
			error: "offer_not_current",
		});
		expect(f.calls).toEqual([]);
	});

	test("no restart when the stream is not running", async () => {
		const f = fixture({ isStreaming: () => false });
		f.notice.offer(9, { count: 1 });
		expect(requestConnectionRestart("tok", f.deps).output).toEqual({
			success: false,
			result: "refused",
			error: "offer_not_current",
		});
		expect(f.calls).toEqual([]);
	});

	test("a second tap does not restart twice", async () => {
		const f = fixture();
		f.notice.offer(9, { count: 1 });
		await requestConnectionRestart("tok", f.deps).done;
		const again = requestConnectionRestart("tok", f.deps);
		expect(again.output).toEqual({
			success: false,
			result: "refused",
			error: "offer_not_current",
		});
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
		// The operator chose the Stop: no failure notice.
		expect(f.calls).toEqual(["remove", "restarting", "stop", "restarted"]);
	});

	test("a failed Stop does not start", async () => {
		const f = fixture({
			stop: async () => ({ result: "stop_failed" }),
		});
		f.notice.offer(9, { count: 1 });
		expect(await requestConnectionRestart("tok", f.deps).done).toBe(
			"stop_failed",
		);
		// Said once the restarting status has dropped, never in silence.
		expect(f.calls).toEqual([
			"remove",
			"restarting",
			"restarted",
			"failed:stop",
		]);
	});

	test.each(["busy", "failed", "rejected"])(
		"a Start that ends %s after the Stop hands the stream to the reconnect window before the restarting status drops",
		async (result) => {
			const f = fixture({
				start: async () => {
					f.calls.push("start");
					return { result };
				},
			});
			f.notice.offer(9, { count: 1 });
			expect(await requestConnectionRestart("tok", f.deps).done).toBe(result);
			expect(f.calls).toEqual([
				"remove",
				"restarting",
				"stop",
				"start",
				"reconnect",
				"restarted",
			]);
		},
	);

	test("a reconnect that throws still ends the restart", async () => {
		const f = fixture({
			start: async () => ({ result: "failed" }),
			reconnect: () => {
				throw new Error("window broke");
			},
		});
		f.notice.offer(9, { count: 1 });
		expect(await requestConnectionRestart("tok", f.deps).done).toBe("failed");
		expect(f.calls.at(-1)).toBe("restarted");
	});

	test("a throw names the half that did not finish", async () => {
		const stopThrows = fixture({
			stop: async () => {
				throw new Error("engine gone");
			},
		});
		stopThrows.notice.offer(9, { count: 1 });
		await requestConnectionRestart("tok", stopThrows.deps).done;
		expect(stopThrows.calls.at(-1)).toBe("failed:stop");
		const startThrows = fixture({
			start: async () => {
				throw new Error("engine gone");
			},
		});
		startThrows.notice.offer(9, { count: 1 });
		await requestConnectionRestart("tok", startThrows.deps).done;
		expect(startThrows.calls.slice(-2)).toEqual(["reconnect", "restarted"]);
	});

	test("production wiring: the stop failure notice says what happened, persists, and clears when a session runs", async () => {
		const notifications = await import("../ui/notifications.ts");
		const { spyOn } = await import("bun:test");
		const {
			CONNECTION_RESTART_FAILED,
			clearRestartFailureNotice,
			connectionRestartDeps,
		} = await import("./connection-restart.ts");
		const shown: Array<{
			name: string;
			type: string;
			duration: number | undefined;
			persistent: boolean | undefined;
			key: string | undefined;
		}> = [];
		const broadcast = spyOn(
			notifications,
			"notificationBroadcast",
		).mockImplementation(
			(name, type, _msg, duration, persistent, _d, _a, key) => {
				shown.push({ name, type, duration, persistent, key });
			},
		);
		const remove = spyOn(
			notifications,
			"notificationRemove",
		).mockImplementation(() => ({ remove: [] }));
		try {
			const conn = {} as unknown as import("ws").default;
			const deps = await connectionRestartDeps(conn, "link-recovery");
			deps.announceFailure("stop");
			deps.announce("new_address");
			deps.announce("reconnected");
			expect(shown).toEqual([
				{
					name: CONNECTION_RESTART_FAILED,
					type: "warning",
					duration: 0,
					persistent: true,
					key: "notifications.connectionRestartStopFailed",
				},
				{
					name: "connection_restarted",
					type: "info",
					duration: 10,
					persistent: false,
					key: "notifications.connectionRestartedNewAddress",
				},
				{
					name: "connection_restarted",
					type: "info",
					duration: 10,
					persistent: false,
					key: "notifications.streamReconnected",
				},
			]);
			clearRestartFailureNotice();
			expect(remove).toHaveBeenCalledWith(CONNECTION_RESTART_FAILED);
		} finally {
			broadcast.mockRestore();
			remove.mockRestore();
		}
	});

	test("production wiring: Stop for reconfigure, then Start from the given origin", async () => {
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
			const conn = {} as unknown as import("ws").default;
			const tap = await connectionRestartDeps(conn, "ui");
			await tap.stop();
			await tap.start();
			expect(stop).toHaveBeenCalledWith("reconfigure");
			expect(start.mock.calls[0]?.[0].origin).toBe("ui");
			// The device's own restart is not the operator's: its own origin, which
			// waits for the modem replay barrier instead of being refused.
			const auto = await connectionRestartDeps(conn, "link-recovery");
			await auto.start();
			expect(start.mock.calls[1]?.[0].origin).toBe("link-recovery");
			// The restart and the reconnect window explain a failed Start themselves.
			expect(start.mock.calls[0]?.[0].quietTerminalFailure).toBe(true);
			expect(start.mock.calls[1]?.[0].quietTerminalFailure).toBe(true);
			const { INTERNAL_LAUNCH_ORIGINS } = await import(
				"./stream-session-contract.ts"
			);
			expect(INTERNAL_LAUNCH_ORIGINS.has("link-recovery")).toBe(true);
			expect(INTERNAL_LAUNCH_ORIGINS.has("ui")).toBe(false);
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
		// Marked as restarting from before Stop until after Start, and announced
		// only once the new session runs.
		expect(f.calls).toEqual([
			"restarting",
			"stop",
			"start",
			"restarted",
			"announce:new_address",
		]);
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

	test("after every link was lost the cooldown neither holds the restart nor starts from it", async () => {
		const f = fixture();
		const a = auto();
		await a.restarts.request(9, f.deps).done;
		a.advance(60_000);
		// Inside the stale-address cooldown, a total loss still restarts, and says
		// the stream reconnected rather than that it took a new address.
		const lost = a.restarts.request(9, f.deps, { totalLoss: true });
		expect(lost.result).toBe("restarting");
		await lost.done;
		expect(f.calls.at(-1)).toBe("announce:reconnected");
		// The stale-address cooldown still counts from the stale-address restart.
		a.advance(239_999);
		expect(a.restarts.request(9, f.deps).result).toBe("held");
		a.advance(1);
		expect(a.restarts.request(9, f.deps).result).toBe("restarting");
	});

	test("a total-loss restart still runs one at a time", async () => {
		const release = Promise.withResolvers<{ result: string }>();
		const f = fixture({ start: () => release.promise });
		const a = auto();
		const first = a.restarts.request(9, f.deps, { totalLoss: true });
		expect(a.restarts.request(9, f.deps, { totalLoss: true }).result).toBe(
			"held",
		);
		release.resolve({ result: "started" });
		await first.done;
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

	test("hands the stream to the reconnect window, and announces nothing, when the new session did not start", async () => {
		const f = fixture({ start: async () => ({ result: "failed" }) });
		expect(await auto().restarts.request(9, f.deps).done).toBe("failed");
		expect(f.calls.some((call) => call.startsWith("announce"))).toBe(false);
		expect(f.calls).toEqual(["restarting", "stop", "reconnect", "restarted"]);
	});

	test("an operator Stop during a failing Start opens no reconnect window", async () => {
		const f = fixture();
		f.deps = {
			...f.deps,
			start: async () => {
				f.operatorStops();
				return { result: "failed" };
			},
		};
		await auto().restarts.request(9, f.deps).done;
		expect(f.calls).toContain("reconnect:unwanted");
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
		expect(f.calls).toEqual(["restarting", "stop", "restarted"]);
	});
});

describe("the restarting status", () => {
	test("is up from before Stop until Start has returned, once for overlapping restarts", async () => {
		const {
			beginConnectionRestart,
			isConnectionRestarting,
			resetConnectionRestartingForTest,
		} = await import("./connection-restarting.ts");
		resetConnectionRestartingForTest();
		const published: boolean[] = [];
		const publish = (on: boolean) => published.push(on);
		const tap = beginConnectionRestart(publish);
		const auto = beginConnectionRestart(publish);
		expect(isConnectionRestarting()).toBe(true);
		tap();
		tap();
		expect(isConnectionRestarting()).toBe(true);
		auto();
		expect(isConnectionRestarting()).toBe(false);
		expect(published).toEqual([true, false]);
	});

	test("drops even when the restart throws", async () => {
		let up = false;
		const f = fixture({
			beginRestart: () => {
				up = true;
				return () => {
					up = false;
				};
			},
			stop: async () => {
				expect(up).toBe(true);
				throw new Error("engine gone");
			},
		});
		f.notice.offer(9, { count: 1 });
		expect(await requestConnectionRestart("tok", f.deps).done).toBe("failed");
		expect(up).toBe(false);
	});
});
