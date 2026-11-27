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

type Conn = { readonly id: string };

/** A fake clock and timer queue, a link list, and a recording of every call. */
function fixture(
	options: {
		readonly enabled?: boolean;
		readonly maxMs?: number;
		readonly links?: string[];
		readonly start?: () => Promise<{ result: string }>;
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
	const starts: Conn[] = [];
	let restarting = 0;
	let nextStart: (() => Promise<{ result: string }>) | undefined =
		options.start;
	const deps: StreamReconnectDeps<Conn> = {
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
		start: (conn) => {
			starts.push(conn);
			calls.push("start");
			return nextStart?.() ?? Promise.resolve({ result: "failed" });
		},
		publish: (status) => published.push(status),
		announceReconnected: () => calls.push("announce:reconnected"),
		announceExpired: (reason, token) =>
			calls.push(`announce:expired:${reason}:${token}`),
		clearExpired: () => calls.push("clear-expired"),
		disarmRestoration: () => calls.push("disarm-restoration"),
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
		starts,
		advance,
		flush,
		conn: { id: "first" } as Conn,
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
		nextStart: (run: () => Promise<{ result: string }>) => {
			nextStart = run;
		},
		attempts: () => calls.filter((call) => call === "start").length,
	};
}

describe("the reconnect window after every link was lost", () => {
	test("a link coming back mid-window starts the stream again at once, and it says so", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed(f.conn);
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
		expect(f.starts).toEqual([f.conn]);
		expect(f.calls.slice(-3)).toEqual([
			"start",
			"restarted",
			"announce:reconnected",
		]);
		expect(f.reconnect.status()).toBeNull();
		expect(f.published.at(-1)).toBeNull();
		expect(f.restarting()).toBe(0);
		expect(f.liveTimers()).toBe(0);
		expect(f.linkListeners()).toBe(0);
	});

	test("a link back within the spacing after the restart's own failed Start waits the spacing out", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(0);
		await f.advance(EDGE_SPACING_MS);
		expect(f.attempts()).toBe(1);
	});

	test("an operator Stop during the window ends it at once, and nothing retries after", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(10_000);
		await f.operatorStop();
		expect(f.reconnect.status()).toBeNull();
		expect(f.published.at(-1)).toBeNull();
		expect(f.restarting()).toBe(0);
		expect(f.linkListeners()).toBe(0);
		await f.setLinks(["10.0.0.2"]);
		await f.advance(300_000);
		expect(f.attempts()).toBe(0);
		// The streamer chose the Stop: no expiry notice, no "reconnected".
		expect(f.calls.some((call) => call.startsWith("announce"))).toBe(false);
	});

	test("an operator Stop during an attempt wins over that attempt's late result", async () => {
		const release = Promise.withResolvers<{ result: string }>();
		const f = fixture({ start: () => release.promise });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(EDGE_SPACING_MS);
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(1);
		await f.operatorStop();
		expect(f.reconnect.status()).toBeNull();
		// The orchestrator cancels that Start; even a result that says started
		// changes nothing here once the streamer stopped.
		release.resolve({ result: "started" });
		await f.flush();
		expect(f.calls).not.toContain("announce:reconnected");
		await f.advance(300_000);
		expect(f.attempts()).toBe(1);
	});

	test("the window runs out after the maximum retry time: the notice stands, restoration is disarmed, nothing retries", async () => {
		const f = fixture({ maxMs: 120_000 });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(119_999);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		await f.advance(1);
		expect(f.reconnect.status()).toEqual({
			state: "expired",
			reason: "no_link",
			token: "tok-1",
		});
		expect(f.calls).toContain("disarm-restoration");
		expect(f.calls).toContain("announce:expired:no_link:tok-1");
		expect(f.restarting()).toBe(0);
		expect(f.linkListeners()).toBe(0);
		const before = f.attempts();
		await f.setLinks(["10.0.0.2"]);
		await f.advance(600_000);
		expect(f.attempts()).toBe(before);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("an expiry with links up says the start failed, not that no link came back", async () => {
		const f = fixture({ links: ["10.0.0.2"] });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(120_000);
		expect(f.reconnect.status()).toMatchObject({
			state: "expired",
			reason: "start_failed",
		});
		// Frozen at expiry: what the streamer was told stays true.
		await f.setLinks([]);
		expect(f.reconnect.status()).toMatchObject({ reason: "start_failed" });
	});

	test("Keep trying after the window ran out opens another full window and tries at once", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(120_000);
		expect(f.reconnect.status()?.state).toBe("expired");
		// The quiet no-link probes of the window that ran out.
		const probes = f.attempts();
		await f.setLinks(["10.0.0.2"]);
		expect(f.attempts()).toBe(probes);
		f.nextStart(async () => ({ result: "started" }));
		const pressing = { id: "pressing" } as Conn;
		expect(f.reconnect.keepTrying("tok-1", pressing)).toBe("reconnecting");
		await f.flush();
		expect(f.calls).toContain("clear-expired");
		expect(f.attempts()).toBe(probes + 1);
		expect(f.starts.at(-1)).toBe(pressing);
		expect(f.calls.at(-1)).toBe("announce:reconnected");
		expect(f.reconnect.status()).toBeNull();
	});

	test("Keep trying after expiry with no link waits a full window for one", async () => {
		const f = fixture({ maxMs: 60_000 });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(60_000);
		await f.advance(30_000);
		expect(f.reconnect.keepTrying("tok-1", f.conn)).toBe("reconnecting");
		expect(f.reconnect.status()).toMatchObject({
			state: "reconnecting",
			remaining_ms: 60_000,
		});
		expect(f.restarting()).toBe(1);
		await f.advance(59_999);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		await f.advance(1);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("Keep trying while reconnecting restarts the full window (A1004 A)", async () => {
		const f = fixture({ maxMs: 120_000 });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(100_000);
		expect(f.reconnect.status()).toMatchObject({ remaining_ms: 20_000 });
		expect(f.reconnect.keepTrying("tok-1", f.conn)).toBe("reconnecting");
		expect(f.reconnect.status()).toMatchObject({ remaining_ms: 120_000 });
		expect(f.published.at(-1)).toMatchObject({ remaining_ms: 120_000 });
		await f.advance(119_999);
		expect(f.reconnect.status()?.state).toBe("reconnecting");
		await f.advance(1);
		expect(f.reconnect.status()?.state).toBe("expired");
		// One restarting status for the whole episode.
		expect(f.calls.filter((call) => call === "restarting")).toHaveLength(1);
	});

	test("Keep trying is refused without a current window, after Stop, or with an old token", async () => {
		const f = fixture();
		expect(f.reconnect.keepTrying("tok-1", f.conn)).toBe("refused");
		f.reconnect.afterRestartStartFailed(f.conn);
		expect(f.reconnect.keepTrying("tok-0", f.conn)).toBe("refused");
		await f.advance(120_000);
		await f.operatorStop();
		expect(f.calls.at(-1)).toBe("clear-expired");
		expect(f.reconnect.status()).toBeNull();
		expect(f.reconnect.keepTrying("tok-1", f.conn)).toBe("refused");
		const before = f.attempts();
		await f.setLinks(["10.0.0.2"]);
		await f.advance(300_000);
		expect(f.attempts()).toBe(before);
	});

	test("an operator Stop after expiry clears the notice and the held state", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(120_000);
		await f.operatorStop();
		expect(f.calls.slice(-1)).toEqual(["clear-expired"]);
		expect(f.published.at(-1)).toBeNull();
	});

	test("links up but the start failing backs off, bounded, with one timer at a time", async () => {
		const f = fixture({ links: ["10.0.0.2"], maxMs: 600_000 });
		f.reconnect.afterRestartStartFailed(f.conn);
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
		expect(f.liveTimers()).toBe(1);
		// 2+2+4+8+16 s, then every 30 s: about 24 attempts in ten minutes.
		await f.advance(600_000);
		expect(f.attempts()).toBeLessThanOrEqual(
			5 + Math.ceil(600_000 / BACKOFF_MAX_MS),
		);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("a new link skips the backoff but not the spacing", async () => {
		const f = fixture({ links: ["10.0.0.2"], maxMs: 600_000 });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(2_000);
		await f.advance(2_000);
		await f.advance(4_000);
		expect(f.attempts()).toBe(3);
		// The next backoff is 8 s away; a new link tries after the 2 s spacing.
		await f.setLinks(["10.0.0.2", "10.0.1.2"]);
		expect(f.attempts()).toBe(3);
		await f.advance(EDGE_SPACING_MS);
		expect(f.attempts()).toBe(4);
	});

	test("with no link, a quiet attempt runs at most once per probe interval", async () => {
		const f = fixture({ maxMs: 120_000 });
		f.reconnect.afterRestartStartFailed(f.conn);
		await f.advance(NO_LINK_PROBE_MS - 1);
		expect(f.attempts()).toBe(0);
		await f.advance(1);
		expect(f.attempts()).toBe(1);
		await f.advance(90_000);
		expect(f.attempts()).toBeLessThanOrEqual(4);
	});

	test("an edge during an attempt is not lost", async () => {
		const release = Promise.withResolvers<{ result: string }>();
		const f = fixture({ start: () => release.promise });
		f.reconnect.afterRestartStartFailed(f.conn);
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

	test("with reconnecting off, nothing retries and the notice with Keep trying stands at once", async () => {
		const f = fixture({ enabled: false });
		f.reconnect.afterRestartStartFailed(f.conn);
		expect(f.reconnect.status()).toMatchObject({ state: "expired" });
		expect(f.restarting()).toBe(0);
		expect(f.calls).toContain("disarm-restoration");
		await f.setLinks(["10.0.0.2"]);
		await f.advance(600_000);
		expect(f.attempts()).toBe(0);
		// "Keep trying" is still the streamer's own choice, and tries at once.
		expect(f.reconnect.keepTrying("tok-1", f.conn)).toBe("reconnecting");
		await f.flush();
		expect(f.attempts()).toBe(1);
	});

	test("turning reconnecting off during a window ends it at its next step", async () => {
		const f = fixture({ links: ["10.0.0.2"] });
		f.reconnect.afterRestartStartFailed(f.conn);
		f.setEnabled(false);
		await f.advance(2_000);
		expect(f.attempts()).toBe(0);
		expect(f.reconnect.status()?.state).toBe("expired");
	});

	test("a session started any other way ends the window", async () => {
		const f = fixture();
		f.reconnect.afterRestartStartFailed(f.conn);
		f.setStreaming(true);
		f.reconnect.noteStreamStarted();
		expect(f.reconnect.status()).toBeNull();
		expect(f.restarting()).toBe(0);
		// While a window ran, the stream is back: that is what it says.
		expect(f.calls.at(-1)).toBe("announce:reconnected");
		// And a start after the window ran out is the streamer's: no word.
		const g = fixture();
		g.reconnect.afterRestartStartFailed(g.conn);
		await g.advance(120_000);
		g.reconnect.noteStreamStarted();
		expect(g.calls).not.toContain("announce:reconnected");
		expect(g.reconnect.status()).toBeNull();
	});

	test("no window opens for a stream that already runs, nor a second one", async () => {
		const f = fixture();
		f.setStreaming(true);
		f.reconnect.afterRestartStartFailed(f.conn);
		expect(f.reconnect.status()).toBeNull();
		f.setStreaming(false);
		f.reconnect.afterRestartStartFailed(f.conn);
		f.reconnect.afterRestartStartFailed({ id: "other" });
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
