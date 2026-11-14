/** A reload is complete only when the running sender has adopted the publication. */
export type Adoption = { generation?: number; sources: readonly string[] };

export function adoptionMatches(
	observed: Adoption | undefined,
	generation: number | undefined,
	sources: readonly string[],
): boolean {
	if (!observed) return false;
	if (observed.generation !== undefined && generation !== undefined)
		return observed.generation === generation;
	// A source outside the publication means a changed link kept its old
	// address. A published address that is not bound yet is left alone: the
	// sender took the change, and a restart could not bind it either.
	return (
		observed.sources.length > 0 &&
		observed.sources.every((ip) => sources.includes(ip))
	);
}

export type ReloadDeps = {
	signal: AbortSignal;
	now: () => number;
	wait: (ms: number) => Promise<void>;
	hup: () => Promise<boolean>;
	read: () => Promise<Adoption | undefined>;
	restart: () => Promise<void>;
	notice: () => void;
	log: (event: string, meta: Record<string, unknown>) => void;
};

export async function verifySenderReload(
	generation: number | undefined,
	sources: readonly string[],
	deps: ReloadDeps,
): Promise<"adopted" | "restarted" | "failed" | "cancelled"> {
	const log = (outcome: string, extra = {}) =>
		deps.log("sender reload", { generation, outcome, ...extra });
	const adopted = async () => {
		const deadline = deps.now() + 10000;
		while (!deps.signal.aborted) {
			try {
				if (adoptionMatches(await deps.read(), generation, sources))
					return true;
			} catch (error) {
				log("observation_failed", { error: String(error) });
			}
			if (deps.now() >= deadline) break;
			await deps.wait(250);
		}
		return false;
	};
	try {
		for (let attempt = 1; attempt <= 2; attempt++) {
			if (deps.signal.aborted) return "cancelled";
			try {
				log("signal", { attempt, delivered: await deps.hup() });
			} catch (error) {
				log("signal_failed", { attempt, error: String(error) });
			}
			if (await adopted()) {
				log("adopted", { attempt });
				return "adopted";
			}
		}
		await deps.wait(500);
		if (deps.signal.aborted) return "cancelled";
		await deps.restart();
		if (deps.signal.aborted) return "cancelled";
		if (await adopted()) {
			if (deps.signal.aborted) return "cancelled";
			log("restarted");
			deps.notice();
			return "restarted";
		}
		if (deps.signal.aborted) return "cancelled";
		log("exhausted");
		return "failed";
	} catch (error) {
		if (deps.signal.aborted) return "cancelled";
		log("failed", { error: String(error) });
		return "failed";
	}
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
