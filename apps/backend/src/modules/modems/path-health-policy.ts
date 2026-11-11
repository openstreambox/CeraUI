/** Monotonic milliseconds; one instance per modem+SIM+bearer generation. */
export interface PathHealthState {
	readonly generation: string | undefined;
	readonly seen: boolean;
	readonly missingSince: number | undefined;
	readonly settleUntil: number;
	readonly failures: number;
	readonly reconnects: number;
	readonly nextProbe: number;
	readonly ready: boolean;
	readonly budgetRemaining: number;
}
export function initialPathHealth(budgetBytes: number): PathHealthState {
	if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0)
		throw new Error("Invalid probe budget");
	return {
		generation: undefined,
		seen: false,
		missingSince: undefined,
		settleUntil: 0,
		failures: 0,
		reconnects: 0,
		nextProbe: 0,
		ready: false,
		budgetRemaining: budgetBytes,
	};
}
export type PathAvailability =
	| "usb-wait"
	| "usb-absent"
	| "settling"
	| "present";

/** USB loss withdraws readiness without charging a carrier failure or reconnect. */
export function observeAvailability(
	state: PathHealthState,
	generation: string | undefined,
	now: number,
): { state: PathHealthState; availability: PathAvailability } {
	if (generation === undefined) {
		const missingSince = state.missingSince ?? now;
		return {
			state: { ...state, generation: undefined, missingSince, ready: false },
			availability: now - missingSince < 75_000 ? "usb-wait" : "usb-absent",
		};
	}
	const changed = state.generation !== generation;
	const settleUntil = changed
		? now + (state.seen ? 15_000 : 0)
		: state.settleUntil;
	return {
		state: {
			...state,
			generation,
			seen: true,
			missingSince: undefined,
			settleUntil,
			...(changed ? { ready: false, failures: 0, nextProbe: settleUntil } : {}),
		},
		availability: now < settleUntil ? "settling" : "present",
	};
}

/** Reserve worst-case wire bytes before launching bounded, source/device-bound probes. */
export function reservePathProbe(
	state: PathHealthState,
	generation: string,
	now: number,
	maxBytes: number,
): PathHealthState | undefined {
	if (
		state.generation !== generation ||
		now < state.nextProbe ||
		now < state.settleUntil ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0 ||
		state.budgetRemaining < maxBytes
	)
		return undefined;
	return {
		...state,
		budgetRemaining: state.budgetRemaining - maxBytes,
		nextProbe: now + 30_000,
	};
}

/** Ignore delayed results from a retired USB/SIM/bearer generation. */
export function observePathProbe(
	state: PathHealthState,
	generation: string,
	now: number,
	ok: boolean,
): { state: PathHealthState; reconnect: boolean } {
	if (state.generation !== generation || now < state.settleUntil)
		return { state, reconnect: false };
	if (ok)
		return {
			state: {
				...state,
				ready: true,
				failures: 0,
				reconnects: 0,
				nextProbe: now + 300_000,
			},
			reconnect: false,
		};
	const failures = state.failures + 1;
	if (failures < 2)
		return {
			state: { ...state, ready: false, failures, nextProbe: now + 30_000 },
			reconnect: false,
		};
	const reconnects = Math.min(state.reconnects + 1, 5);
	return {
		state: {
			...state,
			ready: false,
			failures: 0,
			reconnects,
			nextProbe: now + Math.min(900_000, 60_000 * 2 ** (reconnects - 1)),
		},
		reconnect: true,
	};
}
