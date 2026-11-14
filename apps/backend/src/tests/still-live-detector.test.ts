import { expect, test } from "bun:test";
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import {
	isLiveNoticeSuppressed,
	type LiveNoticeContext,
	StillLiveDetector,
} from "../modules/streaming/still-live-detector.ts";

function harness() {
	let now = 0;
	let id = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const context: LiveNoticeContext = {
		streaming: true,
		suppressed: false,
		cameraStopped: false,
		selection: "camera:mic",
	};
	const events: Array<[string, boolean]> = [];
	const detector = new StillLiveDetector({
		context: () => context,
		now: () => now,
		publish: (notice, active) => events.push([notice, active]),
		setTimer: (fn, ms) => {
			const key = ++id;
			timers.set(key, { at: now + ms, fn });
			return key as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (timer) => {
			timers.delete(timer as unknown as number);
		},
	});
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			now = next[1].at;
			timers.delete(next[0]);
			next[1].fn();
		}
		now = end;
	};
	const level = (
		silent = true,
		owner: "streaming" | "sidecar" = "streaming",
	): AudioLevelMessage => ({
		source: { owner, identity: "mic" },
		channels: 1,
		peak_db: [silent ? -100 : -12],
		rms_db: [silent ? -100 : -20],
	});
	const audio = (
		ms: number,
		silent = true,
		owner: "streaming" | "sidecar" = "streaming",
	) => {
		detector.update(level(silent, owner));
		for (let elapsed = 0; elapsed < ms; elapsed += 200) {
			advance(Math.min(200, ms - elapsed));
			detector.update(level(silent, owner));
		}
	};
	return { context, events, detector, advance, audio, level, timers };
}

for (const cadence of [4500, 5000, 5500]) {
	test(`one late camera sample at ${cadence} ms never fires, even with audio`, () => {
		const h = harness();
		h.context.cameraStopped = true;
		h.detector.update(undefined, true);
		h.audio(cadence, false);
		expect(h.events).toEqual([]);
		h.context.cameraStopped = false;
		h.detector.update(undefined, true);
		h.audio(12000, false);
		expect(h.events).toEqual([]);
	});
}

test("a scene switch restarts camera confirmation between stalled samples", () => {
	const h = harness();
	h.context.cameraStopped = true;
	h.detector.update(undefined, true);
	h.advance(2500);
	h.context.selection = "another-camera:mic";
	h.detector.update();
	h.advance(2500);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([]);
	h.advance(5000);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([["camera", true]]);
});

test("repeated frame reads cannot manufacture a heartbeat", () => {
	const h = harness();
	h.context.cameraStopped = true;
	h.detector.update(undefined, true);
	h.advance(100);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([]);
	h.advance(4900);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([["camera", true]]);
});

test("ten minutes of jittered stalls and recovery have no single-sample flicker", () => {
	for (let seed = 1; seed <= 100; seed++) {
		const h = harness();
		let random = seed;
		let elapsed = 0;
		let sample = 0;
		while (elapsed < 600000) {
			random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
			const gap = 4500 + (random % 1001);
			h.audio(gap, false);
			elapsed += gap;
			// Isolated losses before a sustained outage; isolated recoveries within it.
			h.context.cameraStopped =
				elapsed < 200000
					? sample % 3 === 0
					: elapsed < 400000
						? sample % 3 !== 0
						: false;
			h.detector.update(undefined, true);
			sample++;
		}
		expect(h.events).toEqual([
			["camera", true],
			["camera", false],
		]);
	}
});

test("camera entry and recovery require fresh, consecutive heartbeat observations", () => {
	const h = harness();
	h.context.cameraStopped = true;
	h.detector.update(undefined, true);
	h.advance(5500);
	expect(h.events).toEqual([]);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([["camera", true]]);
	h.context.cameraStopped = false;
	h.advance(4500);
	h.detector.update(undefined, true);
	expect(h.events).toHaveLength(1);
	h.context.cameraStopped = true;
	h.advance(5000);
	h.detector.update(undefined, true);
	h.context.cameraStopped = false;
	h.advance(5500);
	h.detector.update(undefined, true);
	expect(h.events).toHaveLength(1);
	h.advance(4500);
	h.detector.update(undefined, true);
	expect(h.events.at(-1)).toEqual(["camera", false]);
});

test("a missing heartbeat cannot join two isolated camera observations", () => {
	const h = harness();
	h.context.cameraStopped = true;
	h.detector.update(undefined, true);
	h.advance(12000);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([]);
	h.advance(5000);
	h.detector.update(undefined, true);
	expect(h.events).toEqual([["camera", true]]);
});

test("reset retracts every active notice and cancels its deadlines", () => {
	const h = harness();
	h.context.cameraStopped = true;
	h.detector.update(undefined, true);
	h.audio(5000);
	h.detector.update(undefined, true);
	h.audio(5000);
	expect(h.events).toEqual([
		["camera", true],
		["silence", true],
	]);
	h.detector.reset();
	expect(h.events.slice(-2)).toEqual([
		["camera", false],
		["silence", false],
	]);
	expect(h.timers.size).toBe(0);
	h.advance(60000);
	expect(h.events).toHaveLength(4);
});

test("a meter observation gap resets a silent run before readings resume", () => {
	const h = harness();
	h.audio(6000);
	h.advance(2500);
	h.audio(4000);
	expect(h.events).toEqual([]);
	h.audio(6000);
	expect(h.events).toEqual([["silence", true]]);
});

for (const invalid of [
	{ channels: 0, peak_db: [-100] },
	{ channels: 1, peak_db: [Number.NaN] },
])
	test(`continuous invalid samples cannot prove silence: ${invalid.channels} channels, ${invalid.peak_db}`, () => {
		const h = harness();
		for (let i = 0; i < 70; i++) {
			h.detector.update({ ...h.level(), ...invalid });
			h.advance(200);
		}
		expect(h.events).toEqual([]);
	});

test("silence needs ten seconds of outgoing readings and clears on sound", () => {
	const h = harness();
	h.audio(9800);
	expect(h.events).toEqual([]);
	h.audio(200);
	expect(h.events).toEqual([["silence", true]]);
	h.detector.update(h.level(false));
	expect(h.events.at(-1)).toEqual(["silence", false]);
});
test("a short quiet moment and a scene switch restart the silence hold", () => {
	const h = harness();
	h.audio(6000);
	h.detector.update(h.level(false));
	h.audio(6000);
	expect(h.events).toEqual([]);
	h.context.selection = "other:mic";
	h.detector.update();
	h.audio(9800);
	expect(h.events).toEqual([]);
	h.audio(200);
	expect(h.events).toEqual([["silence", true]]);
});
for (const reason of ["explicit suppression"])
	test(`${reason} suppresses both and clears an existing notice`, () => {
		const h = harness();
		h.context.cameraStopped = true;
		h.detector.update(undefined, true);
		h.audio(5000);
		h.detector.update(undefined, true);
		h.audio(5000);
		expect(h.events).toContainEqual(["silence", true]);
		h.context.suppressed = true;
		h.detector.update();
		expect(h.events).toContainEqual(["camera", false]);
		expect(h.events.at(-1)).toEqual(["silence", false]);
		h.audio(12000);
		expect(h.events.filter((e) => e[1])).toHaveLength(2);
		h.context.suppressed = false;
		h.audio(9800);
		expect(h.events.filter((e) => e[0] === "silence" && e[1])).toHaveLength(1);
	});
test("idle sidecar and unavailable or empty samples cannot establish stream silence", () => {
	const h = harness();
	h.audio(12000, true, "sidecar");
	expect(h.events).toEqual([]);
	h.audio(6000);
	h.detector.update({ unavailable: true, reason: "handoff" });
	h.audio(6000);
	expect(h.events).toEqual([]);
	h.detector.update({ source: { owner: "streaming" }, channels: 0 });
	h.advance(10000);
	expect(h.events).toEqual([]);
});
test("missing and frozen non-silent data never become a false silence claim", () => {
	const h = harness();
	h.audio(6000);
	h.advance(2000);
	h.detector.update(h.level());
	expect(h.events).toEqual([]);
	h.audio(12000, false);
	expect(h.events).toEqual([]);
});
test("stop at the deadline is re-read and clears all timers", () => {
	const h = harness();
	h.context.cameraStopped = true;
	h.detector.update();
	h.context.streaming = false;
	h.advance(10000);
	expect(h.events).toEqual([]);
	expect(h.timers.size).toBe(0);
	h.detector.reset();
});

test("absent or invalid channel measurements are unknown, not silent", () => {
	const h = harness();
	for (const peak_db of [undefined, [], [Number.NaN]]) {
		h.detector.update({ source: { owner: "streaming" }, channels: 1, peak_db });
		h.advance(12000);
	}
	expect(h.events).toEqual([]);
});

test("known virtual and standby outputs suppress input alarms", () => {
	const active = {
		codec: "h264",
		resolution: "1920x1080",
		framerate: 30,
		active_input: "camera",
	};
	expect(isLiveNoticeSuppressed(false, active)).toBe(false);
	expect(isLiveNoticeSuppressed(true, active)).toBe(true);
	expect(
		isLiveNoticeSuppressed(false, {
			...active,
			active_input: "standby",
		}),
	).toBe(true);
	expect(
		isLiveNoticeSuppressed(false, {
			...active,
			capture: {
				state: "standby",
				live_inputs: [],
				degraded_inputs: [],
				failover_rate_policy: "retime",
			},
		}),
	).toBe(true);
});

test("intentional audio-only mute suppresses silence without hiding a camera outage", () => {
	const h = harness();
	h.context.audioSuppressed = true;
	h.context.cameraStopped = true;
	h.detector.update(undefined, true);
	h.audio(5000);
	h.detector.update(undefined, true);
	h.audio(7000);
	expect(h.events).toEqual([["camera", true]]);
	h.context.audioSuppressed = false;
	h.audio(9800);
	expect(h.events).toEqual([["camera", true]]);
	h.audio(200);
	expect(h.events.at(-1)).toEqual(["silence", true]);
});
