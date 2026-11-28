let epoch = 0;
const listeners = new Set<() => void>();

export function noteOperatorStopIntent(): void {
	epoch++;
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// A listener must not keep the Stop from reaching the others.
		}
	}
}

export function captureOperatorStopIntent(): () => boolean {
	const captured = epoch;
	return () => epoch === captured;
}

/**
 * Runs `listener` on every operator Stop, as the Stop is noted and before it
 * runs. For state that has no session to stop, such as the reconnect window.
 */
export function onOperatorStopIntent(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
