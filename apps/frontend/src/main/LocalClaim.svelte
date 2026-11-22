<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { localClaimCodeSchema } from '@ceraui/rpc/schemas';
import { onDestroy, onMount } from 'svelte';
import { toast } from 'svelte-sonner';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import {
	type ClaimOutcome,
	canRememberSignIn,
	claimLocalOwner,
	discardPendingClaim,
	finishLocalClaim,
	getClaimPending,
	subscribeAuthStatus,
} from '$lib/stores/auth-status.svelte';
import { getScannedClaimCode, takeScannedClaimCode } from '$lib/stores/claim-fragment.svelte';

// `mode` is undefined once the box has an owner but this page still holds the
// secret of an unconfirmed claim.
let { mode, offline }: { mode: 'ready' | 'unavailable' | undefined; offline: boolean } = $props();
let code = $state('');
let field = $state<HTMLInputElement | null>(null);
let submitting = $state(false);
let notice = $state<'refused' | 'unreachable' | undefined>(undefined);
let secure = $state(false);
let storage = $state(true);
let mounted = $state(false);
let interaction = 0;
const pending = $derived(getClaimPending());

const unsubscribe = subscribeAuthStatus(() => {
	interaction++;
	code = '';
	if (field) field.value = '';
	submitting = false;
	notice = undefined;
});
onDestroy(unsubscribe);

onMount(() => {
	secure = window.isSecureContext;
	storage = canRememberSignIn();
	mounted = true;
});

// The scanned code is used only where this page can complete setup.
$effect(() => {
	if (!mounted || !getScannedClaimCode()) return;
	const scanned = takeScannedClaimCode();
	if (secure && storage && mode === 'ready' && scanned) code = scanned;
});

const normalized = $derived(code.trim().toLowerCase());
const valid = $derived(localClaimCodeSchema.safeParse(normalized).success);

function scrubOnDetach(node: HTMLInputElement) {
	return () => {
		node.value = '';
	};
}

async function run(start: () => Promise<ClaimOutcome>) {
	submitting = true;
	notice = undefined;
	const current = ++interaction;
	let outcome: ClaimOutcome = { kind: 'cancelled' };
	try {
		outcome = await start();
	} finally {
		if (outcome.kind === 'ok' && !outcome.remembered) {
			toast.warning(m["auth.claimNotRemembered"](), { duration: Number.POSITIVE_INFINITY });
		}
		if (current === interaction) {
			submitting = false;
			if (outcome.kind === 'refused' || outcome.kind === 'unreachable') notice = outcome.kind;
		}
	}
}

async function submit(event: SubmitEvent) {
	event.preventDefault();
	if (submitting || offline || !secure || !storage || mode !== 'ready' || !valid) return;
	const submitted = normalized;
	code = '';
	if (field) field.value = '';
	await run(() => claimLocalOwner(submitted));
}

async function retry() {
	if (submitting || offline) return;
	await run(finishLocalClaim);
}
</script>

{#if pending}
	<div class="mt-8 space-y-3">
		<p class="text-foreground text-sm" role="status">{m["auth.claimUncertain"]()}</p>
		<Button
			class="h-11 w-full"
			variant={mode === 'ready' ? 'outline' : 'default'}
			disabled={submitting || offline}
			onclick={retry}
		>
			{submitting ? m["auth.claimWorking"]() : m["auth.claimRetry"]()}
		</Button>
		{#if mode === undefined}
			<Button class="w-full" variant="ghost" disabled={submitting} onclick={discardPendingClaim}>
				{m["auth.claimUsePassword"]()}
			</Button>
		{/if}
	</div>
{/if}

{#if mode === 'unavailable' || (mode === 'ready' && !secure)}
	<p class="text-muted-foreground mt-8 text-center text-sm" role="status">
		{m["auth.claimUnavailable"]()}
	</p>
{:else if mode === 'ready' && !storage}
	<p class="text-muted-foreground mt-8 text-center text-sm" role="status">
		{m["auth.claimNoStorage"]()}
	</p>
{:else if mode === 'ready'}
	<form class="mt-8 space-y-5" onsubmit={submit}>
		<div class="space-y-2">
			<Label for="claim-code">{m["auth.claimCode"]()}</Label>
			<Input
				id="claim-code"
				aria-describedby={notice ? 'claim-error' : undefined}
				aria-invalid={notice === 'refused'}
				autocomplete="off"
				autocapitalize="none"
				spellcheck={false}
				dir="ltr"
				type="password"
				maxlength={32}
				disabled={submitting || offline}
				bind:ref={field}
				bind:value={code}
				{@attach scrubOnDetach}
				oninput={() => (notice = undefined)}
			/>
			{#if notice === 'refused'}
				<p id="claim-error" class="text-destructive text-sm" role="alert">{m["auth.claimFailed"]()}</p>
			{:else if notice === 'unreachable'}
				<p id="claim-error" class="text-destructive text-sm" role="alert">{m["auth.claimUnreachable"]()}</p>
			{/if}
		</div>
		<Button class="h-11 w-full" disabled={submitting || offline || !valid} type="submit">
			{submitting ? m["auth.claimWorking"]() : m["auth.claimButton"]()}
		</Button>
	</form>
{/if}
