<script lang="ts">
import {m} from '@ceraui/i18n/svelte';
import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import { Button } from '$lib/components/ui/button';
import {rpc} from '$lib/rpc/client';
import {getConfig} from '$lib/rpc/subscriptions.svelte';

let error = $state(false);
let busy = $state(false);
let requested = $state(false);
let enabled = $derived(getConfig()?.captive_portal_enabled === true);
async function change(next: boolean) {
 if (busy) return;
 busy = true;
 requested = next;
 error = false;
 try {
 await rpc.wifi.portal({action: 'configure', enabled: next});
 enabled = next;
 } catch {error = true;}
 finally {busy = false;}
}
</script>
<div class="space-y-2 rounded-xl border p-4">
 <h2>{m['settings.portal.experimentalTitle']()}</h2>
 <p>{m['settings.portal.experimentalDescription']()}</p>
 <AsyncSwitch aria-label={m['settings.portal.experimentalTitle']()} checked={enabled} disabled={busy} onCheckedChange={change} />
{#if error}<p role="status">{m['settings.portal.experimentalSaveError']()}</p><Button variant="outline" disabled={busy} onclick={() => change(requested)}>{m['errorBoundary.retry']()}</Button>{/if}
</div>
