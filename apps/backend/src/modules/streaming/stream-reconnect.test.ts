import { describe, expect, test } from "bun:test";

import {
	BACKOFF_MAX_MS,
	createStreamReconnect,
	EDGE_SPACING_MS,
	NO_LINK_PROBE_MS,
	reconnectSettings,
	type StreamReconnectDeps,
	type StreamReconnectStatus,
} from "./stream-reconnect.ts";

type StartResult = { result: string };

/** A fake clock and timer queue, a link list, and a recording of every call. */
function fixture(
	options: {
		readonly enabled?: boolean;
		readonly maxMs?: number;
		readonly links?: string[];
		readonly start?: () => Promise<StartResult>;
	} = {},
) {
	let clock = 1_000;
	let timers: Array<{ at: number; run: () => void; live: boolean }> = [];
	let links = [...(options.links ?? [])];
	let enabled = options.enabled ?? true;
	let streaming = false;
	let tokens = 0;
	const linkListeners = new Set<() => void>();
	const stopListeners = new Set<() => void>();
	const calls: string[] = [];
	const published: Array<StreamReconnectStatus | null> = [];
	const wanted: Array<() => boolean> = [];
	let restarting = 0;
	let nextStart: (() => Promise<StartResult>) | undefined = options.start;
	const deps: StreamReconnectDeps = {
		now: () => clock,
		schedule: (run, ms) => {
			const timer = { at: clock + ms, run, live: true };
			timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
		token: () => `tok-${++tokens}`,
		settings: () => ({ enabled, maxMs: options.maxMs ?? 120_000 }),
		linkSources: () => links,
		onLinkChange: (listener) => {
			linkListeners.add(listener);
			return () => linkListeners.delete(listener);
		},
		onOperatorStop: (listener) => {
			stopListeners.add(listener);
			return () => stopListeners.delete(listener);
		},
		isStreaming: () => streaming,
		beginRestart: () => {
			restarting++;
			calls.push("restarting");
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				restarting--;
				calls.push("restarted");
			};
		},
		start: (stillWanted) => {
			wanted.push(stillWanted);
			calls.push("start");
			return nextStart?.() ?? Promise.resolve({ result: "failed" });
		},
		publish: (status) => {
			published.push(status);
			calls.push(`publish:${status?.state ?? "none"}`);
		},
		announceReconnected: () => calls.push("announce:reconnected"),
		announceExpired: (reason, token) =>
			calls.push(`announce:expired:${reason}:${token}`),
		clearExpired: () => calls.push("clear-expired"),
		disarmRestoration: () => calls.push("disarm-restoration"),
		rearmRestoration: () => calls.push("rearm-restoration"),
		log: () => {},
	};
	const reconnect = createStreamReconnect(deps);
	const flush = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	/** Moves the clock, running every timer that falls due, in order. */
	const advance = async (ms: number) => {
		const until = clock + ms;
		for (;;) {
			const due = timers
				.filter((timer) => timer.live && timer.at <= until)
				.sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			clock = due.at;
			due.live = false;
			due.run();
			await flush();
		}
		clock = until;
		timers = timers.filter((timer) => timer.live);
		await flush();
	};
	return {
		reconnect,
		calls,
		published,
		wanted,
		advance,
		flush,
		liveTimers: () => timers.filter((timer) => timer.live).length,
		restarting: () => restarting,
		linkListeners: () => linkListeners.size,
		setLinks: async (next: string[]) => {
			links = next;
			for (const listener of [...linkListeners]) listener();
			await flush();
		},
		operatorStop: async () => {
			for (const listener of [...stopListeners]) listener();
			await flush();
		},
		setStreaming: (on: boolean) => {
			streaming = on;
		},
		setEnabled: (on: boolean) => {
			enabled = on;
		},
		nextStart: (run: () => Promise<StartResult>) => {
			nextStart = run;
		},
		attempts: () => calls.filter((call) => call === "start").length,
		/** The window opened after a restart for every link lost. */
		lose: () => reconnect.afterRestartStartFailed({ totalLoss: true }),
	};
}

describe("the reconnect window after every link was lost", () => {
	test("a link coming back mid-window starts the stream again, and it says so", async () => {
		const f = fixture();
		f.lose();
		expect(f.restarting()).toBe(1);
		expect(f.reconnect.status()).toEqual({
			state: "reconnecting",
			remaining_ms: 120_000,
			token: "tok-1",
		});
		// No link: nothing to try yet.
		await f.advance(5_000);
		expect(f.attempts()).toBe(0);
		f.nextStart(async () => ({ result: "started" }));
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(1);
		expect(f.calls.slice(-4)).toEqual([
			"start",
			"restarted",
			"publish:none",
			"announce:reconnected",
		]);
		expect(f.reconnect.status()).toBeNull();
		expect(f.restarting()).toBe(0);
		expect(f.liveTimers()).toBe(0);
		expect(f.linkListeners()).toBe(0);
	});

	test("a link back within the spacing after the restart's own failed Start waits the spacing out", async () => {
		const f = fixture();
		f.lose();
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(0);
		await f.advance(EDGE_SPACING_MS);
		expect(f.attempts()).toBe(1);
	});

	test("an operator Stop during the window ends it at once, and nothing retries after", async () => {
		const f = fixture();
		f.lose();
		await f.advance(10_000);
		await f.operatorStop();
		expect(f.reconnect.status()).toBeNull();
		expect(f.published.at(-1)).toBeNull();
		expect(f.restarting()).toBe(0);
		expect(f.linkListeners()).toBe(0);
		expect(f.liveTimers()).toBe(0);
		await f.setLinks(["10.0.0.2"]);
		await f.advance(300_000);
		expect(f.attempts()).toBe(0);
		// The streamer chose the Stop: no expiry notice, no "reconnected".
		expect(f.calls.some((call) => call.startsWith("announce"))).toBe(false);
	});

	test("an operator Stop during an attempt tells that Start not to start, and wins over its late result", async () => {
		const release = Promise.withResolvers<StartResult>();
		const f = fixture({ start: () => release.promise });
		f.lose();
		await f.advance(EDGE_SPACING_MS);
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(1);
		expect(f.wanted[0]?.()).toBe(true);
		await f.operatorStop();
		// The Start checks this after its last await, before the supervisor.
		expect(f.wanted[0]?.()).toBe(false);
		expect(f.reconnect.status()).toBeNull();
		release.resolve({ result: "started" });
		await f.flush();
		expect(f.calls).not.toContain("announce:reconnected");
		await f.advance(300_000);
		expect(f.attempts()).toBe(1);
	});

	test("the window runs out after the maximum retry time: the end state is published before the restarting flag drops, restoration is disarmed, nothing retries", async () => {
		const f = fixture({ maxMs: 120_000 });
		f.lose();
		await f.advance(119_999);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		await f.advance(1);
		expect(f.reconnect.status()).toEqual({
			state: "expired",
			reason: "no_link",
			token: "tok-1",
		});
		expect(f.calls.slice(-4)).toEqual([
			"disarm-restoration",
			"announce:expired:no_link:tok-1",
			"publish:expired",
			"restarted",
		]);
		expect(f.restarting()).toBe(0);
		expect(f.linkListeners()).toBe(0);
		expect(f.liveTimers()).toBe(0);
		const before = f.attempts();
		await f.setLinks(["10.0.0.2"]);
		await f.advance(600_000);
		expect(f.attempts()).toBe(before);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("an expiry with links up says the start failed, and keeps saying it", async () => {
		const f = fixture({ links: ["10.0.0.2"] });
		f.lose();
		await f.advance(120_000);
		expect(f.reconnect.status()).toMatchObject({
			state: "expired",
			reason: "start_failed",
		});
		await f.setLinks([]);
		expect(f.reconnect.status()).toMatchObject({ reason: "start_failed" });
	});

	test("an attempt running at the deadline may finish: no new attempt starts, its failure ends the window", async () => {
		const release = Promise.withResolvers<StartResult>();
		const f = fixture({ maxMs: 60_000, links: ["10.0.0.2"] });
		f.lose();
		await f.advance(58_000);
		const before = f.attempts();
		f.nextStart(() => release.promise);
		await f.advance(1_999);
		await f.setLinks(["10.0.0.2", "10.0.1.2"]);
		await f.advance(10);
		// Deadline passed with an attempt in flight: still reconnecting, 0 left.
		expect(f.reconnect.status()).toMatchObject({
			state: "reconnecting",
			remaining_ms: 0,
		});
		const running = f.attempts();
		expect(running).toBeGreaterThan(before);
		// A new link after the deadline starts nothing.
		await f.setLinks(["10.0.0.2", "10.0.1.2", "10.0.2.2"]);
		await f.advance(60_000);
		expect(f.attempts()).toBe(running);
		release.resolve({ result: "failed" });
		await f.flush();
		expect(f.reconnect.status()?.state).toBe("expired");
		expect(f.attempts()).toBe(running);
	});

	test("an attempt running at the deadline that starts the stream brings it back", async () => {
		const release = Promise.withResolvers<StartResult>();
		const f = fixture({ maxMs: 30_000, links: ["10.0.0.2"] });
		f.lose();
		await f.advance(28_000);
		f.nextStart(() => release.promise);
		const before = f.attempts();
		await f.setLinks(["10.0.0.2", "10.0.1.2"]);
		expect(f.attempts()).toBe(before + 1);
		await f.advance(2_000);
		expect(f.reconnect.status()).toMatchObject({ remaining_ms: 0 });
		release.resolve({ result: "started" });
		await f.flush();
		expect(f.reconnect.status()).toBeNull();
		expect(f.calls.at(-1)).toBe("announce:reconnected");
	});

	test("Keep trying after the window ran out opens another full window under a new token, rearms restoration and tries at once", async () => {
		const f = fixture();
		f.lose();
		await f.advance(120_000);
		expect(f.reconnect.status()?.state).toBe("expired");
		const probes = f.attempts();
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(probes);
		f.nextStart(async () => ({ result: "started" }));
		expect(f.reconnect.keepTrying("tok-1")).toBe("reconnecting");
		expect(f.calls).toContain("clear-expired");
		expect(f.calls).toContain("rearm-restoration");
		await f.flush();
		expect(f.attempts()).toBe(probes + 1);
		expect(f.calls.at(-1)).toBe("announce:reconnected");
		expect(f.reconnect.status()).toBeNull();
	});

	test("Keep trying after expiry with no link waits a full window for one", async () => {
		const f = fixture({ maxMs: 60_000 });
		f.lose();
		await f.advance(60_000);
		await f.advance(30_000);
		expect(f.reconnect.keepTrying("tok-1")).toBe("reconnecting");
		expect(f.reconnect.status()).toMatchObject({
			state: "reconnecting",
			remaining_ms: 60_000,
			token: "tok-2",
		});
		expect(f.restarting()).toBe(1);
		await f.advance(59_999);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		await f.advance(1);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("Keep trying while reconnecting restarts the full window with a new token, so every client sees the new countdown (A1004 A)", async () => {
		const f = fixture({ maxMs: 120_000 });
		f.lose();
		expect(f.published.at(-1)).toMatchObject({ remaining_ms: 120_000 });
		// Pressed before any time passed: same remaining time, still a new frame.
		expect(f.reconnect.keepTrying("tok-1")).toBe("reconnecting");
		expect(f.published.at(-1)).toMatchObject({
			remaining_ms: 120_000,
			token: "tok-2",
		});
		await f.advance(100_000);
		expect(f.reconnect.keepTrying("tok-1")).toBe("refused");
		expect(f.reconnect.keepTrying("tok-2")).toBe("reconnecting");
		expect(f.reconnect.status()).toMatchObject({ remaining_ms: 120_000 });
		await f.advance(119_999);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		await f.advance(1);
		expect(f.reconnect.status()?.state).toBe("expired");
		// One restarting status for the whole episode.
		expect(f.calls.filter((call) => call === "restarting")).toHaveLength(1);
	});

	test("Keep trying is refused without a current window, after Stop, or with an old token", async () => {
		const f = fixture();
		expect(f.reconnect.keepTrying("tok-1")).toBe("refused");
		f.lose();
		expect(f.reconnect.keepTrying("tok-0")).toBe("refused");
		await f.advance(120_000);
		await f.operatorStop();
		expect(f.calls.at(-2)).toBe("clear-expired");
		expect(f.reconnect.status()).toBeNull();
		expect(f.reconnect.keepTrying("tok-1")).toBe("refused");
		const before = f.attempts();
		await f.setLinks(["10.0.0.2"]);
		await f.advance(300_000);
		expect(f.attempts()).toBe(before);
	});

	test("links up but the start failing backs off, bounded, with one retry timer and the deadline", async () => {
		const f = fixture({ links: ["10.0.0.2"], maxMs: 600_000 });
		f.lose();
		// Edges that bring no new link change nothing.
		for (let i = 0; i < 50; i++) await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(0);
		await f.advance(2_000);
		expect(f.attempts()).toBe(1);
		await f.advance(2_000);
		expect(f.attempts()).toBe(2);
		await f.advance(4_000);
		expect(f.attempts()).toBe(3);
		await f.advance(8_000);
		expect(f.attempts()).toBe(4);
		expect(f.liveTimers()).toBe(2);
		// 2+2+4+8+16 s, then every 30 s: about 24 attempts in ten minutes.
		await f.advance(600_000);
		expect(f.attempts()).toBeLessThanOrEqual(
			5 + Math.ceil(600_000 / BACKOFF_MAX_MS),
		);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("a new link skips the backoff but not the spacing", async () => {
		const f = fixture({ links: ["10.0.0.2"], maxMs: 600_000 });
		f.lose();
		await f.advance(2_000);
		await f.advance(2_000);
		await f.advance(4_000);
		expect(f.attempts()).toBe(3);
		await f.setLinks(["10.0.0.2", "10.0.1.2"]);
		expect(f.attempts()).toBe(3);
		await f.advance(EDGE_SPACING_MS);
		expect(f.attempts()).toBe(4);
	});

	test("with no link, a quiet attempt runs at most once per probe interval, a third of a short window", async () => {
		const f = fixture({ maxMs: 120_000 });
		f.lose();
		await f.advance(NO_LINK_PROBE_MS - 1);
		expect(f.attempts()).toBe(0);
		await f.advance(1);
		expect(f.attempts()).toBe(1);
		await f.advance(90_000);
		expect(f.attempts()).toBeLessThanOrEqual(4);
		const short = fixture({ maxMs: 30_000 });
		short.lose();
		await short.advance(10_000);
		expect(short.attempts()).toBe(1);
	});

	test("an edge during an attempt is not lost", async () => {
		const release = Promise.withResolvers<StartResult>();
		const f = fixture({ start: () => release.promise });
		f.lose();
		await f.advance(EDGE_SPACING_MS);
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(1);
		await f.setLinks(["10.0.0.2", "10.0.1.2"]);
		expect(f.attempts()).toBe(1);
		f.nextStart(async () => ({ result: "started" }));
		release.resolve({ result: "failed" });
		await f.flush();
		await f.advance(EDGE_SPACING_MS);
		expect(f.attempts()).toBe(2);
		expect(f.calls.at(-1)).toBe("announce:reconnected");
	});

	test("with reconnecting off, nothing retries, and the end state with Keep trying stands at once", async () => {
		const f = fixture({ enabled: false });
		f.lose();
		expect(f.reconnect.status()).toMatchObject({ state: "expired" });
		expect(f.restarting()).toBe(0);
		expect(f.calls).toContain("disarm-restoration");
		await f.setLinks(["10.0.0.2"]);
		await f.advance(600_000);
		expect(f.attempts()).toBe(0);
	});

	test("Keep trying is the streamer's own window: with reconnecting off it still runs the full time", async () => {
		const f = fixture({ enabled: false, maxMs: 120_000 });
		f.lose();
		expect(f.reconnect.keepTrying("tok-1")).toBe("reconnecting");
		await f.advance(NO_LINK_PROBE_MS);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		f.nextStart(async () => ({ result: "started" }));
		await f.advance(EDGE_SPACING_MS);
		await f.setLinks(["10.0.0.2"]);
		expect(f.calls.at(-1)).toBe("announce:reconnected");
	});

	test("turning reconnecting off during an automatic window ends it at its next step, a link edge included", async () => {
		const f = fixture({ links: ["10.0.0.2"] });
		f.lose();
		f.setEnabled(false);
		await f.advance(2_000);
		expect(f.attempts()).toBe(0);
		expect(f.reconnect.status()?.state).toBe("expired");
		const g = fixture();
		g.lose();
		await g.advance(EDGE_SPACING_MS);
		g.setEnabled(false);
		await g.setLinks(["10.0.0.2"]);
		expect(g.attempts()).toBe(0);
		expect(g.reconnect.status()?.state).toBe("expired");
	});

	test("a restart that failed for another reason while links are up does not retry on its own", async () => {
		const f = fixture({ links: ["10.0.0.2"] });
		f.reconnect.afterRestartStartFailed({ totalLoss: false });
		expect(f.reconnect.status()).toMatchObject({
			state: "expired",
			reason: "start_failed",
		});
		await f.advance(600_000);
		expect(f.attempts()).toBe(0);
		// The streamer can still choose to keep trying.
		expect(f.reconnect.keepTrying("tok-1")).toBe("reconnecting");
		await f.flush();
		expect(f.attempts()).toBe(1);
	});

	test("a restart whose Start found no link left opens the window, whatever started it", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed({ totalLoss: false });
		expect(f.reconnect.status()?.state).toBe("reconnecting");
	});

	test("a session started any other way ends the window", async () => {
		const f = fixture();
		f.lose();
		f.setStreaming(true);
		f.reconnect.noteStreamStarted();
		expect(f.reconnect.status()).toBeNull();
		expect(f.restarting()).toBe(0);
		expect(f.calls.at(-1)).toBe("announce:reconnected");
		// A start after the window ran out is the streamer's: no word.
		const g = fixture();
		g.lose();
		await g.advance(120_000);
		g.reconnect.noteStreamStarted();
		expect(g.calls).not.toContain("announce:reconnected");
		expect(g.reconnect.status()).toBeNull();
	});

	test("no window opens for a stream that already runs, nor a second one", async () => {
		const f = fixture();
		f.setStreaming(true);
		f.lose();
		expect(f.reconnect.status()).toBeNull();
		f.setStreaming(false);
		f.lose();
		f.lose();
		expect(f.reconnect.status()).toMatchObject({ token: "tok-1" });
		expect(f.restarting()).toBe(1);
	});
});

describe("reconnect settings", () => {
	test("default on, two minutes, and bounded", () => {
		expect(reconnectSettings({})).toEqual({ enabled: true, maxMs: 120_000 });
		expect(reconnectSettings({ auto_reconnect: false })).toEqual({
			enabled: false,
			maxMs: 120_000,
		});
		expect(reconnectSettings({ auto_reconnect_max_s: 300 }).maxMs).toBe(
			300_000,
		);
		expect(reconnectSettings({ auto_reconnect_max_s: 1 }).maxMs).toBe(30_000);
		expect(reconnectSettings({ auto_reconnect_max_s: 99_999 }).maxMs).toBe(
			3_600_000,
		);
		expect(reconnectSettings({ auto_reconnect_max_s: Number.NaN }).maxMs).toBe(
			120_000,
		);
	});
});
