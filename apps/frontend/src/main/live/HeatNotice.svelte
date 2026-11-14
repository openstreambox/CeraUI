<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Button } from '$lib/components/ui/button';
import { rpc } from '$lib/rpc/client';
import { getStatus } from '$lib/rpc/subscriptions.svelte';

let status = $derived(getStatus()?.heat);
let unavailable = $state(false);
let pending = $state(false);
let clientFailed = $state(false);
async function clientAction(action: 'pause' | 'restore', id: string | null | undefined) {
 if (!id || pending) return;
 pending = true;
 try { clientFailed = !(await rpc.streaming.linkBoxHeatAction({ action, id })).success; }
 catch { clientFailed = true; }
 finally { pending = false; }
}
async function toggle() {
 pending = true;
 try {
  const result = await rpc.streaming.keepHeatQuality({ enabled: !status?.keepQuality });
  unavailable = !result.success;
 } catch { unavailable = true; }
 finally { pending = false; }
}
</script>

{#if status?.supplyUnproven || status?.packJump || status?.protectionReduced || status?.packDatasheet || status?.packUnprotected || unavailable || status?.unknown || (status && (status.stage > 0 || status.history.length > 0))}
 <aside class="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm" aria-label={m['live.heat.title']()}>
  <p role="status">
   {#if unavailable || status?.error}{m['live.heat.failed']()}
   {:else if status?.unknown}{m['live.heat.unknown']()}
   {:else if status?.keepQuality && !status.reduced && status.ceiling !== null}{#if status.stage === 3}{m['live.heat.critical']()}. {/if}{m['live.heat.keepWarning']()}
   {:else if status?.cannotReduce && !status.keepQuality}{m['live.heat.cannotReduce']()}
   {:else if status?.reduced && status.ceiling !== null}{m['live.heat.capped']({bitrate:(status.ceiling/1000).toFixed(1)})}
   {:else if status && status.stage >= 2}{status.stage === 3 ? m['live.heat.critical']() : m['live.heat.hot']()}
   {:else if status?.stage === 0}{m['live.heat.restored']()}
   {:else}{m['live.heat.warm']()}{/if}
  </p>
  {#if status?.protectionReduced}<p>{m['live.heat.protection']()}</p>{/if}
  {#if status?.supplyUnproven}<p>{m['live.heat.supplyUnproven']()}</p>{/if}
  {#if status?.packJump}<p>{m['live.heat.packJump']()}</p>{/if}
  {#if status?.packDatasheet}<p>{m['live.heat.datasheet']()}</p>{/if}
  {#if status?.packUnprotected}<p>{m['live.heat.unprotected']()}</p>{/if}
  {#if status?.restingLink}<p>{m['live.heat.resting']({link:status.restingLink})}</p>
  {:else if status?.restUnavailable}<p>{m['live.heat.restUnknown']()}</p>{/if}
  {#if status?.modemUnavailable}<p>{m['live.heat.modemUnavailable']()}</p>{/if}
  {#if status && status.stage >= 2}<p class="mt-1 text-muted-foreground">{m['live.heat.air']()}</p>{#if status.phoneAdvice}<p>{m['live.heat.phone']()}</p>{/if}{/if}
  {#if status && status.stage > 0}
   <Button variant="outline" size="sm" class="mt-2" disabled={pending} onclick={toggle} aria-pressed={status.keepQuality}>{m['live.heat.keep']()}</Button>
  {/if}
  {#if clientFailed}<p role="alert">{m['live.heat.clientFailed']()}</p>{/if}
  {#if status?.linkBox?.paused}
   <p>{m['live.heat.clientPaused']()}</p>
   <Button variant="outline" size="sm" disabled={pending} onclick={() => clientAction('restore', status?.linkBox?.paused)}>{m['live.heat.letBackOn']()}</Button>
  {:else if status?.linkBox?.suggestion}
   <Button variant="outline" size="sm" disabled={pending} onclick={() => clientAction('pause', status?.linkBox?.suggestion)}>{m['live.heat.pauseDevice']()}</Button>
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
