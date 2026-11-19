<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { SharingPolicy } from '@ceraui/rpc/schemas';
import { onMount } from 'svelte';
import { rpc } from '$lib/rpc/client';

let { interfaces = [] }: { interfaces?: string[] } = $props();
let policy = $state<SharingPolicy>();
let busy = $state(false);
let failed = $state(false);
async function load() {
	busy = true;
	try {
		policy = await rpc.network.getSharingPolicy();
		failed = false;
	} catch {
		failed = true;
	} finally {
		busy = false;
	}
}
onMount(() => { void load(); });
async function save(event: SubmitEvent) {
	event.preventDefault();
	if (!policy) return;
	busy = true;
	failed = false;
	try {
		policy = await rpc.network.setSharingPolicy($state.snapshot(policy));
	} catch {
		failed = true;
	} finally {
		busy = false;
	}
}
</script>

<details class="my-3 rounded-lg border p-3" data-testid="sharing-policy">
	<summary class="cursor-pointer text-sm font-medium">{m['network.sharing.policy.title']()}</summary>
	<p class="my-2 text-xs text-muted-foreground">{m['network.sharing.policy.help']()}</p>
	{#if failed}<p role="alert">{m['network.sharing.policy.failed']()}</p>{/if}
	{#if policy}
	<form onsubmit={save} class="flex flex-col gap-3">
	<fieldset disabled={busy} class="flex flex-col gap-3">
	<label>{m['network.sharing.policy.mode']()}
	<select bind:value={policy.mode} class="rounded border bg-background p-2">
	<option value="automatic">{m['network.sharing.policy.automatic']()}</option>
	<option value="wired-only">{m['network.sharing.policy.wired']()}</option>
	<option value="cellular-only">{m['network.sharing.policy.cellular']()}</option>
	</select></label>
	<p class="text-xs">{m['network.sharing.policy.priorities']()}</p>
	<label>{m['network.sharing.policy.wiredPriority']()} <input type="number" min="0" max="100" required bind:value={policy.priorities.wired} class="w-20 rounded border p-2" /></label>
	<label>{m['network.sharing.policy.cellularPriority']()} <input type="number" min="0" max="100" required bind:value={policy.priorities.cellular} class="w-20 rounded border p-2" /></label>
	<label>{m['network.sharing.policy.wifiPriority']()} <input type="number" min="0" max="100" required bind:value={policy.priorities.wifi} class="w-20 rounded border p-2" /></label>
	<p class="text-xs">{m['network.sharing.policy.down']()}</p>
	{#each [...new Set([...interfaces, ...policy.administrativelyDown])] as iface (iface)}
	<label class="flex items-center gap-2"><input type="checkbox" value={iface} bind:group={policy.administrativelyDown} />{iface}</label>
	{/each}
	<button type="button" onclick={load} class="min-h-11 rounded border px-3">{m['network.sharing.policy.load']()}</button>
	<button type="submit" class="min-h-11 rounded border px-3">{m['network.sharing.policy.apply']()}</button>
	</fieldset>
	</form>
	{:else}
	<button type="button" onclick={load} disabled={busy} class="min-h-11 rounded border px-3">{m['network.sharing.policy.load']()}</button>
	{/if}
</details>
