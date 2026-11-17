/**
 * The OTA marker owner as a state machine, over every interleaving.
 *
 * Two reviews found orderings in which the file said "carrying only" beside a
 * live stream, or an empty file outlived the Start that emptied it. A third
 * found that a line an earlier process left stays standing when another
 * control client starts the engine and the file cannot be rewritten. All are
 * properties of one small machine: holders (carrying, a stream), one file and
 * the engine. This walks every sequence of holder changes, engine answers,
 * write failures (including torn writes) and backend restarts up to a fixed
 * depth on an in-memory file and checks after each step what a replacement
 * backend would conclude.
 */
import { expect, test } from "bun:test";
import { createOtaMarkerOwner } from "../modules/streaming/ota-streaming-marker.ts";

const PATH = "/run/test/streaming";
const LINE = "carrying\n";
type Mode = "ok" | "file-readonly" | "readonly" | "torn";

function fault(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/** One directory with a marker and its temporary sibling. */
function memoryFs() {
	const files = new Map<string, string>();
	const disk = { files, mode: "ok" as Mode };
	const writable = (path: string) =>
		disk.mode === "ok" ||
		disk.mode === "torn" ||
		(disk.mode === "file-readonly" && !files.has(path));
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
			const before = options?.flag === "a" ? (files.get(path) ?? "") : "";
			if (disk.mode === "torn") {
				// Opened (created or truncated), then the write stops halfway.
				files.set(path, before + data.slice(0, Math.floor(data.length / 2)));
				throw fault("EIO");
			}
			files.set(path, before + data);
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
	// Another control client starts the engine; this backend learns nothing.
	"outside-start",
	// The session asks the engine, which answers from ground truth: a running
	// session reports its status, an idle engine stays silent.
	"reconcile",
	// The engine cannot be reached; the session only protects.
	"reconcile-unreachable",
	"restart",
	"disk-ok",
	"disk-file-readonly",
	"disk-readonly",
	"disk-torn",
] as const;
type Event = (typeof EVENTS)[number];

type Owner = ReturnType<typeof createOtaMarkerOwner>;

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
		// Ground truth: the engine runs a session.
		streamLive: false,
		// This process launched it or adopted it, or found its empty marker.
		streamKnown: false,
		// Launched with the file taken; the base launches unmarked when no file
		// can be created at all.
		launchedMarked: false,
		faulted: false,
		// An earlier process's carrying line waits for this process's witness.
		inherited: false,
	};
}
type World = ReturnType<typeof world>;

/** What the session's reconciliation does with protection before it asks. */
const protectUnlessIdle = (owner: Owner) => {
	if (owner.liveness() !== "idle") owner.takeEncoder();
};

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
			// Admission needs an idle session; its last step and the launch are
			// one tick, and a refused claim launches nothing.
			if (w.streamLive || w.owner.liveness() !== "idle") return false;
			if (!w.owner.claimForLaunch()) return true;
			w.owner.takeEncoder();
			w.owner.adoptStream();
			w.inherited = false;
			w.streamLive = true;
			w.streamKnown = true;
			w.launchedMarked = w.disk.files.has(PATH);
			return true;
		case "confirmed-idle":
			// An acknowledged Stop: whatever ran is over.
			w.owner.releaseEncoder();
			w.inherited = false;
			w.streamLive = false;
			w.streamKnown = false;
			w.launchedMarked = false;
			return true;
		case "outside-start":
			if (w.streamLive) return false;
			w.streamLive = true;
			return true;
		case "reconcile":
			protectUnlessIdle(w.owner);
			if (w.streamLive) {
				w.owner.adoptStream();
				w.inherited = false;
				w.streamKnown = true;
			} else if (w.owner.awaitsIdleWitness()) {
				// Silent on every query: the session commits idle.
				w.owner.releaseEncoder();
				w.inherited = false;
			}
			return true;
		case "reconcile-unreachable":
			protectUnlessIdle(w.owner);
			return true;
		case "restart":
			// The process dies: its holders and knowledge are gone, the file and
			// the engine stay.
			w.inherited = w.disk.files.get(PATH) === LINE;
			w.streamKnown = w.streamLive && w.disk.files.get(PATH) === "";
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

/** What a replacement backend concludes from the file and the engine. */
function replacementReads(w: World): "idle" | "unknown" {
	const next = w.boot();
	if (next.liveness() === "idle") return "idle";
	return next.awaitsIdleWitness() && !w.streamLive ? "idle" : "unknown";
}

function check(w: World, path: readonly Event[]) {
	const content = w.disk.files.get(PATH);
	const replacement = replacementReads(w);
	const where = path.join(" > ");
	// Safety, under every write failure: a stream this backend launched never
	// has the carrying line beside it, and while there is a file neither this
	// backend nor a later one reads a stream it knows of as idle. (With no
	// file at all, because none could be created, the base already streams
	// unmarked.)
	if (w.streamLive && w.launchedMarked && content === LINE)
		throw new Error(`carrying line beside a launched stream: ${where}`);
	if (w.streamLive && w.streamKnown && content !== undefined) {
		if (replacement !== "unknown")
			throw new Error(`replacement backend reads a stream as idle: ${where}`);
		if (w.owner.liveness() !== "unknown")
			throw new Error(`this backend reads its stream as idle: ${where}`);
	}
	// A line beside any live stream, known or not, is never enough for idle.
	if (w.streamLive && content !== undefined && replacement !== "unknown")
		throw new Error(`replacement trusts a file beside a stream: ${where}`);
	if (w.faulted) return;
	// With a working disk the file is exactly what the holders justify.
	const holdersWant = w.streamKnown
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
	if (!w.streamLive && replacement !== "idle")
		throw new Error(`replacement backend stuck without a stream: ${where}`);
	const own = w.streamKnown || w.inherited ? "unknown" : "idle";
	if (w.owner.liveness() !== own)
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

test("every interleaving of holders, engine answers, write failures and restarts keeps the marker truthful", () => {
	expect(walk(6)).toBe(772_329);
}, 60_000);

test("the walk catches a carrying line beside a stream", () => {
	const w = world();
	for (const step of ["carrying-on", "start"] as const) apply(w, step);
	w.disk.files.set(PATH, LINE);
	expect(() => check(w, ["tampered"] as unknown as Event[])).toThrow(
		"carrying line beside a launched stream",
	);
});

test("the walk catches a replacement that trusts the line beside an outside stream", () => {
	const w = world();
	for (const step of ["carrying-on", "outside-start", "restart"] as const)
		apply(w, step);
	const trusting = w.boot();
	// What #122 did: the line alone made a restarted backend idle.
	expect(trusting.liveness()).toBe("unknown");
	expect(trusting.awaitsIdleWitness()).toBe(true);
	expect(replacementReads(w)).toBe("unknown");
	w.streamLive = false;
	expect(replacementReads(w)).toBe("idle");
});

function owner(fs: ReturnType<typeof memoryFs>["fs"]) {
	return createOtaMarkerOwner({
		path: () => PATH,
		fs,
		setShutdownProtection: () => true,
		quiet: true,
	});
}

test("a line already on disk is not written again", () => {
	const { disk, fs } = memoryFs();
	const first = owner(fs);
	first.setCarrying(true);
	expect(disk.files.get(PATH)).toBe(LINE);
	// Every write from here on would stop halfway.
	disk.mode = "torn";
	for (let tick = 0; tick < 3; tick++) first.setCarrying(true);
	expect(disk.files.get(PATH)).toBe(LINE);
	first.takeEncoder();
	expect(disk.files.get(PATH)).toBe("");
	expect(first.releaseEncoder()).toBe(true);
	// The line cannot be written whole, so what is there must not read idle.
	const content = disk.files.get(PATH);
	expect(content).not.toBe(LINE);
	const next = owner(fs);
	expect(next.liveness()).toBe("unknown");
	expect(next.awaitsIdleWitness()).toBe(false);
});

test("a torn sibling never reaches the marker", () => {
	const { disk, fs } = memoryFs();
	disk.files.set(PATH, "");
	const writes = fs.writeFileSync;
	// The temporary sibling tears; the marker itself cannot be rewritten.
	(fs as { writeFileSync: typeof writes }).writeFileSync = ((
		path: string,
		data: string,
		options?: { flag?: string },
	) => {
		if (path === PATH && options?.flag !== "a") throw fault("EACCES");
		if (path !== PATH) {
			disk.files.set(path, data.slice(0, 4));
			throw fault("ENOSPC");
		}
		return writes(path, data, options);
	}) as typeof writes;
	const first = owner(fs);
	first.setCarrying(true);
	first.releaseEncoder();
	expect(disk.files.get(PATH)).toBe("");
	expect(disk.files.has(`${PATH}.new`)).toBe(false);
	expect(owner(fs).awaitsIdleWitness()).toBe(false);
});

test("a process that dies between the sibling and the rename leaves the old marker", () => {
	const { disk, fs } = memoryFs();
	const first = owner(fs);
	first.setCarrying(true);
	first.takeEncoder();
	expect(disk.files.get(PATH)).toBe("");
	const rename = fs.renameSync;
	(fs as { renameSync: typeof rename }).renameSync = () => {
		throw fault("EINTR");
	};
	(fs as { rmSync: unknown }).rmSync = () => undefined;
	// The in-place fallback is where the process dies.
	const writes = fs.writeFileSync;
	(fs as { writeFileSync: typeof writes }).writeFileSync = ((
		path: string,
		data: string,
		options?: { flag?: string },
	) => {
		if (path === PATH) throw fault("EIO");
		return writes(path, data, options);
	}) as typeof writes;
	first.releaseEncoder();
	expect(disk.files.get(PATH)).toBe("");
	expect(disk.files.get(`${PATH}.new`)).toBe(LINE);
	// Only the marker counts; the orphaned sibling says nothing.
	const next = owner(fs);
	expect(next.liveness()).toBe("unknown");
	expect(next.awaitsIdleWitness()).toBe(false);
});

test("content near the line is not the line", () => {
	for (const content of [
		"carrying",
		"carrying\r\n",
		" carrying\n",
		"carrying\n\n",
		"carr",
		"",
	]) {
		const { disk, fs } = memoryFs();
		disk.files.set(PATH, content);
		const next = owner(fs);
		expect(next.liveness()).toBe("unknown");
		expect(next.awaitsIdleWitness()).toBe(false);
	}
});
