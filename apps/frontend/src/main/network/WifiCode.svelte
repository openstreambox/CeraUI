<!--
  WifiCode.svelte — the box's Wi-Fi code, hidden until someone asks for it.

  Shared by the Connect your phone panel and the hotspot dialog, so both follow
  one rule: no secret is on screen by itself.

  • The QR sits behind **Show code** (`aria-expanded`, `aria-controls`). Its
    frame keeps the same size while hidden, so nothing moves when it opens, and
    **Hide** takes Show's place.
  • While shown: "Keep this off camera." It hides itself after two minutes, when
    the page loses focus, when the password changes, and when a new device
    joins. A screen that should never carry a QR (`qr` false: a phone, the
    kiosk) gets no code at all, only the lines below.
  • A join shows here as "A new device joined · just now · Not mine?" (the app's
    toast stays quiet while a card for that hotspot is mounted). The card is
    bound to one hotspot (`owner`: device key and radio incarnation) and only
    shows that hotspot's joins, so with two hotspots up a join on one never
    offers to renew the other's password. Not mine opens the same
    confirmation as New Wi-Fi password: today's hotspot has one password, so
    dropping one device means a new password for all of them.
  • **New Wi-Fi password** asks first and names the cost: every joined device
    drops and joins again; with a stream that may be going through the box, the
    D13a line says that stream drops too. Never a dead end, never silent.
-->
<script module lang="ts">
/** How long a shown code stays on screen. */
export const WIFI_CODE_SHOW_MS = 120_000;
/** How long the join line stays after a join. */
export const WIFI_JOIN_LINE_MS = 10 * 60_000;
</script>

<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { HotspotSecurityId } from '@ceraui/rpc/schemas';
import { Loader2, QrCode } from '@lucide/svelte';
import { onMount } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { generateWifiQr, hotspotQrSecurity } from '$lib/helpers/NetworkHelper';
import type { AsyncOpPhase } from '$lib/rpc/async-operation.svelte';
import {
	getLastHotspotJoin,
	type HotspotOwner,
	registerWifiCodeCard,
} from '$lib/stores/hotspot-joins.svelte';

interface Props {
	name?: string | undefined;
	password?: string | undefined;
	security?: HotspotSecurityId | undefined;
	/** Whether this screen may show a QR at all. */
	qr?: boolean;
	/**
	 * The hotspot this card shows (device key and radio incarnation). Joins
	 * show here only for it; without one the card shows no join line.
	 */
	owner?: HotspotOwner | undefined;
	/** Present only while a renewal of `owner`'s password is possible. */
	renew?:
		| {
				phase: AsyncOpPhase;
				/** A stream may be going through the box right now. */
				streaming: boolean;
				onrenew: () => void;
		  }
		| undefined;
	now?: () => number;
}

let { name, password, security, qr = true, owner, renew, now = Date.now }: Props = $props();

const uid = $props.id();
const frameId = `wifi-code-frame-${uid}`;

let shown = $state(false);
let qrUrl = $state('');
let confirming = $state(false);
let requested = $state(false);
let renewed = $state(false);
let clock = $state(Date.now());
$effect.pre(() => {
	clock = now();
});

const canShow = $derived(qr && Boolean(name) && Boolean(password));
const ownerDevice = $derived(owner?.device);
const ownerIncarnation = $derived(owner?.incarnation);
const join = $derived(
	ownerDevice === undefined
		? null
		: getLastHotspotJoin({ device: ownerDevice, incarnation: ownerIncarnation }),
);
const joinVisible = $derived(join !== null && clock - join.at < WIFI_JOIN_LINE_MS);
const joinWhen = $derived(
	join === null || clock - join.at < 60_000
		? m['network.hotspot.joinedJustNow']()
		: m['network.hotspot.joinedMinutesAgo']({ minutes: Math.floor((clock - join.at) / 60_000) }),
);
const pending = $derived(renew?.phase === 'pending');

let hideTimer: ReturnType<typeof setTimeout> | undefined;
function hide() {
	shown = false;
	if (hideTimer !== undefined) clearTimeout(hideTimer);
	hideTimer = undefined;
}
function show() {
	if (!canShow) return;
	shown = true;
	if (hideTimer !== undefined) clearTimeout(hideTimer);
	hideTimer = setTimeout(hide, WIFI_CODE_SHOW_MS);
}

// The toast stays quiet only for the hotspot this card shows.
$effect(() => {
	if (ownerDevice === undefined) return;
	return registerWifiCodeCard({ device: ownerDevice, incarnation: ownerIncarnation });
});

onMount(() => {
	const onVisibility = () => {
		if (document.visibilityState === 'hidden') hide();
	};
	const tick = setInterval(() => {
		clock = now();
	}, 15_000);
	window.addEventListener('blur', hide);
	document.addEventListener('visibilitychange', onVisibility);
	return () => {
		clearInterval(tick);
		window.removeEventListener('blur', hide);
		document.removeEventListener('visibilitychange', onVisibility);
		hide();
	};
});

// A join or a new password hides a shown code; the old picture is no use.
// `null` marks the first run, which only records the starting value.
let seenJoin: number | null = null;
$effect(() => {
	const seq = join?.seq ?? 0;
	if (seenJoin !== null && seq !== seenJoin) {
		clock = now();
		hide();
	}
	seenJoin = seq;
});
let seenPassword: string | undefined | null = null;
$effect(() => {
	const current = password;
	if (seenPassword !== null && current !== seenPassword) hide();
	seenPassword = current;
});
$effect(() => {
	if (!canShow) hide();
});
// A card rebound to another hotspot drops a question asked about the old one.
let seenOwner: string | null = null;
$effect(() => {
	const key = `${ownerDevice ?? ''}\u0000${ownerIncarnation ?? ''}`;
	if (seenOwner !== null && key !== seenOwner) {
		confirming = false;
		requested = false;
		renewed = false;
		hide();
	}
	seenOwner = key;
});
$effect(() => {
	const phase = renew?.phase;
	if (requested && phase === 'confirmed') {
		renewed = true;
		requested = false;
	}
	if (phase === 'failed' || phase === 'timed_out') requested = false;
	if (renew === undefined) confirming = false;
});

$effect(() => {
	let active = true;
	qrUrl = '';
	if (shown && name && password) {
		generateWifiQr(name, password, hotspotQrSecurity(security))
			.then((url) => {
				if (active) qrUrl = url;
			})
			.catch(() => {
				/* The password stays available as text behind its own Show. */
			});
	}
	return () => {
		active = false;
	};
});

function confirmRenew() {
	if (!renew || pending) return;
	confirming = false;
	requested = true;
	renewed = false;
	hide();
	renew.onrenew();
}
</script>

<div class="space-y-3" data-testid="wifi-code">
	{#if qr}
		<div class="flex flex-col items-center gap-2">
			<div
				id={frameId}
				class="grid size-40 place-items-center rounded-md border {shown && qrUrl
					? 'bg-white p-2'
					: 'bg-muted/40'}"
				data-testid="wifi-code-frame"
				data-shown={shown}
			>
				{#if shown && qrUrl}
					<img class="size-full" alt={m['network.accessibility.wifiQrCode']()} src={qrUrl} />
				{:else}
					<QrCode aria-hidden="true" class="text-muted-foreground/40 size-10" />
				{/if}
			</div>
			<Button
				aria-controls={frameId}
				aria-expanded={shown}
				class="min-h-11 min-w-28"
				disabled={!canShow}
				onclick={() => (shown ? hide() : show())}
				type="button"
				variant="outline"
			>
				{shown ? m['network.hotspot.hideCode']() : m['network.hotspot.showCode']()}
			</Button>
			{#if shown}
				<p class="text-muted-foreground text-center text-xs" data-testid="wifi-code-off-camera">
					{m['network.hotspot.codeOffCamera']()}
				</p>
			{/if}
		</div>
	{/if}

	{#if joinVisible}
		<p class="text-sm" data-testid="wifi-code-joined" role="status">
			{m['network.hotspot.joined']()} · {joinWhen}{#if renew}{' · '}<button
					class="text-primary underline-offset-4 hover:underline focus-visible:underline"
					onclick={() => (confirming = true)}
					type="button">{m['network.hotspot.notMine']()}</button
				>{/if}
		</p>
	{/if}

	{#if renew}
		{#if confirming}
			<fieldset class="space-y-2 rounded-lg border p-3" data-testid="wifi-code-renew-confirm">
				<legend class="px-1 text-sm font-medium">{m['network.hotspot.newPasswordQuestion']()}</legend>
				<p class="text-muted-foreground text-xs">{m['network.hotspot.newPasswordCost']()}</p>
				{#if renew.streaming}
					<p class="text-muted-foreground text-xs">{m['live.phone.powerOffCost']()}</p>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button class="min-h-11" onclick={confirmRenew} type="button">
						{m['network.hotspot.newPasswordConfirm']()}
					</Button>
					<Button class="min-h-11" onclick={() => (confirming = false)} type="button" variant="outline">
						{m['network.hotspot.newPasswordKeep']()}
					</Button>
				</div>
			</fieldset>
		{:else}
			<Button
				class="min-h-11"
				disabled={pending}
				onclick={() => (confirming = true)}
				type="button"
				variant="outline"
			>
				{#if pending}
					<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
					{m['network.hotspot.newPasswordPending']()}
				{:else}
					{m['network.hotspot.newPassword']()}
				{/if}
			</Button>
		{/if}
		{#if renewed}
			<p class="text-muted-foreground text-xs" data-testid="wifi-code-renewed" role="status">
				{m['network.hotspot.newPasswordDone']()}
			</p>
		{/if}
	{/if}
</div>
