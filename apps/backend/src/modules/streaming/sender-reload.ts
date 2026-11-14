/** A reload is complete only when the running sender has adopted the publication. */
export type Adoption = { generation?: number; sources: readonly string[] };

export type AdoptionState =
	| { state: "adopted" }
	| { state: "stale"; stale: string[] }
	| { state: "unknown" };

/**
 * Three answers, never two: an observation that cannot be made is "can't
 * tell", which must not be read as adopted or as stale.
 */
export function classifyAdoption(
	observed: Adoption | undefined,
	generation: number | undefined,
	sources: readonly string[],
): AdoptionState {
	if (!observed) return { state: "unknown" };
	if (observed.generation !== undefined && generation !== undefined)
		return observed.generation === generation
			? { state: "adopted" }
			: { state: "stale", stale: [] };
	// Nothing bound that is not loopback or a wildcard: a local relay, or a
	// sender between sockets. Neither proves a stale source.
	if (observed.sources.length === 0) return { state: "unknown" };
	// A source outside the publication means a changed link kept its old
	// address. A published address that is not bound yet is left alone: the
	// sender took the change, and a restart could not bind it either.
	const stale = observed.sources.filter((ip) => !sources.includes(ip));
	return stale.length > 0 ? { state: "stale", stale } : { state: "adopted" };
}

export type ReloadDeps = {
	signal: AbortSignal;
	now: () => number;
	wait: (ms: number) => Promise<void>;
	hup: () => Promise<boolean>;
	read: () => Promise<Adoption | undefined>;
	log: (event: string, meta: Record<string, unknown>) => void;
	/** Rate-limited by the caller: /proc can stay unreadable for a whole session. */
	observationFailed: (error: unknown) => void;
	windowMs?: number;
	pollMs?: number;
};

export type ReloadOutcome =
	| { outcome: "adopted" }
	| { outcome: "stale"; stale: string[] }
	| { outcome: "unknown" }
	| { outcome: "cancelled" };

/**
 * After the engine confirms Stop, the sender keeps forwarding this long so the
 * engine's real SRT shutdown reaches the relay. Without it, a quick restart to
 * the same stream ID meets a relay that still holds the old session.
 */
export const SENDER_STOP_HOLD_MS = 250;

export const SENDER_RELOAD_WINDOW_MS = 10_000;
export const SENDER_RELOAD_POLL_MS = 250;

/**
 * Signal, watch for about ten seconds, and signal once more only when a stale
 * source is positively observed. Never replaces the sender: a new sender
 * process registers a new relay group, and the engine's SRT session cannot
 * follow it, so only a full, supervised session restart can fix a source that
 * stays stale. That restart is the operator's decision (see session.ts).
 */
export async function verifySenderReload(
	generation: number | undefined,
	sources: readonly string[],
	deps: ReloadDeps,
): Promise<ReloadOutcome> {
	const windowMs = deps.windowMs ?? SENDER_RELOAD_WINDOW_MS;
	const pollMs = deps.pollMs ?? SENDER_RELOAD_POLL_MS;
	const log = (outcome: string, extra = {}) =>
		deps.log("sender reload", { generation, outcome, ...extra });
	const observe = async (): Promise<AdoptionState> => {
		const deadline = deps.now() + windowMs;
		let last: AdoptionState = { state: "unknown" };
		while (!deps.signal.aborted) {
			try {
				last = classifyAdoption(await deps.read(), generation, sources);
			} catch (error) {
				deps.observationFailed(error);
				last = { state: "unknown" };
			}
			if (last.state === "adopted") return last;
			if (deps.now() >= deadline) break;
			await deps.wait(pollMs);
		}
		return last;
	};
	try {
		let state: AdoptionState = { state: "unknown" };
		for (let attempt = 1; attempt <= 2; attempt++) {
			if (deps.signal.aborted) return { outcome: "cancelled" };
			try {
				log("signal", { attempt, delivered: await deps.hup() });
			} catch (error) {
				log("signal_failed", { attempt, error: String(error) });
			}
			state = await observe();
			if (deps.signal.aborted) return { outcome: "cancelled" };
			if (state.state === "adopted") {
				log("adopted", { attempt });
				return { outcome: "adopted" };
			}
			// Can't tell is never a reason to act, not even to signal again.
			if (state.state === "unknown") break;
		}
		// Every observation above is followed by an abort check, so a stale or
		// unknown result here belongs to a run that is still current.
		if (state.state === "stale") {
			log("stale", { stale: state.stale });
			return { outcome: "stale", stale: state.stale };
		}
		log("unknown");
		return { outcome: "unknown" };
	} catch (error) {
		if (deps.signal.aborted) return { outcome: "cancelled" };
		log("failed", { error: String(error) });
		return { outcome: "unknown" };
	}
}

/** At most one observation-failure line per interval, with a suppressed count. */
export function createObservationFailureLog(
	intervalMs = 60_000,
	now: () => number = Date.now,
) {
	let lastAt = Number.NEGATIVE_INFINITY;
	let suppressed = 0;
	return {
		report(
			error: unknown,
			log: (event: string, meta: Record<string, unknown>) => void,
		) {
			if (now() - lastAt < intervalMs) {
				suppressed++;
				return;
			}
			lastAt = now();
			log("sender reload", {
				outcome: "observation_failed",
				error: String(error),
				suppressed,
			});
			suppressed = 0;
		},
	};
}

export function waitForReload(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Serialize publications; superseding work cancels its waits, including backoff. */
export function createReloadQueue() {
	let controller: AbortController | undefined;
	let pending = Promise.resolve();
	let closed = false;
	let lastKey: string | undefined;
	return {
		enqueue(key: string, run: (signal: AbortSignal) => Promise<unknown>) {
			if (closed || key === lastKey) return;
			lastKey = key;
			controller?.abort();
			const next = new AbortController();
			controller = next;
			pending = pending.then(async () => {
				if (!next.signal.aborted) await run(next.signal);
			});
		},
		close() {
			closed = true;
			controller?.abort();
		},
		settled: () => pending,
	};
}
