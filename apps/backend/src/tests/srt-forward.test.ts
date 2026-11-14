import { expect, test } from "bun:test";
import {
	createSrtForwardController,
	forwardSenderPort,
	forwardUrls,
} from "../modules/ingest/srt-forward-core.ts";
import { CarryingTracker } from "../modules/system/carrying.ts";

test("terminates phone SRT and uses independent relay identity/latency", () => {
	const urls = forwardUrls(
		{ host: "192.168.4.1", port: 4000, passphrase: "phone-secret" },
		{ port: 9000, streamid: "relay&identity", latency: 2000 },
	);
	expect(urls.input).toContain("mode=listener");
	expect(urls.input).toContain("passphrase=phone-secret");
	expect(urls.output).toContain("127.0.0.1:9000");
	expect(urls.output).toContain("streamid=relay%26identity");
	expect(urls.output).toContain("latency=2000");
	expect(urls.output).not.toContain("phone-secret");
});

test("unknown first, admission before spawn, connected AND sender alive, immediate disconnect", async () => {
	const events: unknown[] = [];
	const c = createSrtForwardController({
		report: (s) => events.push(s),
		admit: async () => {
			events.push("admit");
			return () => events.push("release");
		},
		start: async () => {
			events.push("spawn");
			return {
				stop: async () => {
					events.push("stop");
				},
			};
		},
	});
	expect(events).toEqual([null]);
	c.listening();
	await c.publisher(true);
	expect(events).toEqual([null, false, null, "admit", "spawn", true]);
	await c.publisher(false);
	expect(events.slice(-3)).toEqual([false, "stop", "release"]);
	await c.stop();
});

test("refused admission never spawns; fault never grants idle", async () => {
	const states: unknown[] = [];
	let starts = 0;
	const c = createSrtForwardController({
		report: (s) => states.push(s),
		admit: async () => {
			throw Error("busy");
		},
		start: async () => {
			starts++;
			return { stop: async () => {} };
		},
	});
	await expect(c.publisher(true)).rejects.toThrow("busy");
	expect(starts).toBe(0);
	expect(states.at(-1)).toBe(null);
	await c.fault();
	expect(states.at(-1)).toBe(null);
});

test("disconnect during startup retires late sender and releases lease without active evidence", async () => {
	const states: unknown[] = [];
	let ready!: () => void;
	const pending = new Promise<void>((r) => {
		ready = r;
	});
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	let stopped = 0,
		released = 0;
	const c = createSrtForwardController({
		report: (s) => states.push(s),
		admit: async () => () => {
			released++;
		},
		start: async () => {
			entered();
			await pending;
			return {
				stop: async () => {
					stopped++;
				},
			};
		},
	});
	const start = c.publisher(true);
	await started;
	const end = c.publisher(false);
	ready();
	await Promise.all([start, end]);
	expect(states).not.toContain(true);
	expect(stopped).toBe(1);
	expect(released).toBe(1);
});

test("a refused publisher can never feed the encoder sender port", () => {
	expect(forwardSenderPort(9000)).toBe(9001);
	expect(forwardSenderPort(65535)).not.toBe(65535);
	const urls = forwardUrls(
		{ host: "127.0.0.1", port: 4000, passphrase: "phone-secret" },
		{ port: forwardSenderPort(9000), streamid: "relay", latency: 2000 },
	);
	expect(urls.output).toStartWith("srt://127.0.0.1:9001?");
});

test("fault after active cleans owned sender and remains unknown", async () => {
	const states: unknown[] = [];
	let stops = 0,
		releases = 0;
	const c = createSrtForwardController({
		report: (s) => states.push(s),
		admit: async () => () => {
			releases++;
		},
		start: async () => ({
			stop: async () => {
				stops++;
			},
		}),
	});
	await c.publisher(true);
	await c.fault();
	expect(states.at(-1)).toBeNull();
	expect(stops).toBe(1);
	expect(releases).toBe(1);
});

test("late listener readiness cannot replace fault or accepted publisher evidence with idle", async () => {
	const states: unknown[] = [];
	const c = createSrtForwardController({
		report: (s) => states.push(s),
		admit: async () => () => {},
		start: async () => ({ stop: async () => {} }),
	});
	await c.fault();
	c.listening();
	expect(states.at(-1)).toBeNull();
	await c.publisher(true);
	c.listening();
	expect(states.at(-1)).toBe(true);
	await c.stop();
});

test("forwarding evidence preserves startup and disconnect holds in the shared tracker", async () => {
	const tracker = new CarryingTracker();
	let now = 0;
	tracker.start(now);
	const c = createSrtForwardController({
		report: (state) => tracker.session("srt-forward", state, now),
		admit: async () => () => {},
		start: async () => ({ stop: async () => {} }),
	});
	c.listening();
	expect(tracker.read(0)).toBe("unknown");
	expect(tracker.read(119_999)).toBe("unknown");
	expect(tracker.read(120_000)).toBe("idle");
	now = 130_000;
	await c.publisher(true);
	expect(tracker.read(now)).toBe("streaming");
	now = 300_000;
	await c.publisher(false);
	expect(tracker.read(now + 119_999)).toBe("streaming");
	expect(tracker.read(now + 120_000)).toBe("idle");
	expect(tracker.activityAt(now + 120_000)).toBe(now + 120_000);
	await c.stop();
});

test("a forwarding fault stays unknown after the hold; optional RTMP absence cannot clear it", async () => {
	const tracker = new CarryingTracker();
	let now = 0;
	const c = createSrtForwardController({
		report: (state) => tracker.session("srt-forward", state, now),
		admit: async () => () => {},
		start: async () => ({ stop: async () => {} }),
	});
	await c.publisher(true);
	now = 1000;
	await c.fault();
	tracker.session("rtmp-ingest", false, now);
	expect(tracker.read(now)).toBe("streaming");
	expect(tracker.read(now + 120_000)).toBe("unknown");
	now += 120_000;
	await c.stop();
	expect(tracker.read(now)).toBe("idle");
});
