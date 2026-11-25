/**
 * A REACTIVE `tailscale` status-feed double (mirrors `ssh-feed.svelte.ts`).
 * The production getter reads a `$state`, so a plain mutable object would leave
 * the dialog's `$derived` inert and the pessimistic assertions would pass
 * vacuously.
 */
import type { TailscaleStatus } from "@ceraui/rpc/schemas";

let feed = $state<TailscaleStatus | undefined>(undefined);

export function getTailscaleFeed(): TailscaleStatus | undefined {
	return feed;
}

export function publishTailscale(next: TailscaleStatus | undefined): void {
	feed = next;
}

export function resetTailscaleFeed(): void {
	feed = undefined;
}
