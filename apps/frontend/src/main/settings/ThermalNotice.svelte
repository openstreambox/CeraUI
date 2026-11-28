<!--
  ThermalNotice.svelte — the one temperature line at the top of Settings.

  Device stats (lower on the page) always shows the SoC temperature, and Device
  Health shows its trend. This line appears only when the reading asks for
  attention (`thermalBand`: warm from 70 °C, hot from 85 °C), so the top of
  Settings carries no engineering telemetry while the box is fine. A tap opens
  Device Health.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { ChevronRight, Thermometer } from '@lucide/svelte';

import { getDeviceStats } from '$lib/rpc/subscriptions.svelte';
import { thermalBand } from '$lib/system/thermal';
import { cn } from '$lib/utils';

interface Props {
	onOpen: () => void;
}

const { onOpen }: Props = $props();

const temp = $derived(getDeviceStats()?.socTemp ?? null);
const band = $derived(thermalBand(temp));
const reading = $derived(temp === null ? '' : `${temp.toFixed(1)} °C`);
const title = $derived(band === 'hot' ? m["settings.thermal.hot"]() : m["settings.thermal.warm"]());
</script>

{#if band}
	<button
		type="button"
		class={cn(
			'flex w-full items-center gap-4 rounded-xl border px-4 py-3.5 text-start transition-colors',
			'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
			band === 'hot'
				? 'border-destructive/40 bg-destructive/10 hover:bg-destructive/15'
				: 'border-status-warning/40 bg-status-warning/10 hover:bg-status-warning/15',
		)}
		data-band={band}
		data-testid="settings-thermal-notice"
		onclick={onOpen}
	>
		<span
			class={cn(
				'grid size-9 shrink-0 place-items-center rounded-lg',
				band === 'hot' ? 'bg-destructive/15 text-destructive' : 'bg-status-warning/15 text-status-warning',
			)}
		>
			<Thermometer aria-hidden="true" class="size-[18px]" />
		</span>
		<span class="min-w-0 flex-1">
			<span class="block text-sm font-semibold">
				{title}
				<span class="font-mono tabular-nums">· {reading}</span>
			</span>
			<span class="text-muted-foreground block text-xs">{m["settings.thermal.detail"]()}</span>
		</span>
		<ChevronRight aria-hidden="true" class="text-muted-foreground/70 size-4 shrink-0 rtl:-scale-x-100" />
	</button>
{/if}
