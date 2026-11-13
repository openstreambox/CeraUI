<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { StatusResponse } from '@ceraui/rpc/schemas';

let { carrying }: { carrying?: StatusResponse['carrying'] } = $props();
</script>

{#if carrying}
 <span data-testid="carrying-status" class="text-muted-foreground max-w-[12rem] truncate text-xs" aria-live="polite">
  {#if carrying.state === 'streaming'}{m['carrying.active']()}
  {:else if carrying.state === 'unknown'}{m['carrying.unknown']()}
  {:else}{m['carrying.idle']()}{/if}
 </span>
{/if}
