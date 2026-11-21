/*
 * The one sender this backend adopted from its predecessor, if any.
 *
 * Reconciliation normally needs evidence from this process: an attempt it
 * launched, a live sender child and the engine client that acknowledged its
 * Start. An adopted session has no launch attempt in this process, so the
 * attempt half is replaced by this: the adopted handle is still registered and
 * alive. The other two halves stay as they are: a live owned sender, and the
 * engine's launched session (set by the takeover on the verified connection).
 */

import type { StreamingProcess } from "./streamloop/process-runner.ts";

let adopted: StreamingProcess | undefined;

export function noteAdoptedSender(sender: StreamingProcess): void {
	adopted = sender;
}

export function clearAdoptedSender(sender?: StreamingProcess): void {
	if (sender === undefined || adopted === sender) adopted = undefined;
}

/** The adopted sender, while it is alive. */
export function adoptedSender(): StreamingProcess | undefined {
	if (adopted === undefined) return undefined;
	const { exitCode, signalCode } = adopted.proc;
	return exitCode === null && signalCode === null ? adopted : undefined;
}
