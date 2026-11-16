<script lang="ts">
	import { m } from '@ceraui/i18n/svelte';
	import type { MoblinkStatus, PhoneBoxSettings, PhoneWay } from '@ceraui/rpc/schemas';
	import { onMount } from 'svelte';
	import { LazyDialog, lazyDialog } from '$lib/components/dialogs';
	import { navElements } from '$lib/config';
	import { getOperationPhase } from '$lib/rpc/async-operation.svelte';
	import { rpc } from '$lib/rpc/client';
	import { hotspotIsActive } from '$lib/rpc/os-toggle-predicates';
	import {
		getConfig,
		getIsConnected,
		getStatus,
		getUplinks,
		getWifi,
	} from '$lib/rpc/subscriptions.svelte';
	import { getWifiAdapterModeEntry } from '$lib/rpc/wifi-adapter-modes.svelte';
	import { getHudState } from '$lib/stores/hud.svelte';
	import { getLayoutMode } from '$lib/stores/layout-mode.svelte';
	import { navigateTo } from '$lib/stores/navigation.svelte';
	import {
		canRenewHotspotPassword,
		mayCarryStream,
		newHotspotPasswordKey,
		renewHotspotPassword,
	} from './network/hotspot-new-password';

	const ServerDialog = lazyDialog(() => import('./dialogs/ServerDialog.svelte'));
	let serverOpen = $state(false);
	const PowerDialog = lazyDialog(() => import('./dialogs/PowerDialog.svelte'));
	let powerOpen = $state(false);

	import PhoneHome from './PhoneHome.svelte';

	let settings = $state<PhoneBoxSettings>();
	let moblink = $state<MoblinkStatus>();
	async function refreshMoblink() {
		moblink = await rpc.moblink.getStatus();
	}
	async function credential(password: string) {
		const result = await rpc.moblink.setCredential({ password });
		await refreshMoblink();
		return result;
	}
	async function clearCredential() {
		const result = await rpc.moblink.clearCredential();
		await refreshMoblink();
		return result;
	}
	let error = $state('');
	onMount(() => {
		void refreshMoblink().catch(() => {
			moblink = undefined;
		});
		void rpc.system
			.getPhoneBox()
			.then((value) => (settings = value))
			.catch(() => (error = m['live.phone.loadFailed']()));
	});
	const hud = $derived(getHudState());
	const hotspotEntry = $derived(Object.entries(getWifi() ?? {}).find(([, iface]) => iface.hotspot));
	const hotspot = $derived(hotspotEntry?.[1].hotspot);
	// One hotspot for the card: its credentials, its joins and its renewal.
	const wifiOwner = $derived(
		hotspotEntry ? { device: hotspotEntry[0], incarnation: hotspotEntry[1].incarnation } : undefined,
	);
	const wifiRenew = $derived.by(() => {
		if (!hotspotEntry) return undefined;
		const [device, iface] = hotspotEntry;
		if (!hotspotIsActive(iface, getWifiAdapterModeEntry(device))) return undefined;
		if (!canRenewHotspotPassword(device, iface)) return undefined;
		return {
			phase: getOperationPhase(newHotspotPasswordKey(device, iface)),
			streaming: mayCarryStream(getStatus()),
			onrenew: () => void renewHotspotPassword(device, iface),
		};
	});
	async function save(way: PhoneWay) {
		await rpc.system.setPhoneWay(way);
		settings = { way, srt: settings?.srt ?? null };
	}
	function go(key: string) {
		const nav = navElements[key];
		if (nav) navigateTo({ [key]: nav });
	}
let now = $state(Date.now());
 onMount(() => {
  const clock = setInterval(() => { now = Date.now(); }, 1000);
  return () => clearInterval(clock);
 });
</script>

<PhoneHome
	reachable={getIsConnected()}
	receiver={getConfig()?.srtla_addr && getConfig()?.srtla_port
		? `srtla://${getConfig()?.srtla_addr}:${getConfig()?.srtla_port}`
		: undefined}
	wifi={hotspot
		? {
				name: hotspot.name,
				password: hotspot.password,
				security: hotspot.security,
				clients: hotspot.clients?.count,
			}
		: undefined}
	{wifiRenew}
	{wifiOwner}
	carrying={getIsConnected() ? getStatus()?.carrying?.state : undefined}
	{settings}
	{moblink}
	oncredential={credential}
	onclearcredential={clearCredential}
	health={getStatus()?.box_health}
	temperature={hud.temperature}
	kiosk={getLayoutMode() === 'touch'}
	links={(getUplinks() ?? []).map((link) => ({
		id: link.iface,
		label: link.displayName ?? link.iface,
		internet:
			link.staleAt < now
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
