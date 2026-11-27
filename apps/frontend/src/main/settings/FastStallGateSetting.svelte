<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Gauge } from '@lucide/svelte';
import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import { osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig } from '$lib/rpc/subscriptions.svelte';

// The sender's fast stall gate, a per-box setting that applies at the next
// stream start. Pessimistic like autostart: the position follows the config
// broadcast and the persisted `applied` value, and a failed write reverts it.
let enabled = $derived(getConfig()?.srtla_fast_stall_gate === true);

async function change(next: boolean) {
	const result = await osCommand({
		key: 'fast-stall-gate',
		target: next,
		rpc: () => rpc.system.setFastStallGate({ enabled: next }),
		confirmOnResolve: true,
		failMessage: () => m['settings.index.fastStallGateError'](),
	});
	if (!result?.success) throw new Error('fast_stall_gate_failed');
	enabled = result.applied.enabled;
}
</script>

<div class="flex w-full items-center gap-4 px-4 py-3.5" data-testid="settings-fast-stall-gate">
	<span class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg">
		<Gauge class="size-[18px]" />
	</span>
	<span class="text-slot">
		<span class="block text-sm font-semibold">{m['settings.index.fastStallGate']()}</span>
		<span class="text-muted-foreground block text-xs">{m['settings.index.fastStallGateDesc']()}</span>
	</span>
	<span class="shrink-0">
		<AsyncSwitch
			aria-label={m['settings.index.fastStallGate']()}
			checked={enabled}
			data-testid="settings-fast-stall-gate-switch"
			onCheckedChange={change}
		/>
	</span>
</div>
