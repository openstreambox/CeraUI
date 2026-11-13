<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { onMount } from 'svelte';
import { rpc } from '$lib/rpc/client';
import { getWifi } from '$lib/rpc/subscriptions.svelte';

let phase = $state('idle');
let error = $state('');
let radio = $state('');
let busy = $state(false);
const radios = $derived(Object.entries(getWifi() ?? {}).filter(([, r]) => r.conn && !r.hotspot));
async function act(action: 'start' | 'finish' | 'status') {
 if (busy) return;
 busy = true;
 const popup = action === 'start' ? window.open('about:blank', '_blank') : null;
 if (popup) popup.opener = null;
 try {
  phase = (await rpc.wifi.portal({action, ...(action === 'start' ? {radio: Number(radio)} : {})})).phase;
  error = '';
  if (popup) popup.location.href = 'http://www.gstatic.com/generate_204';
 } catch { popup?.close(); if (action !== 'status') error = m['network.portal.unavailable'](); }
 finally { busy = false; }
}
onMount(() => { void act('status'); const timer = setInterval(() => void act('status'), 3000); return () => clearInterval(timer); });
</script>

{#if radios.length > 0}
<section aria-label="Wi-Fi sign-in" class="rounded-lg border p-4 space-y-2">
 <h3>{m['network.portal.title']()}</h3>
 <p>{m['network.portal.intro']()}</p>
 {#if phase === 'signing_in'}
  <p>{m['network.portal.waiting']()}</p>
  <a href="http://www.gstatic.com/generate_204" target="_blank" rel="noopener noreferrer">{m['network.portal.again']()}</a>
  <button type="button" disabled={busy} onclick={() => act('finish')}>{m['network.portal.finish']()}</button>
  <button type="button" disabled={busy} onclick={() => act('finish')}>{m['network.portal.cancel']()}</button>
 {:else if phase === 'checking'}
  <p>{m['network.portal.checking']()}</p>
 {:else if phase === 'cleanup_unknown'}
  <p>{m['network.portal.closing']()}</p>
  <button type="button" disabled={busy} onclick={() => act('finish')}>{m['network.portal.retryClose']()}</button>
 {:else}
  {#if phase === 'needs_sign_in'}<p>{m['network.portal.closed']()}</p>{/if}
  {#if phase === 'web_available'}<p>{m['network.portal.available']()}</p>{/if}
  <label>Wi-Fi <select bind:value={radio}><option value="">{m['network.portal.choose']()}</option>{#each radios as [id, r] (id)}<option value={id}>{r.hw || `Wi-Fi ${id}`}</option>{/each}</select></label>
  <p>{m['network.portal.duration']()}</p>
  <button type="button" disabled={busy || radio === ''} onclick={() => act('start')}>{m['network.portal.open']()}</button>
 {/if}
 {#if error}<p role="status">{error}</p>{/if}
</section>
{/if}
