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
let eligible: () => boolean = () => true;

/**
 * `stillEligible` is asked wherever the adopted sender is consulted, so the
 * takeover's final conditions hold at the point reconciliation publishes
 * streaming, not only when the takeover last looked.
 */
export function noteAdoptedSender(
	sender: StreamingProcess,
	stillEligible: () => boolean = () => true,
): void {
	adopted = sender;
	eligible = stillEligible;
}

export function clearAdoptedSender(sender?: StreamingProcess): void {
	if (sender === undefined || adopted === sender) {
		adopted = undefined;
		eligible = () => true;
	}
}

/**
 * The adopted sender, while its pidfd says it is alive right now. The cached
 * exit fields lag the exit poll, and an unknown answer is not alive.
 */
export function adoptedSender(): StreamingProcess | undefined {
	if (adopted === undefined) return undefined;
	const { exitCode, signalCode } = adopted.proc;
	if (exitCode !== null || signalCode !== null) return undefined;
	if (adopted.hosted?.pin.alive() !== true) return undefined;
	return eligible() ? adopted : undefined;
}
