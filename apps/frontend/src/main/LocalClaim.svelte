<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { localClaimCodeSchema } from '@ceraui/rpc/schemas';
import { onDestroy, onMount } from 'svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { claimLocalOwner, subscribeAuthStatus } from '$lib/stores/auth-status.svelte';

let { mode, offline }: { mode: 'ready' | 'unavailable'; offline: boolean } = $props();
let code = $state('');
let field = $state<HTMLInputElement | null>(null);
let submitting = $state(false);
let rejected = $state(false);
let secure = $state(false);
let interaction = 0;

const unsubscribe = subscribeAuthStatus(() => {
	interaction++;
	code = '';
	if (field) field.value = '';
	submitting = false;
	rejected = false;
});
onDestroy(unsubscribe);

onMount(() => {
	secure = window.isSecureContext;
	const fragment = window.location.hash;
	if (fragment.startsWith('#claim=')) {
		history.replaceState(history.state, '', window.location.pathname + window.location.search);
		if (secure && mode === 'ready') {
			code = localClaimCodeSchema.safeParse(fragment.slice(7)).data ?? '';
		}
	}
});

const normalized = $derived(code.trim().toLowerCase());
const valid = $derived(localClaimCodeSchema.safeParse(normalized).success);

async function submit(event: SubmitEvent) {
	event.preventDefault();
	if (submitting || offline || !secure || mode !== 'ready' || !valid) return;
	submitting = true;
	rejected = false;
	const current = ++interaction;
	const ownerSecret = Array.from(
		crypto.getRandomValues(new Uint8Array(32)),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
	const pending = claimLocalOwner({ code: normalized, ownerSecret });
	code = '';
	if (field) field.value = '';
	const ok = await pending;
	if (current === interaction) {
		submitting = false;
		rejected = !ok;
	}
}
</script>

{#if mode === 'unavailable' || !secure}
	<p class="text-muted-foreground mt-8 text-center text-sm" role="status">
		{m["auth.claimUnavailable"]()}
	</p>
{:else}
	<form class="mt-8 space-y-5" onsubmit={submit}>
		<div class="space-y-2">
			<Label for="claim-code">{m["auth.claimCode"]()}</Label>
			<Input
				id="claim-code"
				aria-describedby={rejected ? 'claim-error' : undefined}
				aria-invalid={rejected}
				autocomplete="off"
				autocapitalize="none"
				spellcheck={false}
				dir="ltr"
				type="password"
				maxlength={32}
				disabled={submitting || offline}
				bind:ref={field}
				bind:value={code}
				oninput={() => (rejected = false)}
			/>
			{#if rejected}
				<p id="claim-error" class="text-destructive text-sm" role="alert">{m["auth.claimFailed"]()}</p>
			{/if}
		</div>
		<Button class="h-11 w-full" disabled={submitting || offline || !valid} type="submit">
			{submitting ? m["auth.claimWorking"]() : m["auth.claimButton"]()}
		</Button>
	</form>
{/if}
