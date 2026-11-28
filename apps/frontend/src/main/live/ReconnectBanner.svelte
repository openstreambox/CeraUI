<script lang="ts">
/**
 * The Live banner after every link was lost (docs/agents/live-screen.md).
 *
 * While the device reconnects it counts down the time left from the moment the
 * status arrived (the device's clock never meets the browser's) and offers
 * "Keep trying", which gives another full window. After the window ran out it
 * says what was missing and offers "Keep trying" again; Stop stays in the Live
 * bar in both states and always wins. It never says "not live" or "offline":
 * the receiver shows its BRB scene while the box reconnects.
 */
import { m } from '@ceraui/i18n/svelte';
import type { StreamReconnectStatus } from '@ceraui/rpc/schemas';
import { RefreshCw, TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { keepReconnecting } from '../notifications/notification-presentation';

interface Props {
	reconnect: StreamReconnectStatus;
	/** Tests only: the clock the countdown reads. */
	now?: () => number;
}

const { reconnect, now = Date.now }: Props = $props();

let deadline = $state(0);
let clock = $state(0);
let busy = $state(false);

// A fresh status (a new window, "Keep trying", or a full snapshot) resets the
// countdown from its own `remaining_ms`.
$effect.pre(() => {
	if (reconnect.state !== 'reconnecting') return;
	// A new token is a new window run (Keep trying), even at the same time left.
	void reconnect.token;
	const remaining = reconnect.remaining_ms;
	const start = now();
	deadline = start + remaining;
	clock = start;
});

$effect(() => {
	if (reconnect.state !== 'reconnecting') return;
	const timer = setInterval(() => {
		clock = now();
	}, 1000);
	return () => clearInterval(timer);
});

const left = $derived.by(() => {
	const seconds = Math.max(0, Math.ceil((deadline - clock) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

async function keepTrying() {
	if (busy) return;
	busy = true;
	try {
		await keepReconnecting(reconnect.token);
	} finally {
		busy = false;
	}
}

const BAND_CLASS = 'border-status-warning/50 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3';
const ICON_CLASS = 'text-status-warning mt-0.5 size-4 shrink-0';
</script>

<div class={BAND_CLASS} data-testid="live-reconnect-banner" data-state={reconnect.state} role="status">
	{#if reconnect.state === 'reconnecting'}
		<RefreshCw aria-hidden={true} class="{ICON_CLASS} motion-safe:animate-spin" />
	{:else}
		<TriangleAlert aria-hidden={true} class={ICON_CLASS} />
	{/if}
	<div class="min-w-0 flex-1 space-y-2">
		<div class="space-y-0.5">
			{#if reconnect.state === 'reconnecting'}
				<p class="text-status-warning text-sm font-medium">
					{m['live.reconnectingTitle']()}
					<span aria-hidden="true">·</span>
					<span class="tabular-nums" data-testid="live-reconnect-left">{m['live.reconnectingLeft']({ time: left })}</span>
				</p>
				<p class="text-muted-foreground text-xs">{m['live.reconnectingBody']()}</p>
			{:else}
				<p class="text-status-warning text-sm font-medium">
					{reconnect.reason === 'no_link' ? m['live.reconnectExpiredNoLink']() : m['live.reconnectExpiredStartFailed']()}
				</p>
				<p class="text-muted-foreground text-xs">{m['live.reconnectExpiredBody']()}</p>
			{/if}
		</div>
		<Button size="sm" variant="outline" disabled={busy} data-testid="live-reconnect-keep-trying" onclick={keepTrying}>
			{m['notifications.keepTrying']()}
		</Button>
	</div>
</div>
