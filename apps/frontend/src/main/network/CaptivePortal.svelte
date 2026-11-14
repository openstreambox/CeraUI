<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { onMount } from 'svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig, getWifi } from '$lib/rpc/subscriptions.svelte';

let phase = $state('idle');
let now = $state(Date.now());
let expiresAt = $state<number | undefined>();
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
  const status = await rpc.wifi.portal({action, ...(action === 'start' ? {radio: Number(radio)} : {})});
  phase = status.phase;
  expiresAt = status.expiresAt;
  error = '';
  if (popup) popup.location.href = 'http://www.gstatic.com/generate_204';
 } catch (cause) {
 popup?.close();
 if (action !== 'status') {
 const reason = cause instanceof Error ? cause.message : '';
 switch (reason) {
 case 'experimental_disabled': error = m['network.portal.experimentalDisabled'](); break;
 case 'ipv4_required': error = m['network.portal.ipv4_required'](); break;
 case 'not_captive': error = m['network.portal.not_captive'](); break;
 case 'wifi_changed': error = m['network.portal.wifi_changed'](); break;
 case 'identity_unavailable': error = m['network.portal.identity_unavailable'](); break;
 case 'cleanup_required': error = m['network.portal.cleanup_required'](); break;
 case "Sign in from the box's Wi-Fi.":
 case 'not_on_box_wifi': error = m['network.portal.not_on_box_wifi'](); break;
 case 'busy_other_phone': error = m['network.portal.busy_other_phone'](); break;
 case 'wifi_unavailable': error = m['network.portal.wifi_unavailable'](); break;
 default: error = m['network.portal.unavailable']();
 }
 }
 }
 finally { busy = false; }
}
onMount(() => { if (getConfig()?.captive_portal_enabled !== true) return; void act('status'); const timer = setInterval(() => { now = Date.now(); void act('status'); }, 3000); return () => clearInterval(timer); });
</script>

{#if getConfig()?.captive_portal_enabled === true && radios.length > 0}
<section aria-label={m['network.portal.title']()} class="rounded-lg border p-4 space-y-2">
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
  <label>{m['network.portal.choose']()} <select bind:value={radio}><option value="">{m['network.portal.choose']()}</option>{#each radios as [id, r] (id)}<option value={id}>{r.hw || `${m['network.sharing.kind.wifi']()} ${id}`}</option>{/each}</select></label>
  <p>{m['network.portal.duration']()}</p>
  <button type="button" disabled={busy || radio === ''} onclick={() => act('start')}>{m['network.portal.open']()}</button>
 {/if}
 {#if expiresAt && expiresAt > now && (phase === 'signing_in' || phase === 'cleanup_unknown')}
 <p>{m['network.portal.expires']({time: new Date(expiresAt).toLocaleTimeString()})}</p>
 {/if}
 {#if error}<p role="status">{error}</p>{/if}
</section>
{/if}
