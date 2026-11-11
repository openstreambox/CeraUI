<script lang="ts">
import { resolveMessageKey as t } from '@ceraui/i18n/svelte';
import { type EsimError, type EsimOperationInput, type EsimSnapshot, parseEsimActivationCode, type SupportClaimState } from '@ceraui/rpc/schemas';
import { onDestroy } from 'svelte';

import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { loadWithinBound } from '$lib/modem/async-surface';
import { rpc } from '$lib/rpc';

import { decodeEsimQrImage } from './esim-qr';

let { claim, deviceId }: { claim: SupportClaimState | undefined; deviceId: string } = $props();
let open = $state(false);
let busy = $state(false);
let acknowledged = $state(false);
let snapshot = $state<EsimSnapshot | undefined>();
let activationCode = $state('');
let smdp = $state('');
const inputId = $props.id();
let matchingId = $state('');
let confirmationCode = $state('');
let manual = $state(false);
let error = $state<EsimError | 'invalid_code' | 'qr_failed' | undefined>();
let success = $state(false);
let pending = $state<EsimOperationInput | undefined>();
let generation = 0;
const code = $derived(manual ? `LPA:1$${smdp}$${matchingId}` : activationCode.trim());
const parsed = $derived(parseEsimActivationCode(code));
const enabled = $derived(claim === 'enabled' || claim === 'capable' || claim === 'certified');

function clearSecrets(): void {
	activationCode = '';
	smdp = '';
	matchingId = '';
	confirmationCode = '';
	pending = undefined;
}

onDestroy(() => { generation++; clearSecrets(); });

$effect(() => {
	// Device changes invalidate all state, including an in-flight answer.
	void deviceId;
	generation++;
	snapshot = undefined;
	clearSecrets();
	acknowledged = false;
	error = undefined;
	success = false;
	open = false;
});

async function perform(input: EsimOperationInput): Promise<void> {
	if (busy) return;
	const requested = deviceId;
	const epoch = generation;
	busy = true;
	error = undefined;
	success = false;
	clearSecrets();
	snapshot = undefined;
	const result = await loadWithinBound('esimOperation', () => rpc.modems.esimOperation(input));
	if (epoch !== generation || requested !== deviceId) { busy = false; return; }
	busy = false;
	if (result.phase !== 'loaded') { error = 'outcome_unknown'; return; }
	if (!result.value.success) { error = result.value.error; return; }
	snapshot = result.value.snapshot;
	success = true;
}

function stage(action: 'enable' | 'disable' | 'delete', profileId: string): void {
	if (!snapshot) return;
	pending = { device: deviceId, acknowledged: true, action, snapshot: snapshot.token, profileId };
}

function stageDownload(): void {
	if (!snapshot || !parsed) { error = 'invalid_code'; return; }
	if (parsed.confirmationRequired && !confirmationCode) { error = 'confirmation_required'; return; }
	pending = { device: deviceId, acknowledged: true, action: 'download', snapshot: snapshot.token,
		activationCode: code, ...(confirmationCode ? { confirmationCode } : {}) };
}

async function readQr(event: Event): Promise<void> {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file) return;
	const epoch = generation;
	try {
		const decoded = await decodeEsimQrImage(file);
		if (epoch !== generation) return;
		manual = false;
		activationCode = decoded;
		error = undefined;
	} catch {
		if (epoch === generation) error = 'qr_failed';
	}
}

function toggle(): void {
	open = !open;
	if (!open) { clearSecrets(); snapshot = undefined; acknowledged = false; error = undefined; success = false; }
}
</script>

{#if claim !== undefined && claim !== 'unavailable'}
<section class="rounded-lg border p-4 space-y-3" data-testid="modem-esim-management">
	<h3 class="font-semibold">{t('network.esim.title')}</h3>
	<p class="text-sm text-muted-foreground">{t('network.esim.intro')}</p>
	{#if !enabled}
		<p role="status">{t('network.esim.gate')}</p>
	{:else}
		<Button variant="outline" onclick={toggle} disabled={busy} aria-expanded={open}>{t('network.esim.manage')}</Button>
		{#if open}
			<p class="text-sm">{t('network.esim.warning')}</p>
			<label class="flex gap-2 text-sm"><input type="checkbox" bind:checked={acknowledged} disabled={busy} />{t('network.esim.acknowledge')}</label>
			<Button variant="outline" disabled={busy || !acknowledged} onclick={() => perform({ device: deviceId, acknowledged: true, action: 'inspect' })}>{t('network.esim.read')}</Button>
			{#if busy}<p role="status">{t('network.esim.busy')}</p>{/if}
			{#if error}<p role="alert">{t(`network.esim.errors.${error}`)}</p>{/if}
			{#if success}<p role="status">{t('network.esim.verified')}</p>{/if}
			{#if snapshot}
				{#if snapshot.profiles.length === 0}<p>{t('network.esim.empty')}</p>{/if}
				<ul class="space-y-3">
					{#each snapshot.profiles as profile (profile.id)}
					<li class="rounded border p-3 space-y-2">
						<p class="font-medium">{profile.name || profile.provider || t('network.esim.profile')}</p>
						<p class="text-sm">{profile.provider} · {t(`network.esim.${profile.state}`)}</p>
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" disabled={busy || !acknowledged || pending !== undefined} onclick={() => stage(profile.state === 'enabled' ? 'disable' : 'enable', profile.id)}>{t(profile.state === 'enabled' ? 'network.esim.disable' : 'network.esim.enable')}</Button>
							<Button variant="outline" disabled={busy || !acknowledged || profile.state === 'enabled' || pending !== undefined} onclick={() => stage('delete', profile.id)}>{t('network.esim.delete')}</Button>
						</div>
					</li>
					{/each}
				</ul>
				<div class="space-y-3">
					<h4 class="font-medium">{t('network.esim.add')}</h4>
					<p class="text-sm text-muted-foreground">{t('network.esim.obtain')}</p>
					<label class="block text-sm">{t('network.esim.qr')}<input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onchange={readQr} disabled={busy || pending !== undefined} class="block w-full" /></label>
					<label class="flex gap-2 text-sm"><input type="checkbox" bind:checked={manual} disabled={busy || pending !== undefined} />{t('network.esim.manual')}</label>
					{#if manual}
						<label for={`${inputId}-smdp`} class="block text-sm">{t('network.esim.smdp')}<Input id={`${inputId}-smdp`} bind:value={smdp} autocomplete="off" disabled={busy || pending !== undefined} /></label>
						<label for={`${inputId}-matchingId`} class="block text-sm">{t('network.esim.matchingId')}<Input id={`${inputId}-matchingId`} type="password" bind:value={matchingId} autocomplete="off" disabled={busy || pending !== undefined} /></label>
					{:else}
						<label for={`${inputId}-code`} class="block text-sm">{t('network.esim.code')}<Input id={`${inputId}-code`} type="password" bind:value={activationCode} autocomplete="off" disabled={busy || pending !== undefined} /></label>
					{/if}
					<label for={`${inputId}-confirmation`} class="block text-sm">{t('network.esim.confirmation')}<Input id={`${inputId}-confirmation`} type="password" bind:value={confirmationCode} autocomplete="off" disabled={busy || pending !== undefined} /></label>
					<p class="text-sm text-muted-foreground">{t('network.esim.pinHelp')}</p>
					{#if parsed}<p class="text-sm">{t('network.esim.smdp')} · {parsed.smdpAddress}</p>{/if}
					<Button disabled={busy || !acknowledged || !parsed || pending !== undefined} onclick={stageDownload}>{t('network.esim.add')}</Button>
				</div>
			{/if}
			{#if pending}
				<fieldset class="rounded border p-3 space-y-2" aria-label={t('network.esim.confirm')}>
					<p>{t(`network.esim.confirm_${pending.action}`)}</p>
					<Button disabled={busy || !acknowledged} onclick={() => { if (pending) void perform(pending); }}>{t('network.esim.confirm')}</Button>
					<Button variant="outline" disabled={busy} onclick={clearSecrets}>{t('network.esim.cancel')}</Button>
				</fieldset>
			{/if}
		{/if}
	{/if}
</section>
{/if}
