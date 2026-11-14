<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Gauge } from '@lucide/svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { rpc } from '$lib/rpc/client';

let { open = $bindable(false) }: { open?: boolean } = $props();
let mode = $state<'auto' | 'suggest'>('auto');
let pending = $state(true);
let failed = $state(false);
let active = $state(false);
async function load() {
 pending = true;
 failed = false;
 try {
  const result = await rpc.streaming.getLinkBoxHeat();
  mode = result.mode;
  active = result.active;
 } catch { failed = true; }
 finally { pending = false; }
}
$effect(() => { if (open) void load(); });
async function change(event: Event) {
 const input = event.currentTarget as HTMLInputElement;
 const next = input.checked ? 'suggest' : 'auto';
 input.checked = mode === 'suggest';
 pending = true;
 failed = false;
 try {
  const result = await rpc.streaming.setLinkBoxHeatMode({ mode: next });
  mode = result.mode;
  failed = !result.success;
 } catch { failed = true; }
 finally { pending = false; }
}
</script>
<AppDialog bind:open title={m['settings.heat.title']()} description={m['settings.heat.description']()} icon={Gauge}>
 <div class="space-y-4 text-sm">
  <p>{m['settings.heat.automatic']()}</p>
  <label class="flex items-center gap-3 rounded-lg border p-3">
   <input type="checkbox" checked={mode === 'suggest'} disabled={pending} onchange={change} />
   <span>{m['settings.heat.suggest']()}</span>
  </label>
  <p class="text-muted-foreground">{m['settings.heat.suggestHelp']()}</p>
  {#if !active}<p>{m['settings.heat.dormant']()}</p>{/if}
  {#if failed}<p role="alert">{m['settings.heat.failed']()}</p>{/if}
 </div>
</AppDialog>
