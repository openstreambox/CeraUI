<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Button } from '$lib/components/ui/button';
import { rpc } from '$lib/rpc/client';
import { getStatus } from '$lib/rpc/subscriptions.svelte';

let status = $derived(getStatus()?.heat);
let unavailable = $state(false);
let pending = $state(false);
async function toggle() {
 pending = true;
 try {
  const result = await rpc.streaming.keepHeatQuality({ enabled: !status?.keepQuality });
  unavailable = !result.success;
 } catch { unavailable = true; }
 finally { pending = false; }
}
</script>

{#if unavailable || status?.unknown || (status && (status.stage > 0 || status.history.length > 0))}
 <aside class="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm" aria-label={m['live.heat.title']()}>
  <p role="status">
   {#if unavailable || status?.error}{m['live.heat.failed']()}
   {:else if status?.unknown}{m['live.heat.unknown']()}
   {:else if status?.keepQuality && !status.reduced && status.ceiling !== null}{#if status.stage === 3}{m['live.heat.critical']()}. {/if}{m['live.heat.keepWarning']()}
   {:else if status && status.stage >= 2 && status.reduced && status.ceiling !== null}{m['live.heat.capped']({bitrate:(status.ceiling/1000).toFixed(1)})}
   {:else if status && status.stage >= 2}{status.stage === 3 ? m['live.heat.critical']() : m['live.heat.hot']()}
   {:else if status?.stage === 0}{m['live.heat.restored']()}
   {:else}{m['live.heat.warm']()}{/if}
  </p>
  {#if status && status.stage >= 2}<p class="mt-1 text-muted-foreground">{m['live.heat.air']()}</p>{#if status.phoneAdvice}<p>{m['live.heat.phone']()}</p>{/if}{/if}
  {#if status && status.stage > 0}
   <Button variant="outline" size="sm" class="mt-2" disabled={pending} onclick={toggle} aria-pressed={status.keepQuality}>{m['live.heat.keep']()}</Button>
  {/if}
  {#if status?.history.length}
   <details class="mt-2 text-muted-foreground">
    <summary>{m['live.heat.history']()}</summary>
    {#each status.history as entry, index (index)}
     <p>{new Date(entry.at).toLocaleTimeString()} · {m['live.heat.historyEntry']({stage:entry.stage === 3 ? m['live.heat.critical']() : entry.stage === 2 ? m['live.heat.hot']() : entry.stage === 1 ? m['live.heat.warmStage']() : m['live.heat.normal'](),bitrate:(entry.ceiling/1000).toFixed(1)})}</p>
    {/each}
   </details>
  {/if}
 </aside>
{/if}
