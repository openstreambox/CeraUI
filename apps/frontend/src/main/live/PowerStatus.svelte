<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { SensorsStatus } from '@ceraui/rpc/schemas';

let { sensors, connected }: { sensors?: Partial<SensorsStatus>; connected: boolean } = $props();
let receivedAt = $state(0);
let now = $state(0);
// The backend's Power sample changes on every sample, including unchanged conditions.
$effect(() => {
 const sample = sensors;
 if (!sample?.Power || !connected) return;
 const received = performance.now();
 receivedAt = received;
 now = received;
 const timer = setInterval(() => { now = performance.now(); }, 1000);
 return () => clearInterval(timer);
});
const fresh = $derived(connected && now - receivedAt < 5000);
const readings = $derived((["Bank A", "Bank B", "Reserve pack"] as const).filter(name => sensors?.[name] !== undefined));
</script>

{#if sensors?.Power}
 <section class="rounded-lg border px-4 py-3 text-sm" data-testid="power-status">
  <p role="status">{fresh ? sensors.Power : 'Power data not available'}</p>
  {#if fresh && readings.length > 0}
   <details class="mt-2 text-muted-foreground">
    <summary class="cursor-pointer">{m["hud.sensors"]()}</summary>
    {#each readings as name (name)}
     <p class="mt-1">{name}: {sensors?.[name]}</p>
    {/each}
   </details>
  {/if}
 </section>
{/if}
