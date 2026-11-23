<!--
  RemoteAccessDialog.svelte: remote access over Tailscale.

  Shown only on images that ship tailscaled (SettingsView hides the entry when
  the device reports `unavailable` or nothing at all). Four things, in plain
  words: the current state, a field to paste an auth key, the owner's off
  switch, and "forget this device".

  There is deliberately no login link or QR code: whoever opens a login link
  first decides which network the device joins. A pasted key is the owner's
  explicit choice. The key lives in this component only until it is sent, and
  the field is cleared before the answer arrives.

  Every control is pessimistic: the switch and the state badge show the
  device's own `tailscale` status, never the click.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { TAILSCALE_AUTH_KEY_RE } from '@ceraui/rpc/schemas';
import { LoaderCircle, TriangleAlert, Waypoints } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Switch } from '$lib/components/ui/switch';
import { getOperationPhase, osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getTailscale } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	open?: boolean;
}

let { open = $bindable(false) }: Props = $props();

const status = $derived(getTailscale());
const phase = $derived(status?.state ?? 'unknown');
const on = $derived(phase !== 'off');

const SWITCH_KEY = 'tailscale-enabled';
const JOIN_KEY = 'tailscale-join';
const FORGET_KEY = 'tailscale-forget';
const switchBusy = $derived(getOperationPhase(SWITCH_KEY) === 'pending');
const joinBusy = $derived(getOperationPhase(JOIN_KEY) === 'pending');
const forgetBusy = $derived(getOperationPhase(FORGET_KEY) === 'pending');

let authKey = $state('');
let confirmingForget = $state(false);
let confirmingOff = $state(false);

const keyLooksValid = $derived(TAILSCALE_AUTH_KEY_RE.test(authKey.trim()));
// Say why Join is disabled once something has been typed.
const showKeyHint = $derived(authKey.trim() !== '' && !keyLooksValid);

const stateLabel = $derived.by(() => {
	switch (phase) {
		case 'off':
			return m["advanced.remoteAccess.stateOff"]();
		case 'needs_key':
			return m["advanced.remoteAccess.stateNeedsKey"]();
		case 'needs_approval':
			return m["advanced.remoteAccess.stateNeedsApproval"]();
		case 'joining':
			return m["advanced.remoteAccess.stateJoining"]();
		case 'connected':
			return m["advanced.remoteAccess.stateConnected"]();
		default:
			return m["advanced.remoteAccess.stateUnknown"]();
	}
});

function failureMessage(reason: string | undefined, fallback: () => string): string {
	switch (reason) {
		case 'streaming':
		case 'stream_liveness_unknown':
		case 'update_in_progress':
			return m["notifications.disruptiveActionRefused"]();
		case 'tailnet_ssh_not_allowed':
			return m["advanced.remoteAccess.joinFailedTailnetSsh"]();
		default:
			return fallback();
	}
}

// Off asks first: on a box reached over Tailscale, it ends this very session.
function onSwitch(next: boolean) {
	confirmingForget = false;
	if (next) {
		confirmingOff = false;
		void setEnabled(true);
	} else {
		confirmingOff = true;
	}
}

async function setEnabled(next: boolean) {
	let refusal: string | undefined;
	confirmingOff = false;
	confirmingForget = false;
	await osCommand({
		key: SWITCH_KEY,
		target: next,
		confirmOnResolve: true,
		pendingTtlMs: 75_000,
		rpc: async () => {
			const result = await rpc.system.tailscaleSetEnabled({ enabled: next });
			refusal = result.error;
			return result;
		},
		failMessage: () => failureMessage(refusal, () => m["network.os.operationFailed"]()),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

async function join(event: SubmitEvent) {
	event.preventDefault();
	const key = authKey.trim();
	if (!TAILSCALE_AUTH_KEY_RE.test(key)) {
		toast.error(m["advanced.remoteAccess.keyInvalid"]());
		return;
	}
	// Clear the field before the request goes out, so the key is not kept on
	// screen or in component state while the device works.
	authKey = '';
	let refusal: string | undefined;
	await osCommand({
		key: JOIN_KEY,
		confirmOnResolve: true,
		pendingTtlMs: 75_000,
		rpc: async () => {
			const result = await rpc.system.tailscaleJoin({ authKey: key });
			refusal = result.error;
			return result;
		},
		failMessage: () => failureMessage(refusal, () => m["advanced.remoteAccess.joinFailed"]()),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

async function forget() {
	let refusal: string | undefined;
	await osCommand({
		key: FORGET_KEY,
		confirmOnResolve: true,
		rpc: async () => {
			const result = await rpc.system.tailscaleLogout();
			refusal = result.error;
			return result;
		},
		failMessage: () => failureMessage(refusal, () => m["advanced.remoteAccess.forgetFailed"]()),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
	confirmingForget = false;
}

// What the owner should know about a join the image's enrolment finished.
const noticeText = $derived.by(() => {
	if (phase !== 'connected') return undefined;
	switch (status?.notice) {
		case 'ssh_off_by_tailnet':
			return m["advanced.remoteAccess.noticeSshOff"]();
		case 'updates_not_pinned':
			return m["advanced.remoteAccess.noticeUpdatesNotPinned"]();
		default:
			return undefined;
	}
});

// Forget is only offered while the device holds a login.
const canForget = $derived(phase === 'connected' || phase === 'needs_approval');
</script>

<AppDialog
	bind:open
	description={m["settings.index.remoteAccessDesc"]()}
	hideFooter
	icon={Waypoints}
	title={m["settings.index.remoteAccess"]()}
>
	<div class="space-y-5">
		<!-- Current state, from the device. -->
		<div
			class={cn(
				'flex items-center justify-between gap-3 rounded-lg border px-4 py-3',
				phase === 'connected' ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/40',
			)}
			aria-live="polite"
			data-state={phase}
			data-testid="remote-access-status"
			role="status"
		>
			<div class="flex min-w-0 items-center gap-2.5 text-sm">
				{#if phase === 'joining'}
					<LoaderCircle
						aria-hidden="true"
						class="text-muted-foreground size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
					/>
				{:else}
					<span
						class={cn(
							'size-2.5 shrink-0 rounded-full',
							phase === 'connected' ? 'bg-primary' : 'bg-muted-foreground/50',
						)}
					></span>
				{/if}
				<span class="min-w-0">
					{#if phase === 'connected' && status?.hostname}
						<span class="block truncate font-medium" data-testid="remote-access-hostname">
							{m["advanced.remoteAccess.connectedAs"]({ hostname: status.hostname })}
						</span>
						{#if status.address}
							<span class="text-muted-foreground block truncate font-mono text-xs">
								{m["advanced.remoteAccess.address"]({ address: status.address })}
							</span>
						{/if}
					{:else}
						<span class="font-medium">{m["settings.index.remoteAccess"]()}</span>
					{/if}
				</span>
			</div>
			<span
				class={cn(
					'shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold',
					phase === 'connected' ? 'bg-primary/15 text-primary' : 'bg-secondary text-secondary-foreground',
				)}
				data-testid="remote-access-state"
			>
				{stateLabel}
			</span>
		</div>

		<!-- The owner's off switch. Off stops the service now and at boot. -->
		<div class="overflow-hidden rounded-lg border">
			<div class="flex items-center justify-between gap-4 px-4 py-3.5" data-testid="remote-access-switch-row">
				<div class="min-w-0 flex-1">
					<p class="text-sm font-semibold">{m["advanced.remoteAccess.switch"]()}</p>
					<p class="text-muted-foreground mt-0.5 text-xs">{m["advanced.remoteAccess.switchHint"]()}</p>
				</div>
				<span class="flex shrink-0 items-center gap-2">
					{#if switchBusy}
						<LoaderCircle
							aria-hidden="true"
							class="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
						/>
					{/if}
					<Switch
						aria-label={m["advanced.remoteAccess.switch"]()}
						bind:checked={() => on, (next) => onSwitch(next)}
						data-testid="remote-access-switch"
						disabled={switchBusy || joinBusy || forgetBusy}
					/>
				</span>
			</div>
		</div>

		{#if confirmingOff}
			<div
				class="border-destructive/40 bg-destructive/5 space-y-3 rounded-lg border px-4 py-3"
				data-testid="remote-access-off-confirm"
			>
				<p class="text-sm">{m["advanced.remoteAccess.offHint"]()}</p>
				<div class="flex gap-2">
					<Button
						class="flex-1"
						data-testid="remote-access-off-cancel"
						onclick={() => (confirmingOff = false)}
						variant="outline"
					>
						{m["advanced.remoteAccess.offCancel"]()}
					</Button>
					<Button
						class="bg-destructive text-destructive-foreground hover:bg-destructive/90 flex-1"
						data-testid="remote-access-off-yes"
						onclick={() => void setEnabled(false)}
					>
						{m["advanced.remoteAccess.offConfirm"]()}
					</Button>
				</div>
			</div>
		{/if}

		{#if noticeText}
			<div
				class="border-status-warning/40 bg-status-warning/10 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm"
				data-testid="remote-access-notice"
				role="status"
			>
				<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
				<span>{noticeText}</span>
			</div>
		{/if}

		{#if phase === 'off'}
			<p class="text-muted-foreground text-sm" data-testid="remote-access-body">
				{m["advanced.remoteAccess.offBody"]()}
			</p>
		{:else if phase === 'joining'}
			<p class="text-muted-foreground text-sm" data-testid="remote-access-body">
				{m["advanced.remoteAccess.joiningBody"]()}
			</p>
		{:else if phase === 'needs_approval'}
			<p class="text-muted-foreground text-sm" data-testid="remote-access-body">
				{m["advanced.remoteAccess.needsApprovalBody"]()}
			</p>
		{:else if phase === 'unknown'}
			<div
				class="border-status-warning/40 bg-status-warning/10 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm"
				data-testid="remote-access-body"
				role="status"
			>
				<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-4 shrink-0" />
				<span>{m["advanced.remoteAccess.unknownBody"]()}</span>
			</div>
		{/if}

		<!-- Join with a pasted key. No login link: the key is the owner's choice. -->
		{#if phase === 'needs_key'}
			<form class="space-y-2" data-testid="remote-access-join" onsubmit={join}>
				<p class="text-muted-foreground text-sm">{m["advanced.remoteAccess.needsKeyBody"]()}</p>
				<Label class="text-sm font-medium" for="remote-access-key">
					{m["advanced.remoteAccess.keyLabel"]()}
				</Label>
				<Input
					id="remote-access-key"
					class="font-mono"
					autocapitalize="off"
					aria-describedby={showKeyHint ? 'remote-access-key-hint' : undefined}
					aria-invalid={showKeyHint}
					autocomplete="off"
					bind:value={authKey}
					data-testid="remote-access-key"
					disabled={joinBusy}
					spellcheck={false}
					type="password"
				/>
				{#if showKeyHint}
					<p class="text-destructive text-xs" data-testid="remote-access-key-hint" id="remote-access-key-hint">
						{m["advanced.remoteAccess.keyInvalid"]()}
					</p>
				{/if}
				<Button
					class="w-full gap-2"
					data-testid="remote-access-join-button"
					disabled={joinBusy || !keyLooksValid}
					type="submit"
				>
					{#if joinBusy}
						<LoaderCircle aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
					{/if}
					{m["advanced.remoteAccess.join"]()}
				</Button>
			</form>
		{/if}

		<!-- Forget: two steps, because it needs a new key to undo. -->
		{#if canForget}
			<div class="space-y-2">
				{#if confirmingForget}
					<div
						class="border-destructive/40 bg-destructive/5 space-y-3 rounded-lg border px-4 py-3"
						data-testid="remote-access-forget-confirm"
					>
						<p class="text-sm">{m["advanced.remoteAccess.forgetHint"]()}</p>
						<div class="flex gap-2">
							<Button
								class="flex-1"
								data-testid="remote-access-forget-cancel"
								disabled={forgetBusy}
								onclick={() => (confirmingForget = false)}
								variant="outline"
							>
								{m["advanced.remoteAccess.forgetCancel"]()}
							</Button>
							<Button
								class="bg-destructive text-destructive-foreground hover:bg-destructive/90 flex-1 gap-2"
								data-testid="remote-access-forget-yes"
								disabled={forgetBusy}
								onclick={forget}
							>
								{#if forgetBusy}
									<LoaderCircle aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
								{/if}
								{m["advanced.remoteAccess.forgetConfirm"]()}
							</Button>
						</div>
					</div>
				{:else}
					<Button
						class="w-full"
						data-testid="remote-access-forget"
						disabled={switchBusy}
						onclick={() => (confirmingForget = true)}
						variant="outline"
					>
						{m["advanced.remoteAccess.forget"]()}
					</Button>
				{/if}
			</div>
		{/if}
	</div>
</AppDialog>
