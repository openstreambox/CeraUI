/*
  WHILE A SUPERVISED CONNECTION RESTART RUNS.

  Between its Stop and its Start the device is not streaming, but the operator
  did not stop anything: the connection is restarting, and viewers see the BRB
  screen until it is back. `connection_restarting` lets every surface say that
  instead of "Not streaming". It is published as an explicit boolean on every
  status snapshot and on each change, so a missed frame cannot latch it.

  A tap and an automatic restart can overlap (they join the same Stop), so the
  flag stays up until the last one has finished.
*/

import { broadcastMsg } from "../ui/websocket-server.ts";

let running = 0;

export function isConnectionRestarting(): boolean {
	return running > 0;
}

/** Marks one restart as running; the returned function ends it, once. */
export function beginConnectionRestart(
	publish: (restarting: boolean) => void = (restarting) =>
		broadcastMsg("status", { connection_restarting: restarting }),
): () => void {
	running++;
	if (running === 1) publish(true);
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		running--;
		if (running === 0) publish(false);
	};
}

/** Tests only. */
export function resetConnectionRestartingForTest(): void {
	running = 0;
}
