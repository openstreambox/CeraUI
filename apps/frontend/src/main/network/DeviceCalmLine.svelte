<!--
  One calm line for intentional device states. Faults do not come here.
  Both counts at zero render nothing.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { DeviceCalm } from '@ceraui/rpc/schemas';
import { Info } from '@lucide/svelte';

interface Props {
	calm: DeviceCalm | undefined;
	onOpen: () => void;
}

const { calm, onOpen }: Props = $props();

const resting = $derived(calm?.resting ?? 0);
const off = $derived(calm?.off ?? 0);

function restingText(count: number, joined: boolean): string {
	if (count === 1 && calm?.restingKind === 'wifi') {
		const text = m['network.devices.calm.restingWifi']().replace(/[.。]$/, '');
		return joined ? text : `${text}.`;
	}
	return count === 1
		? m['network.devices.calm.restingOne']()
		: m['network.devices.calm.restingMany']({ count });
}

function offText(count: number): string {
	if (count === 1 && calm?.offKind === 'modem' && calm.offAt) {
		return m['network.devices.calm.offModemAt']({ time: calm.offAt });
	}
	if (count === 1 && calm?.offKind === 'modem') return m['network.devices.calm.offModem']();
	return count === 1
		? m['network.devices.calm.offOne']()
		: m['network.devices.calm.offMany']({ count });
}
</script>

{#if resting > 0 || off > 0}
	<div
		role="status"
		data-testid="device-calm-line"
		class="bg-status-info/10 border-status-info/30 flex items-start gap-3 rounded-xl border p-4"
	>
		<Info class="text-status-info mt-0.5 size-5 shrink-0" aria-hidden="true" />
		<p class="min-w-0 flex-1 text-sm">
			{#if resting > 0 && off > 0}
				{restingText(resting, true)}{m['network.devices.calm.join']()}{offText(off)}
			{:else if resting > 0}
				{restingText(resting, false)}
			{:else}
				{offText(off)}
			{/if}
		</p>
		<button
			type="button"
			data-testid="device-calm-open"
			class="focus-visible:ring-ring min-h-11 shrink-0 rounded-md px-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
			onclick={onOpen}
		>
			{m['network.devices.open']()}
		</button>
	</div>
{/if}
