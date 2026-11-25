<!--
  ModemRestartButton.svelte: the one control that starts Restart modem. It only
  asks: the confirmation, the progress and the result belong to the section's
  ModemRestartControl, because the row this button sits in unmounts while the
  modem restarts.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { RotateCcw } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import type { ModemRestartFlow, ModemRestartTarget } from '$lib/modem/modem-restart.svelte';
import { getIsStreaming } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

let {
	flow,
	target,
	class: className = '',
}: {
	flow: ModemRestartFlow;
	target: ModemRestartTarget;
	class?: string;
} = $props();

const busy = $derived(flow.busy);
</script>

<Button
	class={cn('h-8 min-h-[var(--touch-target-min)] w-fit gap-1 px-2.5', className)}
	data-testid="modem-restart"
	data-stable-key={target.stableKey}
	size="sm"
	variant="outline"
	disabled={busy}
	title={busy ? m['network.restart.busy']() : undefined}
	onclick={() => flow.ask(target, getIsStreaming())}
>
	<RotateCcw class="size-3.5" aria-hidden="true" />
	{m['network.restart.action']()}
</Button>
