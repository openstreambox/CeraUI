<!--
  LinkCarryingNote.svelte: "No stream data on this link" for one bonded link.

  The caller decides `show` from the backend's verdict only: a Live row's own
  `carrying === false` (and not stale), or a device listed in the feed's
  `not_carrying_ifaces` for a card that stands for the whole device. The
  backend already requires comparable evidence over several seconds, so this
  never flickers at stream start or on one stray packet.

  The wording and the muted look are deliberate: a link without stream data may
  be failing or may be a spare the sender is not using right now, and the
  backend cannot tell those apart. It states the fact, not a fault.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

import { cn } from '$lib/utils';

interface Props {
	show: boolean;
	iface?: string;
	class?: string;
}

const { show, iface = undefined, class: className = undefined }: Props = $props();
</script>

{#if show}
	<p
		data-testid="link-carrying-nothing"
		data-iface={iface}
		role="status"
		class={cn('text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs', className)}
	>
		<span aria-hidden="true" class="bg-muted-foreground size-1.5 shrink-0 rounded-full"></span>
		<span class="min-w-0">{m["network.view.noStreamData"]()}</span>
	</p>
{/if}
