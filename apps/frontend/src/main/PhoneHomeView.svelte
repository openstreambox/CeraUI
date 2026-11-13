<script lang="ts">
	import { m } from '@ceraui/i18n/svelte';
	import type { PhoneBoxSettings, PhoneWay } from '@ceraui/rpc/schemas';
	import { onMount } from 'svelte';
	import { LazyDialog, lazyDialog } from '$lib/components/dialogs';
	import { navElements } from '$lib/config';
	import { rpc } from '$lib/rpc/client';
	import {
		getConfig,
		getIsConnected,
		getStatus,
		getUplinks,
		getWifi,
	} from '$lib/rpc/subscriptions.svelte';
	import { getHudState } from '$lib/stores/hud.svelte';
	import { getLayoutMode } from '$lib/stores/layout-mode.svelte';
	import { navigateTo } from '$lib/stores/navigation.svelte';

	const ServerDialog = lazyDialog(() => import('./dialogs/ServerDialog.svelte'));
	let serverOpen = $state(false);
	const PowerDialog = lazyDialog(() => import('./dialogs/PowerDialog.svelte'));
	let powerOpen = $state(false);

	import PhoneHome from './PhoneHome.svelte';

	let settings = $state<PhoneBoxSettings>();
	let error = $state('');
	onMount(() => {
		void rpc.system
			.getPhoneBox()
			.then((value) => (settings = value))
			.catch(() => (error = m['live.phone.loadFailed']()));
	});
	const hud = $derived(getHudState());
	const hotspot = $derived(Object.values(getWifi() ?? {}).find((iface) => iface.hotspot)?.hotspot);
	async function save(way: PhoneWay) {
		await rpc.system.setPhoneWay(way);
		settings = { way, srt: settings?.srt ?? null };
	}
	function go(key: string) {
		const nav = navElements[key];
		if (nav) navigateTo({ [key]: nav });
	}
</script>

<PhoneHome
	reachable={getIsConnected()}
	receiver={getConfig()?.srtla_addr && getConfig()?.srtla_port
		? `srtla://${getConfig()?.srtla_addr}:${getConfig()?.srtla_port}`
		: undefined}
	wifi={hotspot
		? { name: hotspot.name, password: hotspot.password, clients: hotspot.clients?.count }
		: undefined}
	carrying={getIsConnected() ? getStatus()?.carrying?.state : undefined}
	{settings}
	health={getStatus()?.box_health}
	temperature={hud.temperature}
	kiosk={getLayoutMode() === 'touch'}
	links={(getUplinks() ?? []).map((link) => ({
		id: link.iface,
		label: link.displayName ?? link.iface,
		internet:
			link.staleAt < Date.now()
				? 'unknown'
				: link.state === 'up'
					? 'yes'
					: link.state === 'down'
						? 'no'
						: 'unknown',
	}))}
	onsave={save}
	onnetwork={() => go('network')}
	onserver={() => (serverOpen = true)}
	onrestart={() => (powerOpen = true)}
/>
{#if error}<p role="alert">{error}</p>{/if}

<LazyDialog dialog={PowerDialog} bind:open={powerOpen} />

<LazyDialog dialog={ServerDialog} bind:open={serverOpen} />
