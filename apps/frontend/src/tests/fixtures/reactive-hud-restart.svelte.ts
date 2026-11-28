/**
 * Reactive holders for the HUD's connection-restart test: the HUD reads the
 * stream state and the status inside `$derived`/`$effect`, so an edge (live,
 * then the restart's Stop) needs reads that genuinely re-run.
 */
import type { StreamReconnectStatus } from "@ceraui/rpc/schemas";

let streaming = $state(false);
let restarting = $state(false);
let reconnect = $state<StreamReconnectStatus | null>(null);

export const hudRestart = {
	get streaming(): boolean {
		return streaming;
	},
	set streaming(next: boolean) {
		streaming = next;
	},
	get restarting(): boolean {
		return restarting;
	},
	set restarting(next: boolean) {
		restarting = next;
	},
	get reconnect(): StreamReconnectStatus | null {
		return reconnect;
	},
	set reconnect(next: StreamReconnectStatus | null) {
		reconnect = next;
	},
	reset(): void {
		streaming = false;
		restarting = false;
		reconnect = null;
	},
};
