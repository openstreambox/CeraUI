<!--
  WifiSavedHybridBand.svelte — a saved Hybrid choice this radio cannot run.

  The device keeps a persisted `hybrid` preference (and the hotspot settings)
  on a radio that does not qualify for it, stays a station and starts no AP.
  Without this band the row would read as an ordinary station and the saved
  choice would look silently dropped. It states the refusal and offers the one
  explicit way out on this radio, an exclusive hotspot; the other way out, a
  hotspot on another radio, needs no control here.

  Like `WifiModeErrorBand`, exactly one surface renders it per adapter: the
  selector inline, or the WiFi row when the selector sits in its popover.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { TriangleAlert } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';

import { wifiModeLabelKey } from './wifi-adapter-mode-view';

interface Props {
	device: string;
	/** Offered only when this radio can host an exclusive hotspot. */
	onSwitch?: () => void;
	switchDisabled?: boolean;
}

const { device, onSwitch, switchDisabled = false }: Props = $props();
</script>

<div
	class="border-status-warning/30 bg-status-warning/10 flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
	data-testid="wifi-mode-saved-hybrid-{device}"
	role="status"
>
	<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-3.5 shrink-0" />
	<div class="min-w-0 space-y-1.5">
		<p class="text-status-warning text-xs font-semibold">
			{m["network.wifiMode.savedHybrid.title"]()}
		</p>
		<p class="text-muted-foreground text-xs">{m["network.wifiMode.savedHybrid.body"]()}</p>
		{#if onSwitch}
			<Button
				class="h-8 min-h-[var(--touch-target-min)] px-2.5"
				data-testid="wifi-mode-saved-hybrid-switch-{device}"
				disabled={switchDisabled}
				onclick={onSwitch}
				size="sm"
				variant="secondary"
			>
				{m["network.wifiMode.confirm.switchTo"]({
					mode: resolveMessageKey(wifiModeLabelKey('hotspot')),
				})}
			</Button>
		{/if}
	</div>
</div>
