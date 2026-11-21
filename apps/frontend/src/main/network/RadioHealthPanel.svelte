<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { RadioHealth, RadioMetric } from '@ceraui/rpc/schemas';

let { radio, id, network }: { radio: RadioHealth; id: string; network: string } = $props();
const value = (v: RadioMetric) => v.value === null ? m['network.radio.unavailable']() : `${v.value} ${v.unit}`;
const lines = $derived({
 'unknown': m['network.radio.unknown']({id}),
 'sim-account': m['network.radio.sim']({id,network}),
 'data-path': m['network.radio.data']({id,network}),
 'disturbed': m['network.radio.disturbed']({id,neighbour:radio.finding.neighbour??'?'}),
});
const actions = $derived({
 'unknown': m['network.radio.wait'](), 'sim-account':m['network.radio.simAction'](),
 'data-path':m['network.radio.dataAction']({id}), 'disturbed':m['network.radio.disturbedAction']({id}),
});
const readings = $derived<[string, RadioMetric][]>([[m['network.radio.registration'](),radio.registration],[m['network.radio.layer'](),radio.layer],[m['network.radio.band'](),radio.band],...Object.entries(radio.metrics)]);
</script>
<section aria-label={m['network.radio.title']()} data-testid="radio-health" class="space-y-2 text-sm">
 <h4>{m['network.radio.title']()}</h4>
 <p>{radio.finding.kind==='unknown'?'?':'◐'} {lines[radio.finding.kind]}</p>
 <p>{radio.finding.kind==='unknown'?m['network.radio.unknownConfidence']():radio.finding.confidence==='possible'?m['network.radio.possible']():m['network.radio.likely']()} · {actions[radio.finding.kind]}</p>
 <dl class="grid grid-cols-2 gap-1">
 {#each readings as [name,field] (name)}
  <dt>{name}</dt><dd>{value(field)} <small>({field.source} · {field.technology} · {field.value===null?'—':new Date(field.capturedAt).toLocaleTimeString()})</small></dd>
 {/each}
 </dl>
 {#each radio.neighbours as neighbour (neighbour.id)}
 <p>{m['network.radio.neighbour']({id:neighbour.id})}: {value(neighbour.band)} · {neighbour.transmitting==='yes'?m['network.radio.transmitting']():m['network.radio.unknownConfidence']()} <small>({neighbour.source} · {new Date(neighbour.capturedAt).toLocaleTimeString()})</small></p>
 {/each}
 <p>{m['network.radio.usb']()}: {radio.usb.available?radio.usb.events.length:m['network.radio.unavailable']()}</p>
 <details><summary>{m['network.radio.timeline']()}</summary>
 {#each radio.usb.events as event, index (`${event.at}-${index}`)}<p>{new Date(event.at).toLocaleTimeString()} · USB {event.kind}</p>{/each}
 {#each radio.timeline as event (event.at)}<p>{new Date(event.at).toLocaleTimeString()} · {event.finding.kind==='unknown'?'?':'◐'} · {event.finding.evidence.join(' · ')}{#if event.observation} · {value(event.observation.band)} · {value(event.observation.rsrp)} · {value(event.observation.quality)}{/if}</p>{/each}
 </details>
</section>
