/**
 * The OTA marker owner as a state machine, over every interleaving.
 *
 * Two reviews found orderings in which the file said "carrying only" beside a
 * live stream, or an empty file outlived the Start that emptied it. Both are
 * properties of one small machine: holders (carrying, a stream) and one file. This walks every sequence of holder changes, write
 * failures and backend restarts up to a fixed depth on an in-memory file and
 * checks after each step what a replacement backend would conclude.
 */
import { expect, test } from "bun:test";
import { createOtaMarkerOwner } from "../modules/streaming/ota-streaming-marker.ts";

const PATH = "/run/test/streaming";
const LINE = "carrying\n";
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
	"confirmed-idle",
	"restart",
	"disk-ok",
	"disk-file-readonly",
	"disk-readonly",
] as const;
type Event = (typeof EVENTS)[number];

function world() {
	const { disk, fs } = memoryFs();
	const boot = () =>
		createOtaMarkerOwner({
			path: () => PATH,
			fs,
			setShutdownProtection: () => true,
			quiet: true,
		});
	return {
		disk,
		boot,
		owner: boot(),
		carrying: false,
		// Ground truth the file must never contradict.
		streamMayBeLive: false,
		// The base already launches when no marker can be written at all.
		launchedUnmarked: false,
		faulted: false,
		// A replacement backend has not taken its own carrying hold yet.
		inherited: false,
	};
}
type World = ReturnType<typeof world>;

/** False when the event cannot happen in this state. */
function apply(w: World, event: Event): boolean {
	switch (event) {
		case "carrying-on":
			if (w.carrying) return false;
			w.carrying = true;
			w.inherited = false;
			w.owner.setCarrying(true);
			return true;
		case "carrying-off":
			if (!w.carrying) return false;
			w.carrying = false;
			w.owner.setCarrying(false);
			return true;
		case "start":
			// Admission's last step and the launch are one tick; a refused claim
			// launches nothing.
			if (w.streamMayBeLive) return false;
			if (!w.owner.claimForLaunch()) return true;
			w.inherited = false;
			w.owner.takeEncoder();
			w.streamMayBeLive = true;
			w.launchedUnmarked = !w.disk.files.has(PATH);
			return true;
		case "confirmed-idle":
			// An acknowledged Stop: whatever ran is over.
			w.owner.releaseEncoder();
			w.inherited = false;
			w.streamMayBeLive = false;
			w.launchedUnmarked = false;
			return true;
		case "restart":
			// The process dies: its holders are gone, the file and the engine stay.
			w.inherited = w.disk.files.has(PATH);
			w.owner = w.boot();
			w.carrying = false;
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
	// Safety, under every write failure: a later process never reads a possibly
	// live stream as idle from the carrying line.
	if (w.streamMayBeLive && !w.launchedUnmarked) {
		if (content === LINE)
			throw new Error(`carrying line beside a stream: ${where}`);
		if (replacement !== "unknown")
			throw new Error(`replacement backend reads a stream as idle: ${where}`);
	}
	if (w.faulted) return;
	// With a working disk the file is exactly what the holders justify.
	const holdersWant = w.streamMayBeLive
		? ""
		: w.carrying || w.inherited
			? LINE
			: undefined;
	if (content !== holdersWant)
		throw new Error(
			`file ${JSON.stringify(content)}, holders justify ${JSON.stringify(holdersWant)}: ${where}`,
		);
	// The symptom this exists to remove: no stream, and yet the next backend
	// cannot reach idle.
	if (!w.streamMayBeLive && replacement !== "idle")
		throw new Error(`replacement backend stuck without a stream: ${where}`);
	if (w.owner.liveness() !== (w.streamMayBeLive ? "unknown" : "idle"))
		throw new Error(`this backend misreads its own marker: ${where}`);
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

test("every interleaving of holders, write failures and restarts keeps the marker truthful", () => {
	expect(walk(6)).toBe(44_667);
}, 30_000);

test("the walk catches a carrying line beside a stream", () => {
	const w = world();
	for (const step of ["carrying-on", "start"] as const) apply(w, step);
	w.disk.files.set(PATH, LINE);
	expect(() => check(w, ["tampered"] as unknown as Event[])).toThrow(
		"carrying line beside a stream",
	);
});
