<!--
  HotspotOffEditor.svelte — change the hotspot name and password while it is off.

  • Reads and saves through `wifi.hotspotPrepare`, the same call the Start gate
    uses: with no pair it reports what the next start will broadcast, with a
    chosen pair it modifies the existing owned profile or, before the first
    start, stores the choice durably (the reply fails when that write fails).
    Nothing here brings the AP up; Turn on stays a separate, confirmed action.
  • The saved pair is read from that explicit reply, never from the status wire:
    a row carries no `hotspot` block while the AP is off.
  • Channel and security stay live-only. Prepare carries neither, the store has
    no security field, and the channel list comes from the live AP's own report.
  • Bound to one radio lifetime (device + incarnation). A new link or dialog
    session reloads the details; a changed or missing incarnation closes the
    editor. The `current-unobserved` retry resends only when the next status
    frame carries the SAME token; any other token refuses.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { WifiInterface } from '@ceraui/rpc/schemas';
import { Loader2, Pencil, Save } from '@lucide/svelte';
import { onDestroy, tick, untrack } from 'svelte';

import { networkConstraints } from '$lib/components/streaming';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { rpc } from '$lib/rpc/client';
import { getLinkEpoch } from '$lib/rpc/session-epoch.svelte';
import { waitForWifiStatus } from '$lib/rpc/wifi-status-receipt';

import { hotspotPasswordIsPrintable } from './hotspot-password';
import { sameWifiRadio, type WifiRadioBinding, wifiRadioChanged } from './wifi-radio-binding';

interface Props {
	device: string;
	incarnation?: string;
	degradedReason?: WifiInterface['degraded_reason'];
	session?: number;
}

const { device, incarnation, degradedReason, session = 0 }: Props = $props();

const bounds = networkConstraints.hotspot;

type Phase = 'closed' | 'loading' | 'ready' | 'load-failed' | 'saving' | 'unsupported' | 'unverified';
let phase = $state<Phase>('closed');
let saved = $state(false);
let saveFailed = $state(false);
let refused = $state(false);
let reloaded = $state(false);
let loaded = $state.raw({ name: '', password: '' });
let name = $state('');
let password = $state('');
let binding: WifiRadioBinding | undefined;
let attempt = 0;
let awaitingStatus = false;
let observation: AbortController | undefined;
let alive = true;

onDestroy(() => {
	alive = false;
	attempt += 1;
	observation?.abort();
});

function now(): WifiRadioBinding {
	return { device, incarnation, link: getLinkEpoch(), session };
}

function current(seq: number, captured: WifiRadioBinding): boolean {
	return alive && seq === attempt && sameWifiRadio(captured, now()) && degradedReason === undefined;
}

async function prepare(captured: WifiRadioBinding, seq: number, chosen?: { name: string; password: string }) {
	if (!captured.incarnation) return;
	const invoke = (token: string) => rpc.wifi.hotspotPrepare({ device: captured.device, incarnation: token, ...chosen });
	let accepted = captured;
	let result = await invoke(captured.incarnation);
	if (result.error === 'radio-changed' && result.reason === 'current-unobserved' && current(seq, captured)) {
		const controller = new AbortController();
		observation = controller;
		awaitingStatus = true;
		const next = await waitForWifiStatus(captured.device, controller.signal);
		await tick();
		if (observation === controller) {
			observation = undefined;
			awaitingStatus = false;
		}
		if (!alive || seq !== attempt || captured.device !== device || captured.link !== getLinkEpoch()) return;
		// Only the same radio lifetime is retried: a new token is another target,
		// and the first refusal stands.
		if (next?.incarnation !== captured.incarnation) return { result, captured };
		accepted = { ...captured, session };
		binding = accepted;
		result = await invoke(captured.incarnation);
	}
	return { result, captured: accepted };
}

async function load() {
	observation?.abort();
	observation = undefined;
	awaitingStatus = false;
	const captured = now();
	const seq = ++attempt;
	binding = captured;
	saved = false;
	saveFailed = false;
	refused = false;
	name = '';
	password = '';
	if (degradedReason) {
		phase = 'unverified';
		return;
	}
	if (!captured.incarnation) {
		phase = 'unsupported';
		return;
	}
	phase = 'loading';
	try {
		const response = await prepare(captured, seq);
		if (!response || !current(seq, response.captured)) return;
		const { result } = response;
		if (result.error === 'radio-unverified') {
			phase = 'unverified';
			return;
		}
		if (!result.success || !result.name || !result.password) throw new Error('unavailable');
		loaded = { name: result.name, password: result.password };
		name = result.name;
		password = result.password;
		phase = 'ready';
	} catch {
		if (binding && current(seq, binding)) phase = 'load-failed';
	}
}

function open() {
	reloaded = false;
	void load();
}

function close() {
	attempt += 1;
	observation?.abort();
	observation = undefined;
	awaitingStatus = false;
	phase = 'closed';
	reloaded = false;
}

// A new link or dialog session on the same radio lifetime reloads an open
// editor. A changed device or incarnation is another target: the draft is
// dropped and the editor closes rather than loading the replacement.
$effect.pre(() => {
	const next = now();
	degradedReason;
	untrack(() => {
		if (phase === 'closed' || !binding || sameWifiRadio(binding, next)) return;
		if (binding.device !== next.device || binding.incarnation !== next.incarnation) {
			close();
			return;
		}
		if (awaitingStatus) return;
		reloaded = true;
		void load();
	});
});

const nameError = $derived(
	name.length < bounds.name.min
		? m['hotspotConfigurator.validation.nameMinLength']()
		: name.length > bounds.name.max
			? m['hotspotConfigurator.validation.nameMaxLength']()
			: '',
);
const passwordError = $derived(
	password.length < bounds.password.min
		? m['hotspotConfigurator.validation.passwordMinLength']()
		: password.length > bounds.password.max
			? m['hotspotConfigurator.validation.passwordMaxLength']()
			: !hotspotPasswordIsPrintable(password)
				? m['hotspotConfirm.passwordCharacters']()
				: '',
);
const changed = $derived(name !== loaded.name || password !== loaded.password);
const canSave = $derived(phase === 'ready' && changed && !nameError && !passwordError);

function edited() {
	if (phase === 'saving') {
		attempt += 1;
		phase = 'ready';
	}
	saved = false;
	saveFailed = false;
	refused = false;
}

async function save() {
	const captured = binding;
	const seq = attempt;
	if (!canSave || !captured?.incarnation || !current(seq, captured)) return;
	const chosen = { name, password };
	phase = 'saving';
	saved = false;
	saveFailed = false;
	refused = false;
	try {
		const response = await prepare(captured, seq, chosen);
		if (!response || !current(seq, response.captured)) return;
		const { result } = response;
		if (result.error === 'radio-unverified') {
			phase = 'unverified';
			return;
		}
		if (wifiRadioChanged(result)) {
			refused = true;
			phase = 'ready';
			return;
		}
		if (!result.success || result.name !== chosen.name || result.password !== chosen.password) {
			throw new Error('not-stored');
		}
		loaded = chosen;
		phase = 'ready';
		saved = true;
	} catch {
		if (!binding || !current(seq, binding)) return;
		phase = 'ready';
		saveFailed = true;
	}
}
</script>

{#if phase === 'closed'}
	<Button
		class="h-9 min-h-[var(--touch-target-min)]"
		data-testid="hotspot-off-edit"
		onclick={open}
		size="sm"
		variant="secondary"
	>
		<Pencil aria-hidden="true" class="size-4" />
		{m['hotspotConfigurator.offEdit.open']()}
	</Button>
{:else}
	<!-- biome-ignore lint/a11y/useSemanticElements: A named group around the off-state form; a fieldset introduces form-group sizing. -->
	<div
		class="space-y-3 rounded-lg border p-3"
		data-phase={phase}
		data-testid="hotspot-off-editor"
		role="group"
		aria-label={m['hotspotConfigurator.offEdit.open']()}
	>
		{#if reloaded}
			<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-off-reloaded">
				{m['hotspotConfigurator.radioChanged']()}
			</p>
		{/if}
		{#if phase === 'unsupported' || phase === 'unverified'}
			<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-off-unavailable">
				{phase === 'unverified' ? m['hotspotConfirm.radioUnverified']() : m['hotspotConfirm.bindingUnsupported']()}
			</p>
		{:else if phase === 'loading'}
			<p class="text-muted-foreground flex items-center gap-2 text-xs" role="status">
				<Loader2 aria-hidden="true" class="size-3.5 animate-spin motion-reduce:animate-none" />
				{m['hotspotConfirm.loading']()}
			</p>
		{:else if phase === 'load-failed'}
			<div class="space-y-2" role="alert" data-testid="hotspot-off-load-failed">
				<p class="text-destructive text-xs">{m['hotspotConfigurator.offEdit.loadFailed']()}</p>
				<Button class="h-8 min-h-[var(--touch-target-min)]" onclick={load} size="sm" variant="secondary">
					{m['hotspotConfirm.retry']()}
				</Button>
			</div>
		{:else}
			<div class="space-y-1.5">
				<Label class="text-xs font-medium" for="hotspot-off-name-{device}">{m['network.hotspot.name']()}</Label>
				<Input
					id="hotspot-off-name-{device}"
					class="bg-background font-mono"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					aria-invalid={Boolean(nameError)}
					data-testid="hotspot-off-name"
					maxlength={bounds.name.max}
					oninput={edited}
					bind:value={name}
				/>
				{#if nameError}
					<p class="text-destructive text-xs">{nameError}</p>
				{/if}
			</div>
			<div class="space-y-1.5">
				<Label class="text-xs font-medium" for="hotspot-off-password-{device}">
					{m['network.hotspot.password']()}
				</Label>
				<Input
					id="hotspot-off-password-{device}"
					class="bg-background font-mono"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					aria-invalid={Boolean(passwordError)}
					data-testid="hotspot-off-password"
					maxlength={bounds.password.max}
					oninput={edited}
					type="text"
					bind:value={password}
				/>
				{#if passwordError}
					<p class="text-destructive text-xs">{passwordError}</p>
				{/if}
			</div>
			<p class="text-muted-foreground text-xs">{m['hotspotConfigurator.offEdit.liveOnly']()}</p>
			{#if refused}
				<p class="text-muted-foreground text-xs" role="status">{m['hotspotConfigurator.saveRefused']()}</p>
			{/if}
			{#if saveFailed}
				<p class="text-destructive text-xs" role="alert" data-testid="hotspot-off-save-failed">
					{m['hotspotConfigurator.offEdit.saveFailed']()}
				</p>
			{/if}
			{#if saved}
				<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-off-saved">
					{m['hotspotConfigurator.offEdit.saved']()}
				</p>
			{/if}
		{/if}
		<div class="flex flex-wrap justify-end gap-2">
			<Button
				class="h-9 min-h-[var(--touch-target-min)]"
				data-testid="hotspot-off-cancel"
				onclick={close}
				size="sm"
				variant="outline"
			>
				{(phase === 'ready' || phase === 'saving') && changed ? m['dialog.cancel']() : m['network.dialog.close']()}
			</Button>
			{#if phase === 'ready' || phase === 'saving'}
				<Button
					class="h-9 min-h-[var(--touch-target-min)]"
					data-testid="hotspot-off-save"
					disabled={!canSave}
					onclick={save}
					size="sm"
				>
					{#if phase === 'saving'}
						<Loader2 aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
						{m['hotspotConfigurator.dialog.saving']()}
					{:else}
						<Save aria-hidden="true" class="size-4" />
						{m['hotspotConfigurator.dialog.save']()}
					{/if}
				</Button>
			{/if}
		</div>
	</div>
{/if}
