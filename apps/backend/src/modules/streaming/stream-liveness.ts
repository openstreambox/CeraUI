import type { SessionLiveness } from "./stream-session-ownership.ts";

// The composition root installs its reader; early/cyclic consumers stay unknown.
let readLiveness: () => SessionLiveness = () => "unknown";

export function bindStreamLiveness(reader: () => SessionLiveness): void {
	readLiveness = reader;
}

export function streamLiveness(): SessionLiveness {
	return readLiveness();
}

// Interlocks that predate session liveness read `is_streaming`, which stays false
// while a session is unconfirmed. Session ownership publishes that state here so
// disruptive network actions stay closed without projecting a live stream.
let unconfirmed = false;

/** Returns whether the published value changed. */
export function publishStreamSessionUnconfirmed(next: boolean): boolean {
	if (next === unconfirmed) return false;
	unconfirmed = next;
	return true;
}

/** True while the session cannot confirm that no stream is running. */
export function isStreamSessionUnconfirmed(): boolean {
	return unconfirmed;
}
