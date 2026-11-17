/**
 * The restart witness as a state machine, through the real session.
 *
 * `ota-marker-owner.test.ts` walks the marker owner against a perfect engine:
 * a reconciliation there adopts exactly when a stream runs and confirms
 * exactly when it does not. This walk drives the real session orchestrator's
 * reconciliation instead, against an engine that is not perfect: a status
 * window can miss a heartbeat, the engine can be unreachable, and it can crash
 * and leave its unit without a process. After every step it checks what
 * #123 promises: a restart beside a running stream never reads idle and keeps
 * the encoder inhibitor, and with a working disk a box without a stream
 * reaches idle unless a stream's own marker is left.
 */
import { expect, test } from "bun:test";
import { currentRuntimeObservationSilence } from "../modules/streaming/engine-runtime-observation.ts";
import { createOtaMarkerOwner } from "../modules/streaming/ota-streaming-marker.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import type { EngineRuntimeState } from "../modules/streaming/streaming-backend.ts";

const PATH = "/run/test/streaming";

function fault(code: string): Error {
	return Object.assign(new Error(code), { code });
}

function memoryFs() {
	const files = new Map<string, string>();
	const disk = { files, readonly: false };
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
			if (disk.readonly) throw fault("EROFS");
			files.set(
				path,
				options?.flag === "a" ? (files.get(path) ?? "") + data : data,
			);
		},
		renameSync: (from: string, to: string) => {
			if (disk.readonly) throw fault("EROFS");
			const content = files.get(from);
			if (content === undefined) throw fault("ENOENT");
			files.delete(from);
			files.set(to, content);
		},
		rmSync: (path: string) => {
			if (!files.has(path)) return;
			if (disk.readonly) throw fault("EROFS");
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
	"stop",
	// Another control client starts the engine; this backend learns nothing.
	"outside-start",
	// The engine process dies with its session; its unit stays down until a
	// start brings it back.
	"engine-crash",
	// A new backend process; main.ts reconciles at boot.
	"restart",
	// The same, but the first status window misses the running session's
	// heartbeat (one dropped or late heartbeat; two in a row is the limit
	// this design states).
	"restart-dropping",
	"reconcile",
	"reconcile-dropping",
	// Connect fails while the unit runs: nothing is proven either way.
	"reconcile-unreachable",
	"disk-readonly",
	"disk-ok",
] as const;
type Event = (typeof EVENTS)[number];

function world() {
	const { disk, fs } = memoryFs();
	const held = { encoder: false, carrying: false };
	const w = {
		disk,
		held,
		// Ground truth.
		streamLive: false,
		unitDown: false,
		// A stream that was running, with a file on disk, when this backend
		// process started: what a restart must never call idle.
		carriedOver: false,
		carrying: false,
		faulted: false,
		// How the next reconciliation's engine behaves.
		dropNext: false,
		unreachable: false,
		owner: undefined as unknown as ReturnType<typeof createOtaMarkerOwner>,
		session: undefined as unknown as ReturnType<
			typeof createStreamSessionOrchestrator
		>,
	};
	const answer = async (): Promise<EngineRuntimeState> => {
		if (w.unitDown || w.unreachable) return "unknown";
		if (w.streamLive && !w.dropNext) return "streaming";
		w.dropNext = false;
		// Reachable and silent: an idle engine, or a window that missed one.
		currentRuntimeObservationSilence()();
		return "unknown";
	};
	const boot = () => {
		held.encoder = false;
		held.carrying = false;
		const owner = createOtaMarkerOwner({
			path: () => PATH,
			fs,
			setShutdownProtection: (name, active) => {
				held[name] = active;
				return true;
			},
			quiet: true,
		});
		w.owner = owner;
		w.session = createStreamSessionOrchestrator({
			initialLiveness: owner.liveness,
			markStreamingForOta: owner.takeEncoder,
			unmarkStreamingForOta: owner.releaseEncoder,
			confirmStreamingForOta: owner.adoptStream,
			awaitsIdleWitness: owner.awaitsIdleWitness,
			engineStopped: async () => w.unitDown,
			claimLaunchMarker: owner.claimForLaunch,
			createAttemptId: () => "walk",
			setStreamingStatus: () => undefined,
			getStreamingStatus: () => w.streamLive,
			queryRuntime: answer,
			stopRuntime: async () => {
				if (w.unitDown || w.unreachable) throw new Error("engine gone");
				w.streamLive = false;
				w.carriedOver = false;
			},
			pendingGateRemainingMs: () => 0,
		});
		w.carrying = false;
	};
	boot();
	return { w, boot };
}
type World = ReturnType<typeof world>;

async function apply({ w, boot }: World, event: Event): Promise<boolean> {
	w.unreachable = false;
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
		case "start": {
			if (w.streamLive) return false;
			await w.session.start({
				origin: "ui",
				launch: async () => {
					w.unitDown = false;
					w.streamLive = true;
				},
			});
			return true;
		}
		case "stop":
			await w.session.stop("operator");
			return true;
		case "outside-start":
			if (w.streamLive) return false;
			w.unitDown = false;
			w.streamLive = true;
			return true;
		case "engine-crash":
			if (w.unitDown) return false;
			w.unitDown = true;
			w.streamLive = false;
			w.carriedOver = false;
			return true;
		case "restart":
		case "restart-dropping":
			w.carriedOver = w.streamLive && w.disk.files.has(PATH);
			boot();
			w.dropNext = event === "restart-dropping";
			await w.session.reconcile();
			w.dropNext = false;
			return true;
		case "reconcile":
		case "reconcile-dropping":
		case "reconcile-unreachable":
			w.dropNext = event === "reconcile-dropping";
			w.unreachable = event === "reconcile-unreachable";
			await w.session.reconcile();
			w.dropNext = false;
			w.unreachable = false;
			return true;
		case "disk-readonly":
			if (w.disk.readonly) return false;
			w.disk.readonly = true;
			w.faulted = true;
			return true;
		case "disk-ok":
			if (!w.disk.readonly) return false;
			w.disk.readonly = false;
			return true;
	}
}

const SETTLES = new Set<Event>([
	"restart",
	"restart-dropping",
	"reconcile",
	"reconcile-dropping",
]);

function check({ w }: World, path: readonly Event[]) {
	const where = path.join(" > ");
	const state = w.session.snapshot().state;
	if (w.streamLive && w.carriedOver) {
		if (state === "idle" || w.session.streamLiveness() === "idle")
			throw new Error(`restart reads a running stream as idle: ${where}`);
		if (!w.held.encoder)
			throw new Error(`restart beside a stream without inhibitor: ${where}`);
	}
	if (w.faulted) return;
	const last = path.at(-1);
	const content = w.disk.files.get(PATH);
	if (
		!w.streamLive &&
		last !== undefined &&
		SETTLES.has(last) &&
		content !== ""
	) {
		if (state !== "idle")
			throw new Error(`no stream, and still ${state}: ${where}`);
		if (!w.carrying && (w.held.encoder || w.held.carrying))
			throw new Error(`idle box keeps an inhibitor: ${where}`);
	}
}

async function walk(depth: number): Promise<number> {
	let sequences = 0;
	const visit = async (path: Event[]) => {
		if (path.length === depth) return;
		for (const event of EVENTS) {
			const next = [...path, event];
			const world_ = world();
			let possible = true;
			for (const step of next) {
				possible = await apply(world_, step);
				if (!possible) break;
			}
			if (!possible) continue;
			sequences++;
			check(world_, next);
			await visit(next);
		}
	};
	await visit([]);
	return sequences;
}

test("a restart never reads a running stream as idle, against an imperfect engine", async () => {
	expect(await walk(5)).toBe(133_872);
}, 300_000);

test("the walk catches a witness that settles on one silent window", async () => {
	const w = world();
	for (const step of [
		"carrying-on",
		"outside-start",
		"restart-dropping",
	] as const)
		await apply(w, step);
	// The real session asked twice and heard the stream the second time.
	expect(w.w.session.snapshot().state).toBe("streaming");
	expect(w.w.disk.files.get(PATH)).toBe("");
	expect(() => check(w, ["restart-dropping"])).not.toThrow();
	// A session that had trusted the first window would have failed here.
	const real = w.w.session.snapshot;
	w.w.session.snapshot = () => ({ ...real(), state: "idle" });
	expect(() => check(w, ["tampered"] as unknown as Event[])).toThrow(
		"restart reads a running stream as idle",
	);
});
