<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

interface Props {
	isStreaming: boolean;
	/**
	 * The device cannot confirm whether a stream is running (an unconfirmed
	 * lifecycle with `is_streaming` false). The "Not streaming" chip would claim
	 * the opposite of the band below it, so it is withheld; the band is the
	 * role=status statement of what the device knows.
	 */
	unconfirmed?: boolean;
	/**
	 * A supervised connection restart is between its Stop and its Start. The
	 * operator stopped nothing, so the chip says the connection is restarting
	 * instead of "Not streaming".
	 */
	restarting?: boolean;
}

const { isStreaming, unconfirmed = false, restarting = false }: Props = $props();
</script>

<!-- Header: stream status + title only (T12 demotion). The server destination now
     lives in the GoLiveCard traffic-light row (T10), so the header no longer hosts
     a server-edit chip — it is title + live-state chip only.
     The chip never wraps or shrinks: at 390 px a two-line "NOT / STREAMING" pill
     reads as two labels, and it is the state a streamer glances at. Below `sm`
     the subtitle is screen-reader only, and while streaming the title is too:
     the bottom nav already says Live, so the header is the state chip alone. -->
<header class="flex items-center gap-3" class:short-live={isStreaming && !unconfirmed}>
	{#if isStreaming}
		<span
			class="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
			style="color: var(--status-live); border-color: color-mix(in oklab, var(--status-live) 40%, transparent); background-color: color-mix(in oklab, var(--status-live) 12%, transparent);"
		>
			<span
				class="h-2 w-2 shrink-0 rounded-full motion-safe:animate-pulse"
				style="background-color: var(--status-live);"
			></span>
			{m["live.streamingActive"]()}
		</span>
	{:else if restarting}
		<span
			class="text-muted-foreground flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
			role="status"
			data-testid="live-header-restarting"
		>
			<span class="bg-status-warning h-2 w-2 shrink-0 rounded-full motion-safe:animate-pulse"></span>
			{m["live.restartingConnection"]()}
		</span>
	{:else if !unconfirmed}
		<span
			class="text-muted-foreground flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
		>
			<span class="bg-muted-foreground/50 h-2 w-2 shrink-0 rounded-full"></span>
			{m["live.notStreaming"]()}
		</span>
	{/if}
	<div class="min-w-0">
		<h1 class={['text-2xl font-bold tracking-tight', isStreaming && !unconfirmed && 'max-sm:sr-only']}>{m["live.title"]()}</h1>
		<p class="text-muted-foreground sr-only text-sm sm:not-sr-only">{m["live.description"]()}</p>
	</div>
</header>

<style>
	@media (orientation: landscape) and (max-height: 420px) and (width < 1024px) {
		.short-live > div {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}
</style>
