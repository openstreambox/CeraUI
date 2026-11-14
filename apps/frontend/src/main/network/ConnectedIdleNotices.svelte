<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LinkSignal } from '$lib/types/hud';

const { links }: { links: LinkSignal[] } = $props();
</script>

<div aria-live="polite">
 {#each links as link (link.id)}
  <details class="mx-auto my-4 max-w-3xl rounded-lg border p-3 text-sm" data-testid="live-connected-idle-notice">
   <summary>{m["network.view.connectedIdle"]({ link: link.label })}</summary>
   <p class="text-muted-foreground mt-1 text-xs">{m["network.view.connectedIdleDetails"]()}</p>
  </details>
 {/each}
</div>
