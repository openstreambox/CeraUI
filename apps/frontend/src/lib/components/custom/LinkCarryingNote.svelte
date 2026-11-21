<!--
  LinkCarryingNote.svelte: "Connected, but sending nothing" for one bonded link.

  Shown only when the backend positively says the link carries no stream data
  (`carrying === false`: in the bond, fresh reports, its sent-bytes counter still
  for several seconds) and the row is not stale. An absent `carrying` makes no
  claim, so nothing renders; the backend already applies the dwell, so this does
  not flicker at stream start or on one stray packet.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry } from '@ceraui/rpc/schemas';

import { cn } from '$lib/utils';

interface Props {
	entry: LinkTelemetryEntry | undefined;
	class?: string;
}

const { entry, class: className = undefined }: Props = $props();

const show = $derived(entry?.carrying === false && entry.stale !== true);
</script>

{#if show}
	<p
		data-testid="link-carrying-nothing"
		data-iface={entry?.iface}
		role="status"
		class={cn('text-status-warning flex min-w-0 items-center gap-1.5 text-xs', className)}
	>
		<span aria-hidden="true" class="bg-status-warning size-1.5 shrink-0 rounded-full"></span>
		<span class="min-w-0">{m["network.view.carryingNothing"]()}</span>
	</p>
{/if}
