<script lang="ts">
import { localizePowerText } from '@ceraui/i18n/formatters';
import { type MessageKey, m } from '@ceraui/i18n/svelte';
import type { SensorsStatus } from '@ceraui/rpc/schemas';

let { sensors, connected }: { sensors?: Partial<SensorsStatus>; connected: boolean } = $props();
let receivedAt = $state(0);
let now = $state(0);
// The backend's Power sample changes on every sample, including unchanged conditions.
const marker = $derived(sensors?.Power ? (sensors["Power sample"] ?? sensors) : undefined);
let lastMarker: unknown;
$effect(() => {
 const sample = marker;
 if (!sample || !connected) { lastMarker = undefined; return; }
 const received = performance.now();
 if (sample !== lastMarker) { receivedAt = received; lastMarker = sample; }
 now = received;
 const timer = setInterval(() => { now = performance.now(); }, 1000);
 return () => clearInterval(timer);
});
const fresh = $derived(connected && now - receivedAt < 5000);
const readings = $derived((["Bank A", "Bank B", "Reserve pack"] as const).filter(name => sensors?.[name] !== undefined));
const localize = (text: string) => localizePowerText(text, (key, params) => m[key as MessageKey](params));
</script>

{#if sensors?.Power}
 <section class="rounded-lg border px-4 py-3 text-sm" data-testid="power-status">
  <p role="status">{fresh ? localize(sensors.Power) : m["notifications.power.unavailable"]()}</p>
  {#if fresh && readings.length > 0}
   <details class="mt-2 text-muted-foreground">
    <summary class="cursor-pointer">{m["hud.sensors"]()}</summary>
    {#each readings as name (name)}
     <p class="mt-1">{localize(name)}: {localize(sensors?.[name] ?? "")}</p>
    {/each}
   </details>
  {/if}
 </section>
{/if}
