/*
	CeraUI - Mock clock seam

	The mock providers draw their wobble (signal, round trip, link shares,
	sensor readings) from `mockRandom()` and their drift from `mockNow()`.
	Unpinned, these are exactly `Math.random()` and `Date.now()`, so ordinary
	development and every existing test behave as before.

	A scripted scenario pins the clock (`pinMockClock`): from then on the mock
	values are a function of the scenario's seed and of the scenario time the
	driver hands in, never of the host's timing. The driver advances the pinned
	time in steps; each step re-seeds the generator from (seed, step time), so a
	value at a given step does not depend on how many draws earlier steps made.
	Only mock values follow this clock. The real health, staleness and timer
	logic keeps the host's clock, so a scenario never shows states a box would
	not reach in the same real time.
*/

/** mulberry32: small, fast, well-distributed 32-bit PRNG. Returns [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Mix a seed and a step time into one 32-bit seed (FNV-1a over both words). */
export function mixSeed(seed: number, stepMs: number): number {
	let hash = 0x811c9dc5;
	for (const word of [seed >>> 0, Math.floor(stepMs) >>> 0]) {
		for (let shift = 0; shift < 32; shift += 8) {
			hash ^= (word >>> shift) & 0xff;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	}
	return hash;
}

/** Wall-clock origin of scenario time 0, fixed so pinned `now()` is reproducible. */
export const MOCK_CLOCK_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

interface PinnedClock {
	seed: number;
	stepMs: number;
	random: () => number;
}

let pinned: PinnedClock | null = null;

/** Mock-provider replacement for `Math.random()`. */
export function mockRandom(): number {
	return pinned ? pinned.random() : Math.random();
}

/**
 * A draw that depends only on (seed, step, key) while pinned, for values a
 * provider recomputes on every read (relay round trips): repeated reads within
 * one step agree, whatever the number of reads. Unpinned: `Math.random()`.
 */
export function mockRandomFor(key: string): number {
	if (!pinned) return Math.random();
	let hash = mixSeed(pinned.seed, pinned.stepMs);
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return mulberry32(hash)();
}

/** Mock-provider replacement for `Date.now()`. Frozen between pinned steps. */
export function mockNow(): number {
	return pinned ? MOCK_CLOCK_EPOCH_MS + pinned.stepMs : Date.now();
}

/**
 * Pin the clock at a scenario step. Re-seeds the generator from (seed, step),
 * so calling this twice with the same arguments gives the same draws.
 */
export function pinMockClock(seed: number, stepMs: number): void {
	if (!Number.isInteger(seed) || !Number.isFinite(stepMs) || stepMs < 0) {
		throw new RangeError("mock clock needs an integer seed and a step >= 0");
	}
	pinned = {
		seed,
		stepMs: Math.floor(stepMs),
		random: mulberry32(mixSeed(seed, stepMs)),
	};
}

/** Return to the host clock and `Math.random()`. */
export function unpinMockClock(): void {
	pinned = null;
}

export function getMockClockState(): { seed: number; stepMs: number } | null {
	return pinned ? { seed: pinned.seed, stepMs: pinned.stepMs } : null;
}

export function isMockClockPinned(): boolean {
	return pinned !== null;
}
