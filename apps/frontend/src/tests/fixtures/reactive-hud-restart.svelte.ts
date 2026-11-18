/**
 * Reactive holders for the HUD's connection-restart test: the HUD reads the
 * stream state and the status inside `$derived`/`$effect`, so an edge (live,
 * then the restart's Stop) needs reads that genuinely re-run.
 */
let streaming = $state(false);
let restarting = $state(false);

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
	reset(): void {
		streaming = false;
		restarting = false;
	},
};
