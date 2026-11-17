/**
 * The OTA marker owner as a state machine, over every interleaving.
 *
 * Three reviews found orderings in which the file said "carrying only" beside
 * a live stream, or an empty file outlived the Start that emptied it. All are
 * properties of one small machine: holders (carrying, a stream), one file and
 * a clock. This walks every sequence of holder changes, write failures, ticks
 * and backend restarts up to a fixed depth on an in-memory file and checks
 * after each step what a replacement backend would conclude.
 */
import { expect, test } from "bun:test";
import {
	CARRYING_LINE_FRESH_SECONDS,
	createOtaMarkerOwner,
} from "../modules/streaming/ota-streaming-marker.ts";

const PATH = "/run/test/streaming";
const LINE = /^carrying (\d+)\n$/;
const TICK_SECONDS = 5;
const TICKS_PAST_FRESH = CARRYING_LINE_FRESH_SECONDS / TICK_SECONDS + 1;
type Mode = "ok" | "file-readonly" | "readonly";

function fault(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/** One directory with a marker and its temporary sibling. */
function memoryFs() {
	const files = new Map<string, string>();
	const disk = { files, mode: "ok" as Mode };
	const writable = (path: string) =>
		disk.mode === "ok" || (disk.mode === "file-readonly" && !files.has(path));
	const fs = {
		lstatSync: (path: string) => {
			if (!files.has(path)) throw fault("ENOENT");
			return {};
		},
		readFileSync: (path: string) => {
			const content = files.get(path);
			if (content === undefined) throw fault("ENOENT");
			return content;
		},
		writeFileSync: (
			path: string,
			data: string,
			options?: { flag?: string },
		) => {
			if (!writable(path)) throw fault("EROFS");
			files.set(
				path,
				options?.flag === "a" ? (files.get(path) ?? "") + data : data,
			);
		},
		renameSync: (from: string, to: string) => {
			if (disk.mode === "readonly") throw fault("EROFS");
			const content = files.get(from);
			if (content === undefined) throw fault("ENOENT");
			files.delete(from);
			files.set(to, content);
		},
		rmSync: (path: string) => {
			if (!files.has(path)) return;
			if (disk.mode === "readonly") throw fault("EROFS");
			files.delete(path);
		},
	};
	return {
		disk,
		fs: fs as unknown as Parameters<typeof createOtaMarkerOwner>[0]["fs"],
	};
}

const EVENTS = [
	"carrying-on",
	"carrying-off",
	"start",
	"adopt",
	"confirmed-idle",
	"tick",
	"ticks-past-fresh",
	"restart",
	"slow-restart",
	"disk-ok",
	"disk-file-readonly",
	"disk-readonly",
] as const;
type Event = (typeof EVENTS)[number];

function world() {
	const { disk, fs } = memoryFs();
	const clock = { uptime: 1000 };
	const boot = () =>
		createOtaMarkerOwner({
			path: () => PATH,
			fs,
			setShutdownProtection: () => true,
			uptime: () => clock.uptime,
			quiet: true,
		});
	return {
		disk,
		clock,
		boot,
		owner: boot(),
		carrying: false,
		// Ground truth the file must never contradict.
		streamMayBeLive: false,
		// The base already launches when no marker can be written at all.
		unmarked: false,
		// An adopted stream cannot be refused; its line may stand until it
		// goes stale or the file can be written.
		adoptedBesideLine: false,
		// This backend found a marker it cannot explain and holds it as a
		// possible stream until a confirmed idle.
		suspects: false,
		// The exposure happened: a backend restarted inside the fresh bound
		// beside an adopted stream whose marker could not be written. Nothing
		// on disk can tell the successor; the walk stops judging this world.
		misled: false,
		faulted: false,
	};
}
type World = ReturnType<typeof world>;

const stamp = (w: World) => {
	const found = LINE.exec(w.disk.files.get(PATH) ?? "")?.[1];
	return found === undefined ? undefined : Number(found);
};
const lineAge = (w: World) => {
	const at = stamp(w);
	return at === undefined ? undefined : w.clock.uptime - at;
};
const lineIsFresh = (w: World) => {
	const age = lineAge(w);
	return age !== undefined && age >= 0 && age <= CARRYING_LINE_FRESH_SECONDS;
};

function tick(w: World) {
	w.clock.uptime += TICK_SECONDS;
	w.owner.tick();
}

function restart(w: World, seconds: number) {
	// The process dies: its holders are gone; file, engine and clock go on.
	w.clock.uptime += seconds;
	w.misled ||= w.streamMayBeLive && w.adoptedBesideLine && lineIsFresh(w);
	w.suspects = w.disk.files.has(PATH) && !lineIsFresh(w) && !w.streamMayBeLive;
	w.owner = w.boot();
	w.carrying = false;
}

/** False when the event cannot happen in this state. */
function apply(w: World, event: Event): boolean {
	switch (event) {
		case "carrying-on":
			if (w.carrying) return false;
			w.carrying = true;
			w.owner.setCarrying(true);
			return true;
		case "carrying-off":
			if (!w.carrying) return false;
			w.carrying = false;
			w.owner.setCarrying(false);
			return true;
		case "start":
			// Admission's last step and the launch are one tick; a refused claim
			// launches nothing. A session that suspects a stream answers busy.
			if (w.streamMayBeLive || w.suspects) return false;
			if (!w.owner.claimForLaunch()) return true;
			w.owner.takeEncoder();
			w.streamMayBeLive = true;
			w.unmarked = !w.disk.files.has(PATH);
			return true;
		case "adopt":
			// Reconciliation finds a stream this backend did not launch.
			if (w.streamMayBeLive) return false;
			w.owner.takeEncoder();
			w.streamMayBeLive = true;
			w.suspects = false;
			w.unmarked = !w.disk.files.has(PATH);
			w.adoptedBesideLine = stamp(w) !== undefined;
			return true;
		case "confirmed-idle":
			// An acknowledged Stop: whatever ran is over.
			w.owner.releaseEncoder();
			w.streamMayBeLive = false;
			w.unmarked = false;
			w.adoptedBesideLine = false;
			w.suspects = false;
			return true;
		case "tick":
			tick(w);
			return true;
		case "ticks-past-fresh":
			for (let n = 0; n < TICKS_PAST_FRESH; n++) tick(w);
			return true;
		case "restart":
			// Measured on a device: 2 s from stop to the new backend.
			restart(w, 2);
			return true;
		case "slow-restart":
			restart(w, CARRYING_LINE_FRESH_SECONDS + 1);
			return true;
		default: {
			const mode = event.slice("disk-".length) as Mode;
			if (w.disk.mode === mode) return false;
			w.disk.mode = mode;
			if (mode !== "ok") w.faulted = true;
			return true;
		}
	}
}

function check(w: World, path: readonly Event[]) {
	const content = w.disk.files.get(PATH);
	const replacement = w.boot().liveness();
	const where = path.join(" > ");
	const fail = (what: string) => {
		throw new Error(`${what}: ${where}`);
	};
	if (w.misled) return;
	if (stamp(w) === undefined) w.adoptedBesideLine = false;

	// Safety, under every write failure.
	if (w.streamMayBeLive && !w.unmarked) {
		if (stamp(w) !== undefined && !w.adoptedBesideLine)
			fail("carrying line beside a launched or marked stream");
		// The one exposure: an adopted stream whose marker could not be written.
		// It ends when the line goes stale, without any write.
		if (replacement !== "unknown" && !(w.adoptedBesideLine && lineIsFresh(w)))
			fail("replacement backend reads a stream as idle");
		// The line beside a stream is never refreshed.
		if (w.adoptedBesideLine && path.at(-1) === "ticks-past-fresh")
			if (lineIsFresh(w)) fail("line beside an adopted stream stayed fresh");
		// And it is gone at the first tick that can write.
		if (w.disk.mode === "ok" && path.at(-1)?.startsWith("tick"))
			if (content !== "") fail("tick left a stream's marker unemptied");
	}
	if (w.faulted) return;

	// With a working disk the file is exactly what the holders justify.
	if (w.streamMayBeLive) {
		if (content !== "") fail(`stream marker is ${JSON.stringify(content)}`);
		return;
	}
	if (w.suspects) {
		// Fails safe, as before this change: unknown until a confirmed idle.
		if (content === undefined) fail("suspected marker vanished");
		if (w.owner.liveness() !== "unknown") fail("stale marker trusted");
		return;
	}
	if (w.carrying) {
		if (lineAge(w) !== 0) fail(`carrying's line is ${JSON.stringify(content)}`);
		// The symptom this exists to remove: no stream, and yet the next
		// backend cannot reach idle.
		if (replacement !== "idle")
			fail("replacement backend stuck without a stream");
	} else if (content !== undefined && stamp(w) === undefined)
		fail(`nobody holds ${JSON.stringify(content)}`);
	if (w.owner.liveness() !== "idle")
		fail("this backend misreads its own marker");
}

function walk(depth: number): number {
	let sequences = 0;
	const visit = (path: Event[]) => {
		if (path.length === depth) return;
		for (const event of EVENTS) {
			const next = [...path, event];
			const w = world();
			let possible = true;
			for (const step of next) possible &&= apply(w, step);
			if (!possible) continue;
			sequences++;
			check(w, next);
			visit(next);
		}
	};
	visit([]);
	return sequences;
}

test("every interleaving of holders, write failures, ticks and restarts keeps the marker truthful", () => {
	expect(walk(6)).toBeGreaterThan(100_000);
}, 180_000);

function after(...steps: Event[]) {
	const w = world();
	for (const step of steps) expect(apply(w, step)).toBe(true);
	return w;
}

test("a restart beside a live carrying hold reaches idle", () => {
	const w = after("carrying-on", "tick", "restart");
	expect(w.owner.liveness()).toBe("idle");
	apply(w, "carrying-on");
	apply(w, "carrying-off");
	expect(w.disk.files.has(PATH)).toBe(false);
});

test("an adopted stream that cannot be marked is exposed only while the line is fresh", () => {
	const w = after("carrying-on", "disk-readonly", "adopt");
	expect(stamp(w)).toBeDefined();
	// The documented exposure: a crash right now, with the fault then gone.
	expect(w.boot().liveness()).toBe("idle");
	apply(w, "ticks-past-fresh");
	expect(stamp(w)).toBe(1000);
	expect(w.boot().liveness()).toBe("unknown");
	apply(w, "disk-ok");
	apply(w, "tick");
	expect(w.disk.files.get(PATH)).toBe("");
});

test("only a restart inside the fresh bound beside an unmarkable adopted stream misleads", () => {
	// Every world the walk stops judging got there this one way.
	const fresh = after("carrying-on", "disk-readonly", "adopt", "restart");
	expect(fresh.misled).toBe(true);
	const stale = after("carrying-on", "disk-readonly", "adopt", "slow-restart");
	expect(stale.misled).toBe(false);
	expect(stale.owner.liveness()).toBe("unknown");
	const launched = after("carrying-on", "disk-readonly", "start", "restart");
	expect(launched.misled).toBe(false);
	expect(launched.streamMayBeLive).toBe(false);
});

test("the walk catches a carrying line beside a launched stream", () => {
	const w = after("carrying-on", "start");
	w.disk.files.set(PATH, "carrying 1000\n");
	expect(() => check(w, ["start"])).toThrow("carrying line beside");
});
