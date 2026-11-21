<!--
  WifiNetworkList.svelte — scan bar + scrollable network list + empty state for
  the WifiSelectorDialog.

  Pure presentation extraction of the former monolith's body: the busy-count scan
  bar, the sorted network rows (signal / identity / status), and the no-results
  empty state. All state and the RPC connect/scan/forget logic stay in the parent
  dialog and are driven here via props + callbacks. The inline secured-network
  password form is delegated to WifiConnectForm.

  Each row is one button: a tap joins (or opens the password prompt). A saved
  network's Disconnect, Change password and Forget live in its details panel,
  opened from the row's Manage control (or from the connected row itself), so
  Forget is never next to Connect.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { requiresSaeKeyMgmt } from '@ceraui/rpc';
import type { AvailableWifiNetwork, WifiInterface } from '@ceraui/rpc/schemas';
import {
	Check,
	ChevronDown,
	Clock,
	KeyRound,
	Loader2,
	Lock,
	RefreshCw,
	Trash2,
	TriangleAlert,
	Unlock,
	WifiOff,
} from '@lucide/svelte';

import InlineSpinner from '$lib/components/custom/InlineSpinner.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import { Button } from '$lib/components/ui/button';
import { getWifiUUID } from '$lib/helpers/NetworkHelper';
import {
	frequencyBand,
	isSecured,
	signalTextClass,
	wifiRowBlock,
} from '$lib/helpers/wifi-selector';
import { getOperationPhase, isOperationPending } from '$lib/rpc/async-operation.svelte';
import {
	isPendingConnectRow,
	type PendingWifiConnect,
} from '$lib/rpc/wifi-connect-identity';
import { cn } from '$lib/utils';

import WifiConnectForm from './WifiConnectForm.svelte';
import {
	deriveWifiScanState,
	wifiScanFreshnessKey,
	wifiScanResultsSuperseded,
} from './wifi-scan-state';

interface Props {
	/** Live interface this list operates on (provides available count + saved map). */
	iface: WifiInterface | undefined;
	/** Pre-sorted networks to render (active → saved → signal). */
	networks: AvailableWifiNetwork[];
	/** Interface-level connect-in-flight guard. */
	ifaceBusy: boolean;
	/** Manual-scan spinner flag. */
	scanning: boolean;
	/**
	 * ANY scan is pending on this adapter — the operator's tap OR the background
	 * tick. Defaults to {@link scanning}, so a caller that omits it renders
	 * byte-identically to the pre-freshness surface.
	 */
	scanInFlight?: boolean;
	/** True when the last scan (manual or periodic) failed — drives the calm error state. */
	scanError?: boolean;
	/** WifiStatus key (interface device id) — drives the connect op phase reads. */
	deviceId: string;
	/**
	 * The connect currently in flight, identified by profile uuid (saved) or a
	 * minted correlation id (fresh) — never by SSID alone, so two profiles
	 * sharing an SSID cannot claim each other's spinner.
	 */
	connecting: PendingWifiConnect | undefined;
	/** UUID of the saved network whose disconnect is in flight, if any. */
	disconnecting: string | undefined;
	/** UUID of the saved network whose forget is in flight, if any. */
	forgetting: string | undefined;
	/**
	 * The secured network whose inline password form is expanded, if any: a new
	 * one, or a saved one whose password is being corrected.
	 */
	pendingNew: AvailableWifiNetwork | undefined;
	/** SSID currently showing the forget-confirm affordance, if any. */
	confirmForget: string | undefined;
	/** Schema-derived password floor (WIFI_PASSWORD_MIN). */
	passwordMin: number;
	/** Bound password value for the inline connect form. */
	password: string;
	/** Bound reveal toggle for the inline connect form. */
	showPassword: boolean;
	onScan: () => void;
	onConnectSaved: (uuid: string, network: AvailableWifiNetwork) => void;
	onDisconnect: (uuid: string, network: AvailableWifiNetwork) => void;
	onConnectNew: (network: AvailableWifiNetwork) => void;
	onForget: (uuid: string, network: AvailableWifiNetwork) => void;
	onConfirmForget: (ssid: string | undefined) => void;
	onSubmitNew: () => void;
	onResetInteraction: () => void;
}

let {
	iface,
	networks,
	ifaceBusy,
	scanning,
	scanInFlight,
	scanError = false,
	deviceId,
	connecting,
	disconnecting,
	forgetting,
	pendingNew,
	confirmForget,
	passwordMin,
	password = $bindable(),
	showPassword = $bindable(),
	onScan,
	onConnectSaved,
	onDisconnect,
	onConnectNew,
	onForget,
	onConfirmForget,
	onSubmitNew,
	onResetInteraction,
}: Props = $props();

const scanState = $derived(
	deriveWifiScanState({
		scanInFlight: scanInFlight ?? scanning,
		manualScan: scanning,
		scanFailed: scanError,
		resultCount: networks.length,
	}),
);
const freshnessKey = $derived(wifiScanFreshnessKey(scanState));
const superseded = $derived(wifiScanResultsSuperseded(scanState));

// Which saved network's details are open. Local to the list: nothing outside it
// acts on it. The forget confirm (`confirmForget`, owned by the dialog) keeps its
// row's details open so the confirm step never appears without its context.
let detailsFor = $state<string | undefined>(undefined);

function toggleDetails(ssid: string) {
	detailsFor = detailsFor === ssid ? undefined : ssid;
	if (confirmForget) onConfirmForget(undefined);
}
</script>

<div class="flex flex-col gap-4">
	<!-- Scan bar. The count DIMS while the list it counts is superseded — the same
	     opacity treatment every other aged reading in the app uses, never a second
	     mechanism — and the state says which supersession it is in its own words. -->
	<div
		class="bg-muted/50 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
	>
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<span
				class={cn(
					'text-foreground font-semibold tabular-nums transition-opacity',
					superseded && 'opacity-50',
				)}
			>
				{iface?.available?.length ?? 0}
			</span>
			<span class={cn('text-muted-foreground transition-opacity', superseded && 'opacity-50')}>
				{m["wifiSelector.networks.found"]()}
			</span>
			{#if scanning}
				<InlineSpinner data-testid="wifi-scan-status" label={m["wifiSelector.button.scanning"]()} />
			{:else if ifaceBusy}
				<InlineSpinner label={m["wifiSelector.dialog.connecting"]()} />
			{/if}
			{#if freshnessKey}
				<span
					class={cn(
						'inline-flex items-center gap-1 text-xs',
						scanState === 'stale' ? 'text-status-warning' : 'text-muted-foreground',
					)}
					data-state={scanState}
					data-testid="wifi-scan-freshness"
					role="status"
				>
					{#if scanState === 'stale'}
						<Clock aria-hidden="true" class="size-3 shrink-0" />
					{:else}
						<RefreshCw aria-hidden="true" class="size-3 shrink-0" />
					{/if}
					{resolveMessageKey(freshnessKey)}
				</span>
			{/if}
		</div>
		<Button
			class="h-9 gap-2"
			data-testid="wifi-scan-button"
			disabled={scanning}
			onclick={onScan}
			size="sm"
			title={scanning ? m["wifiSelector.scanReason.scanning"]() : undefined}
			variant="outline"
		>
			{#if scanning}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
				<span>{m["wifiSelector.button.scanning"]()}</span>
			{:else}
				<RefreshCw class="size-4" />
				<span>{m["wifiSelector.button.scan"]()}</span>
			{/if}
		</Button>
	</div>

	<!-- Network list. A touch region, so on a phone every button in it takes the
	     44 px target (`DESIGN.md` §6, TT-3: through the token, never hardcoded). -->
	<div class="divide-y rounded-lg border" data-touch-region>
		{#each networks as network, rowIndex (network.ssid)}
			{const uuid = $derived(getWifiUUID(network, iface?.saved ?? {}))}
			{const opPending = $derived(isOperationPending(`wifi:${deviceId}`))}
			{const isConnectRow = $derived(isPendingConnectRow(connecting, { ssid: network.ssid, uuid }))}
			{const isConnecting = $derived(isConnectRow && opPending)}
			{const isConnectTimedOut =
				$derived(isConnectRow && getOperationPhase(`wifi:${deviceId}`) === 'timed_out')}
			{const isDisconnecting = $derived(!!uuid && disconnecting === uuid)}
			{const isForgetting = $derived(!!uuid && forgetting === uuid)}
			{const osBusy = $derived(!!connecting || !!disconnecting || !!forgetting)}
			{const expanded = $derived(pendingNew?.ssid === network.ssid)}
			{const confirming = $derived(confirmForget === network.ssid)}
			<!-- The device rewrites a saved profile's secret in place only off the SAE-only
			     path; an SAE-only join always adds a second profile. -->
			{const correctable = $derived(isSecured(network) && !requiresSaeKeyMgmt(network.security))}
			<!-- CT-2, not CT-1: the network is genuinely in the air, so the row stays
			     visible and disabled-with-reason rather than being hidden. -->
			{const block = $derived(wifiRowBlock(network, iface?.capabilities))}
			{const blockReason = $derived(block ? resolveMessageKey(block.bodyKey) : undefined)}
			{const rowBusy = $derived(isConnecting || isConnectTimedOut || isDisconnecting || isForgetting)}
			<!-- Only a network this radio is on through one of its own saved profiles has
			     details to open. The scan's active flag alone is not enough: the backend
			     shares one scan, active flags included, across radios while each radio
			     keeps its own saved map, so a network another radio is on arrives here
			     active with no profile. That row keeps the join. -->
			{const manageable = $derived(network.active && !!uuid)}
			{const rowDisabled = $derived(
				manageable ? rowBusy : ifaceBusy || osBusy || !!block,
			)}
			{const detailsShown = $derived(!!uuid && !rowBusy && (detailsFor === network.ssid || confirming))}
			<div
				class={cn(
					'flex flex-col gap-3 px-3 py-3 transition-colors',
					network.active && 'bg-primary/5',
				)}
			>
				<div class="flex items-center gap-2">
					<!-- The row IS the primary control: a tap joins a saved network, opens
					     the password prompt for a new secured one, joins an open one, or
					     opens the connected network's details. One large target instead of
					     a small plug icon beside a trash icon. -->
					<button
						aria-describedby={`wifi-row-meta-${rowIndex}`}
						aria-expanded={manageable ? detailsShown : undefined}
						aria-label={manageable
							? `${m["wifiSelector.button.manage"]()} ${network.ssid}`
							: `${m["wifiSelector.button.connect"]()} ${network.ssid}`}
						class="focus-visible:ring-ring/50 -my-1 -ms-1 flex min-h-(--touch-target-min) min-w-0 flex-1 items-center gap-3 rounded-md py-1 ps-1 text-start outline-none focus-visible:ring-3 disabled:cursor-not-allowed"
						data-testid="wifi-network-row"
						disabled={rowDisabled}
						onclick={() => {
							if (manageable) {
								toggleDetails(network.ssid);
							} else if (expanded) {
								onResetInteraction();
							} else if (uuid) {
								onConnectSaved(uuid, network);
							} else {
								onConnectNew(network);
							}
						}}
						title={blockReason}
						type="button"
					>
						<!-- Signal -->
						<span class="relative shrink-0">
							<LinkIndicator shape="icon" size="lg" type="wifi" signal={network.signal} />
							{#if network.active}
								<span
									class="bg-primary ring-background absolute -end-1.5 -top-1.5 grid size-3.5 place-items-center rounded-full ring-2"
								>
									<Check class="text-primary-foreground size-2.5" />
								</span>
							{/if}
						</span>

						<!-- Identity. The name has the full width to itself and wraps to two
						     lines rather than being cut to one (an SSID is at most 32 bytes,
						     so two lines always hold it); the lock and the Saved badge sit on
						     the line below with the signal. -->
						<span class="min-w-0 flex-1">
							<span
								class={cn(
									'line-clamp-2 text-sm font-medium break-words',
									network.active && 'text-primary',
								)}
								title={network.ssid}
							>
								{network.ssid}
							</span>
							<span
								class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
								id={`wifi-row-meta-${rowIndex}`}
							>
								{#if isSecured(network)}
									<Lock aria-hidden="true" class="text-muted-foreground size-3.5 shrink-0" />
									<span class="sr-only">{m["wifiSelector.accessibility.secured"]()}</span>
								{:else}
									<Unlock aria-hidden="true" class="text-status-warning size-3.5 shrink-0" />
									<span class="sr-only">{m["wifiSelector.accessibility.openNetwork"]()}</span>
								{/if}
								{#if uuid && !network.active}
									<span
										class="bg-muted text-muted-foreground text-micro rounded px-1.5 py-0.5 font-medium"
									>
										{m["wifiSelector.status.saved"]()}
									</span>
								{/if}
								<span class={cn('font-mono tabular-nums', signalTextClass(network.signal))}>
									{network.signal}%
								</span>
								<span aria-hidden="true">·</span>
								<span>{frequencyBand(network.freq)}</span>
								{#if network.active}
									<span aria-hidden="true">·</span>
									<span class="text-primary font-medium">{m["wifiSelector.status.connected"]()}</span>
								{/if}
							</span>
						</span>

						{#if manageable && !rowBusy}
							<ChevronDown
								aria-hidden="true"
								class={cn(
									'text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none',
									detailsShown && 'rotate-180',
								)}
							/>
						{/if}
					</button>

					<!-- Row status, or the saved network's Manage control -->
					{#if isConnecting}
						<InlineSpinner size="md" label={m["network.os.connecting"]()} />
					{:else if isConnectTimedOut}
						<span
							class="text-muted-foreground hidden items-center text-xs font-medium sm:inline-flex"
						>
							{m["network.os.stillWorking"]()}
						</span>
						<Button
							aria-label={`${m["network.os.retry"]()} ${network.ssid}`}
							class="min-w-(--touch-target-min) shrink-0 gap-1.5"
							onclick={() => (uuid ? onConnectSaved(uuid, network) : onConnectNew(network))}
							size="sm"
							variant="outline"
						>
							<RefreshCw class="size-4" />
							<span class="hidden sm:inline">{m["network.os.retry"]()}</span>
						</Button>
					{:else if isDisconnecting}
						<InlineSpinner size="md" label={m["network.os.disconnecting"]()} />
					{:else if isForgetting}
						<InlineSpinner size="md" label={m["network.os.applying"]()} />
					{:else if uuid && !network.active}
						<Button
							aria-expanded={detailsShown}
							aria-label={`${m["wifiSelector.button.manage"]()} ${network.ssid}`}
							class="text-muted-foreground hover:text-foreground size-9 min-w-(--touch-target-min) shrink-0"
							onclick={() => toggleDetails(network.ssid)}
							size="icon"
							title={m["wifiSelector.button.manage"]()}
							variant="ghost"
						>
							<ChevronDown
								class={cn(
									'size-4 transition-transform motion-reduce:transition-none',
									detailsShown && 'rotate-180',
								)}
							/>
						</Button>
					{/if}
				</div>

				<!-- Why this adapter cannot be offered this network (CT-2 reason) -->
				{#if block}
					<div
						class="border-status-warning/30 bg-status-warning/10 flex items-start gap-2 rounded-md border px-2.5 py-2"
						data-ssid={network.ssid}
						data-testid="wifi-row-blocked"
						role="status"
					>
						<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-3.5 shrink-0" />
						<div class="min-w-0">
							<p class="text-status-warning text-xs font-semibold">
								{resolveMessageKey(block.titleKey)}
							</p>
							<p class="text-muted-foreground mt-0.5 text-xs">
								{resolveMessageKey(block.bodyKey)}
							</p>
						</div>
					</div>
				{/if}

				<!-- A saved network's details: what manages the profile, away from the
				     row's Connect. Forget sits last, set apart, and asks first. -->
				{#if detailsShown && uuid}
					<div
						class="bg-muted/40 flex flex-col gap-3 rounded-md border px-3 py-3"
						data-ssid={network.ssid}
						data-testid="wifi-network-details"
					>
						<p class="text-sm font-medium break-all">{network.ssid}</p>
						{#if network.active || correctable}
							<div class="flex flex-wrap gap-2">
								{#if network.active}
									<Button
										aria-label={`${m["wifiSelector.button.disconnect"]()} ${network.ssid}`}
										class="gap-1.5"
										disabled={osBusy}
										onclick={() => onDisconnect(uuid, network)}
										size="sm"
										variant="outline"
									>
										<WifiOff class="size-4" />
										{m["wifiSelector.button.disconnect"]()}
									</Button>
								{/if}
								{#if correctable && !network.active}
									<Button
										aria-expanded={expanded}
										aria-label={`${m["wifiSelector.button.changePassword"]()} ${network.ssid}`}
										class="gap-1.5"
										disabled={ifaceBusy || osBusy || !!block}
										onclick={() => onConnectNew(network)}
										size="sm"
										title={blockReason}
										variant="outline"
									>
										<KeyRound class="size-4" />
										{m["wifiSelector.button.changePassword"]()}
									</Button>
								{/if}
							</div>
						{/if}
						<div class="flex flex-wrap items-center gap-2 border-t pt-3">
							{#if confirming}
								<Button
									onclick={() => {
										detailsFor = undefined;
										onForget(uuid, network);
									}}
									size="sm"
									variant="destructive"
								>
									<Trash2 class="size-4" />
									{m["wifiSelector.button.forget"]()}
								</Button>
								<Button onclick={() => onConfirmForget(undefined)} size="sm" variant="ghost">
									{m["wifiSelector.dialog.close"]()}
								</Button>
							{:else}
								<Button
									aria-label={`${m["wifiSelector.button.forget"]()} ${network.ssid}`}
									class="text-destructive hover:text-destructive gap-1.5"
									disabled={osBusy}
									onclick={() => onConfirmForget(network.ssid)}
									size="sm"
									variant="ghost"
								>
									<Trash2 class="size-4" />
									{m["wifiSelector.button.forget"]()}
								</Button>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Inline password form for a new secured network, or a saved one's correction -->
				{#if expanded}
					<WifiConnectForm
						{passwordMin}
						{ifaceBusy}
						onCancel={onResetInteraction}
						onSubmit={onSubmitNew}
						bind:password
						bind:showPassword
					/>
				{/if}
			</div>
		{:else}
			{#if scanState === 'scanning'}
				<!-- Scanning state — distinct from the settled empty state below. -->
				<div
					class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
					data-testid="wifi-scanning-state"
				>
					<div class="bg-muted grid size-14 place-items-center rounded-2xl">
						<Loader2 class="text-muted-foreground size-7 animate-spin motion-reduce:animate-none" />
					</div>
					<div>
						<p class="text-sm font-semibold">{m["wifiSelector.scanningState.title"]()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{m["wifiSelector.scanningState.description"]()}
						</p>
					</div>
				</div>
			{:else if scanState === 'error'}
				<!-- Scan-error state — a failing scan (manual or periodic), distinct
				     from the scanning + settled-empty states above. -->
				<div
					class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
					data-testid="wifi-scan-error"
					role="status"
				>
					<div class="bg-status-warning/10 grid size-14 place-items-center rounded-2xl">
						<TriangleAlert class="text-status-warning size-7" />
					</div>
					<div>
						<p class="text-sm font-semibold">{m["wifiSelector.scanError.title"]()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{m["wifiSelector.scanError.description"]()}
						</p>
					</div>
					<Button class="gap-2" disabled={scanning} onclick={onScan} size="sm" variant="outline">
						<RefreshCw class="size-4" />
						{m["wifiSelector.button.scan"]()}
					</Button>
				</div>
			{:else}
				<!-- Empty state -->
				<div
					class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
					data-testid="wifi-empty-state"
				>
					<div class="bg-muted grid size-14 place-items-center rounded-2xl">
						<WifiOff class="text-muted-foreground size-7" />
					</div>
					<div>
						<p class="text-sm font-semibold">{m["wifiSelector.emptyState.title"]()}</p>
						<p class="text-muted-foreground mt-1 max-w-xs text-xs">
							{m["wifiSelector.emptyState.description"]()}
						</p>
					</div>
					<Button class="gap-2" disabled={scanning} onclick={onScan} size="sm">
						{#if scanning}
							<Loader2 class="size-4 animate-spin" />
						{:else}
							<RefreshCw class="size-4" />
						{/if}
						{m["wifiSelector.button.scan"]()}
					</Button>
				</div>
			{/if}
		{/each}
	</div>
</div>
