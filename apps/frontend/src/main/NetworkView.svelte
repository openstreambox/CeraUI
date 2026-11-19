<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { Modem, NetifEntry, NetifMessage, WifiInterface, WifiStatus } from '@ceraui/rpc/schemas';
import { Network as NetworkIcon, Usb } from '@lucide/svelte';
import { LazyDialog, lazyDialog } from '$lib/components/dialogs';
import { Skeleton } from '$lib/components/ui/skeleton';
import { hotspotIsActive } from '$lib/rpc/os-toggle-predicates';
import {
	getBluetooth,
	getCapabilities,
	getConfig,
	getIsConnected,
	getIsStreaming,
	getLinkTelemetry,
	getModems,
	getNetif,
	getSharingDiag,
	getStatus,
	getUplinkShaper,
	getUplinkSteering,
	getUplinks,
	getWifi,
} from '$lib/rpc/subscriptions.svelte';
import { getHudState } from '$lib/stores/hud.svelte';
import { getLinkNames } from '$lib/stores/link-names.svelte';
import type { LinkSignal } from '$lib/types/hud';

import BluetoothSection from './network/BluetoothSection.svelte';
import BondedLinksSection from './network/BondedLinksSection.svelte';
import CaptivePortal from './network/CaptivePortal.svelte';
import CellularSection from './network/CellularSection.svelte';
import CollisionBands from './network/CollisionBands.svelte';
import { activeSimLock, isBlockingSimLock } from './network/cellular-row';
import DeviceCalmLine from './network/DeviceCalmLine.svelte';
import DevicesPage from './network/DevicesPage.svelte';
import { consumeDevicesOpen } from './network/devices-open.svelte';
import EthernetSection from './network/EthernetSection.svelte';
import HotspotSection from './network/HotspotSection.svelte';
import {
	chooseHotspotRadio,
	expireHotspotChoice,
	type HotspotRadioChoice,
	pickHotspotRadio,
} from './network/hotspot-radio-target';
import RemoteNetworkStatus from './network/RemoteNetworkStatus.svelte';
import SharingSection from './network/SharingSection.svelte';
import { isWiredSectionEntry, modemClaimedIfnames } from './network/section-assignment';
import UnclaimedAdaptersBand from './network/UnclaimedAdaptersBand.svelte';
import WifiSection from './network/WifiSection.svelte';

// None of these is on the path to first paint — each is its own chunk, fetched
// on first open.
const NetifDialog = lazyDialog(() => import('./dialogs/NetifDialog.svelte'));
const WifiSelectorDialog = lazyDialog(() => import('./dialogs/WifiSelectorDialog.svelte'));
const HotspotDialog = lazyDialog(() => import('./dialogs/HotspotDialog.svelte'));
const ModemConfigDialog = lazyDialog(() => import('./dialogs/ModemConfigDialog.svelte'));
const SimUnlockDialog = lazyDialog(() => import('./dialogs/SimUnlockDialog.svelte'));
const RouterDongleDialog = lazyDialog(() => import('./dialogs/RouterDongleDialog.svelte'));
// Reached from a Wi-Fi radio whose 6 GHz band its regulatory domain forbids —
// the same dialog Settings mounts, opened where the operator met the block.
const WifiCountryDialog = lazyDialog(() => import('./dialogs/WifiCountryDialog.svelte'));

// Getters — always from the non-deprecated subscriptions surface.
const wifi = $derived<WifiStatus | undefined>(getWifi());
const modems = $derived(getModems());
const netif = $derived<NetifMessage | undefined>(getNetif());
const isConnected = $derived(getIsConnected());
const linkTelemetry = $derived(getLinkTelemetry());
const bluetooth = $derived(getBluetooth());
const audioBackend = $derived(getConfig()?.audio_backend ?? getCapabilities()?.audio_backends?.active);

// Bonded links come from the HUD store so colour identity (--link-N) is
// IDENTICAL to the persistent HUD bar — link.linkIndex (0-based) → --link-{n+1}.
// The full snapshot also carries `isFullyStale`, threaded into every live-value
// section so per-source staleness (Task 18) is decided in one place.
const hud = $derived(getHudState());
const links = $derived<LinkSignal[]>(hud.links);
const isFullyStale = $derived(hud.isFullyStale);
// Per-interface staleness (Task 22): decided once in the HUD store so the
// section marker matches the bonded-link and HUD-bar verdict exactly.
const staleInterfaces = $derived(hud.staleInterfaces);

// Loading: no telemetry has arrived yet on this connection.
const isLoading = $derived(
	!isConnected && wifi === undefined && modems === undefined && netif === undefined,
);

// WiFi interfaces split so hotspot + station can be shown SIMULTANEOUSLY
// (never one-or-the-other). Only a LIVE AP counts here: a radio that is off still
// carries its saved `hotspot` setup, which is not a hotspot that is on.
const wifiEntries = $derived(Object.entries(wifi ?? {}) as [string, WifiInterface][]);
const hotspotInterfaces = $derived(wifiEntries.filter(([id, iface]) => hotspotIsActive(iface)));

// The hotspot radio pick is `[id, incarnation]` and expires with that radio
// lifetime (backend restart, replug, degraded row). Several capable radios need
// an explicit pick; an expired one never falls through to another radio.
let hotspotRadioChoice = $state.raw<HotspotRadioChoice>({});
$effect(() => {
	const next = expireHotspotChoice(wifiEntries, hotspotRadioChoice);
	if (next !== hotspotRadioChoice) hotspotRadioChoice = next;
});
const hotspotTarget = $derived(chooseHotspotRadio(wifiEntries, hotspotRadioChoice));

// The dialog is bound to the `[id, incarnation]` it was opened for: a later or
// expired pick never retargets it, and it is handed that row only while the
// row still carries the same incarnation. Otherwise it gets no row, and the
// dialog closes itself with a notice instead of following the replacement.
let hotspotDialogTarget = $state.raw<readonly [string, string]>();
const hotspotDialogIface = $derived.by(() => {
	if (!hotspotDialogTarget) return undefined;
	const [id, incarnation] = hotspotDialogTarget;
	const row = wifi?.[id];
	return row?.incarnation === incarnation ? row : undefined;
});
let hotspotDialogOpen = $state(false);

function openHotspotDialog() {
	const incarnation = hotspotTarget?.[1].incarnation;
	if (!hotspotTarget || !incarnation) return;
	// Opening confirms the target, so a preselected single radio expires the
	// same way an explicit pick does.
	hotspotRadioChoice = { selected: [hotspotTarget[0], incarnation] };
	hotspotDialogTarget = [hotspotTarget[0], incarnation];
	hotspotDialogOpen = true;
}
let wifiCountryOpen = $state(false);
let devicesOpen = $state(false);

$effect(() => {
	if (consumeDevicesOpen()) devicesOpen = true;
});

const modemEntries = $derived(Object.entries(modems ?? {}) as [string, Modem][]);

// Strictly `=== true`: absent is an older backend that never published the flag,
// and reading that as "initializing" would band every such device forever.
const cellularInitializing = $derived(getStatus()?.cellular_initializing === true);

// Wired / other interfaces: anything in netif that is not a modem (ww*),
// not a wifi radio (wl*), and not loopback.
//
// A cellular device's interface leaves this list for the Cellular section once
// a modem row claims it — a router-mode dongle or an MM-managed modem's own
// RNDIS data function alike. The rule lives in `section-assignment.ts` so it can
// be tested without mounting this view.
const claimedByModem = $derived(modemClaimedIfnames(modemEntries));
const wiredEntries = $derived(
	Object.entries(netif ?? {}).filter(([name, iface]) =>
		isWiredSectionEntry(name, iface, claimedByModem),
	) as [string, NetifEntry][],
);

// Per-interface Ethernet configuration dialog (Task 24). The selected interface
// data is read LIVE from `netif` so the dialog reflects ongoing telemetry.
let netifDialogOpen = $state(false);
let selectedNetifName = $state('');
const selectedNetif = $derived(
	selectedNetifName ? (netif?.[selectedNetifName] ?? undefined) : undefined,
);

function configureNetif(name: string) {
	selectedNetifName = name;
	netifDialogOpen = true;
}

// WiFi network selector dialog — scoped to the radio whose Connect was tapped.
let wifiSelectorOpen = $state(false);
let wifiSelectorDeviceId = $state('');

function openWifiSelector(deviceId: string) {
	wifiSelectorDeviceId = deviceId;
	wifiSelectorOpen = true;
}

// Per-modem configuration dialog — one instance, keyed by the selected modem id.
let modemDialogOpen = $state(false);
let configModemId = $state<string | null>(null);
const configModem = $derived(modemEntries.find(([id]) => id === configModemId)?.[1]);

// Router-dongle settings — one instance, keyed like the others.
let dongleDialogOpen = $state(false);
let dongleModemId = $state<string | null>(null);
const dongleModem = $derived(modemEntries.find(([id]) => id === dongleModemId)?.[1]);

// SIM unlock — one instance, keyed the same way. It is reached ONLY by an
// operator action on the modem it belongs to; there is deliberately no
// auto-open effect here anymore. See `openModemConfig` below.
let simUnlockOpen = $state(false);
let unlockModemId = $state<string | null>(null);
const unlockModem = $derived(modemEntries.find(([id]) => id === unlockModemId)?.[1]);

function openSimUnlock(id: string) {
	unlockModemId = id;
	simUnlockOpen = true;
}

/**
 * The row's primary action. It routes on the SAME lock the button was labelled
 * from (`resolveRowAction`), so what the operator reads and where they land
 * cannot disagree.
 *
 * This REPLACED a global `$effect` that popped the unlock dialog over the whole
 * Network destination as soon as any modem reported a lock. Three things were
 * wrong with it, and the third is why it is gone rather than merely debounced:
 *
 *  1. It hijacked a shared page for a device-scoped problem — an operator
 *     opening Network mid-broadcast to check bonding got a modal PIN prompt.
 *  2. It was `find()`-based, so with two locked modems the second was
 *     unreachable no matter what the operator did.
 *  3. A PIN2 unlock CANNOT be made to stick. `Sim.SendPin` verifies for the
 *     current UICC power session only, ModemManager keeps no PIN cache, and the
 *     one persistent mechanism (`EnablePin(pin,false)`) has no PIN2 equivalent
 *     at all. So the lock returns on every single boot, forever, for something
 *     that blocks no traffic — an auto-prompt the operator could never silence.
 *
 * That third point is now settled the other way round: PIN2/PUK2 is not
 * surfaced anywhere in this UI at all, because it gates only the SIM's
 * Fixed-Dialling-Number list and this product has no calls or contacts surface
 * to reach it from. The row's own "SIM locked" badge remains the discovery
 * surface, and it now only ever names a lock that really did stop the radio.
 */
function openModemConfig(id: string) {
	const modem = modemEntries.find(([entryId]) => entryId === id)?.[1];
	if (modem && isBlockingSimLock(activeSimLock(modem))) {
		openSimUnlock(id);
		return;
	}
	// A router dongle's settings live in its OWN admin API, not in ModemManager,
	// so it gets its own dialog rather than a ModemConfigDialog full of controls
	// that could never reach it. Routing on `device_class` keeps the choice on
	// the same fact the row was rendered from.
	if (modem?.device_class === 'router-ethernet') {
		dongleModemId = id;
		dongleDialogOpen = true;
		return;
	}
	configModemId = id;
	modemDialogOpen = true;
}
</script>

{#if getStatus()?.remote_status === true}
<RemoteNetworkStatus {wifi} {modems} {netif} />
{:else}
<!--
	`space-y-3`, not `space-y-5`. Every child below is a FRAMED card that already
	carries its own border and 16px of internal padding, so 20px between them
	stacked a third boundary on top of two and read as seven unrelated pages
	rather than one instrument panel. Proximity is the grouping here, and the
	frames are what separate the cards.
-->
<div class="mx-auto w-full max-w-5xl space-y-3 p-4 sm:px-6 sm:py-5">
	{#if devicesOpen}
		<DevicesPage
			wire={getStatus()?.usb_devices}
			events={getStatus()?.usb_events}
			onBack={() => (devicesOpen = false)}
		/>
	{:else}
	<!-- Destination header -->
	<header class="flex items-center gap-2.5">
		<NetworkIcon aria-hidden="true" class="text-primary size-5 shrink-0" />
		<h1 class="text-xl font-semibold tracking-tight">{m["navigation.network"]()}</h1>
	</header>

	{#if isLoading}
		<!-- Loading state -->
		<section class="space-y-3" aria-busy="true" aria-label={m["network.view.loading"]()}>
			<Skeleton class="h-24 w-full rounded-xl" />
			<Skeleton class="h-32 w-full rounded-xl" />
			<Skeleton class="h-32 w-full rounded-xl" />
		</section>
	{:else}
		<BondedLinksSection
			{links}
			{modemEntries}
			{linkTelemetry}
			streaming={getIsStreaming()}
			unbondedCount={hud.unbondedLinkCount}
		/>
		<CollisionBands {netif} bondMapping={getStatus()?.bond_mapping ?? null} />
		<UnclaimedAdaptersBand adapters={getStatus()?.unclaimed_adapters} />
		<SharingSection
			uplinks={getUplinks()}
			diag={getSharingDiag()}
			steering={getUplinkSteering()}
			shaper={getUplinkShaper()}
			{netif}
			{hotspotInterfaces}
		/>
		{#if getConfig()?.captive_portal_enabled === true}<CaptivePortal />{/if}
		<WifiSection
			wifiRadios={wifiEntries}
			linkName={getLinkNames().label}
			{netif}
			{isFullyStale}
			{staleInterfaces}
			onConnect={openWifiSelector}
			onOpenCountry={() => (wifiCountryOpen = true)}
		/>
		<CellularSection
			{modemEntries}
			linkCorrelation={getLinkNames().correlation}
			{netif}
			{isFullyStale}
			{staleInterfaces}
			{cellularInitializing}
			onConfigure={openModemConfig}
		/>
		<EthernetSection
			{wiredEntries}
			linkName={getLinkNames().label}
			{isFullyStale}
			{staleInterfaces}
			onConfigure={configureNetif}
		/>
		<HotspotSection
			{hotspotInterfaces}
			{hotspotTarget}
			radios={wifiEntries}
			selectionLost={hotspotRadioChoice.lost === true}
			onSelect={(id) => { hotspotRadioChoice = pickHotspotRadio(wifiEntries, id); }}
			onSetup={openHotspotDialog}
		/>
		<BluetoothSection status={bluetooth} {audioBackend} />
		<DeviceCalmLine
			calm={getStatus()?.device_calm}
			onOpen={() => (devicesOpen = true)}
		/>
		<button
			type="button"
			data-testid="open-devices"
			class="bg-card hover:bg-accent focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-xl border p-4 text-left focus-visible:ring-2 focus-visible:outline-none"
			onclick={() => (devicesOpen = true)}
		>
			<Usb aria-hidden="true" class="text-primary size-5 shrink-0" />
			<span class="min-w-0">
				<span class="block text-sm font-semibold">{m["network.devices.open"]()}</span>
				<span class="text-muted-foreground block text-sm">{m["network.devices.lede"]()}</span>
			</span>
		</button>
	{/if}
	{/if}
</div>

<!-- Per-interface Ethernet configuration (Task 24) -->
<LazyDialog
	dialog={NetifDialog}
	bind:open={netifDialogOpen}
	name={selectedNetifName}
	iface={selectedNetif}
/>

<!-- WiFi network selector — scoped to the radio whose Connect was tapped -->
{#if wifiSelectorDeviceId}
	<LazyDialog
		dialog={WifiSelectorDialog}
		bind:open={wifiSelectorOpen}
		deviceId={wifiSelectorDeviceId}
		linkName={getLinkNames().label}
	/>
{/if}

{#if hotspotDialogTarget}
	<LazyDialog
		dialog={HotspotDialog}
		bind:open={hotspotDialogOpen}
		deviceId={hotspotDialogTarget[0]}
		iface={hotspotDialogIface}
	/>
{/if}

<LazyDialog dialog={WifiCountryDialog} bind:open={wifiCountryOpen} />

{#if configModem && configModemId}
	<LazyDialog
		dialog={ModemConfigDialog}
		bind:open={modemDialogOpen}
		deviceId={configModemId}
		modem={configModem}
	/>
{/if}

{#if dongleModem && dongleModemId}
	<!-- `hasAddress` is a TRISTATE and the `undefined` arm is meaningful: a
	     `netif` snapshot that has not arrived yet is "we were not told", and the
	     dialog then makes no bond claim at all rather than claiming the link has
	     no address. -->
	<LazyDialog
		dialog={RouterDongleDialog}
		bind:open={dongleDialogOpen}
		deviceId={dongleModemId}
		hasAddress={netif === undefined ? undefined : Boolean(netif[dongleModem.ifname]?.ip)}
		modem={dongleModem}
	/>
{/if}

<!-- SIM unlock — reached ONLY from the locked modem's own row, whose button a
     blocking lock renames to "Unlock SIM". Never auto-opened, and there is no
     second route into it. -->
{#if unlockModem && unlockModemId}
	<LazyDialog
		dialog={SimUnlockDialog}
		bind:open={simUnlockOpen}
		deviceId={unlockModemId}
		modem={unlockModem}
	/>
{/if}

{/if}
