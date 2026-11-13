<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { ModemList, NetifMessage, WifiStatus } from '@ceraui/rpc/schemas';

const { wifi, modems, netif }: {wifi: WifiStatus | undefined; modems: ModemList | undefined; netif: NetifMessage | undefined} = $props();
</script>
<div class="mx-auto max-w-5xl space-y-4 p-4" data-testid="remote-network-status">
 <p role="status">{m['network.view.remotePrivacy']()}</p>
 {#each Object.entries(wifi ?? {}) as [key, radio] (key)}
 <div class="rounded-lg border p-3"><strong>{radio.ifname}</strong><p>{radio.conn && radio.mode !== 'hotspot' ? m['network.view.connected']() : m['network.view.disconnected']()}</p></div>
 {/each}
 {#each Object.entries(modems ?? {}) as [key, modem] (key)}
 <div class="rounded-lg border p-3"><strong>{modem.name}</strong><p>{modem.status?.connection === 'connected' ? m['network.view.connected']() : ['enabled', 'registered', 'disabled'].includes(modem.status?.connection ?? '') ? m['network.view.disconnected']() : '—'}</p><p>{modem.status?.signal === undefined ? '—' : `${modem.status.signal} %`}</p></div>
 {/each}
 {#each Object.entries(netif ?? {}) as [name, link] (name)}
 <div class="rounded-lg border p-3"><strong>{name}</strong><p>{link.tx_bps ?? '—'} bps ↑ · {link.rx_bps ?? '—'} bps ↓</p></div>
 {/each}
</div>
