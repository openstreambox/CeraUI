<!--
  ModemRestartControl.svelte: Restart modem's confirmation, progress and result
  for the whole cellular section. It sits above the rows because the restarted
  modem's row disappears and comes back under a new index; the line here stays.

  Calm wording: the confirmation states the cost (how long this modem is out,
  and what that means for a running stream) before anything happens, and the
  result says what happened and the one next step if there is one.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { RestartModemRefusal } from '@ceraui/rpc/schemas';
import { CircleCheck, CircleX, RotateCcw, TriangleAlert, X } from '@lucide/svelte';

import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { Button } from '$lib/components/ui/button';
import type { ModemRestartFlow } from '$lib/modem/modem-restart.svelte';
import { cn } from '$lib/utils';

let { flow }: { flow: ModemRestartFlow } = $props();

const phase = $derived(flow.phase);

// Dialog state follows the flow; closing the dialog (Esc, overlay, Cancel) cancels.
let open = $state(false);
$effect(() => {
	open = phase.kind === 'confirm' || phase.kind === 'confirm-only-link';
});
$effect(() => {
	// `cancel` only acts on a confirmation phase, so closing because a restart
	// started (or a result arrived) is a no-op.
	if (!open) flow.cancel();
});

// A one-second clock, only while a restart runs.
let now = $state(Date.now());
$effect(() => {
	if (phase.kind !== 'restarting') return;
	now = Date.now();
	const timer = setInterval(() => {
		now = Date.now();
	}, 1000);
	return () => clearInterval(timer);
});
const elapsed = $derived(
	phase.kind === 'restarting' ? Math.max(0, Math.round((now - phase.startedAt) / 1000)) : 0,
);

const seconds = (value: number | undefined) => String(Math.round(value ?? 0));

function refusalText(refusal: RestartModemRefusal, retryAfter: number | undefined): string {
	switch (refusal) {
		case 'not_qualified':
			return m['network.restart.refused.notQualified']();
		case 'restart_in_progress':
			return m['network.restart.refused.another']();
		case 'cooldown':
			return m['network.restart.refused.cooldown']({ seconds: seconds(retryAfter) });
		case 'mutation_in_progress':
			return m['network.restart.refused.busy']();
		case 'streaming_active':
			return m['network.restart.refused.streamStarting']();
		default:
			return m['network.restart.refused.other']();
	}
}

type Line = { tone: 'progress' | 'success' | 'warning' | 'error'; text: string };
const line = $derived.by<Line | undefined>(() => {
	switch (phase.kind) {
		case 'restarting':
			return {
				tone: 'progress',
				text: m['network.restart.status.restarting']({
					name: phase.target.name,
					seconds: String(elapsed),
				}),
			};
		case 'refused':
			return { tone: 'warning', text: refusalText(phase.refusal, phase.retryAfterSeconds) };
		case 'no-answer':
			return { tone: 'warning', text: m['network.restart.status.noAnswer']() };
		case 'result': {
			const { result, target } = phase;
			const name = target.name;
			switch (result.outcome) {
				case 'back_connected':
					return {
						tone: 'success',
						text: m['network.restart.status.back']({ name, seconds: seconds(result.elapsedSeconds) }),
					};
				case 'back_not_connected':
					return { tone: 'warning', text: m['network.restart.status.backNotConnected']({ name }) };
				case 'not_back':
					return {
						tone: 'error',
						text: m['network.restart.status.notBack']({ name, seconds: seconds(result.elapsedSeconds) }),
					};
				case 'unchanged':
					return { tone: 'warning', text: m['network.restart.status.unchanged']({ name }) };
				default:
					return { tone: 'error', text: m['network.restart.status.failed']({ name }) };
			}
		}
		default:
			return undefined;
	}
});

const ICON = { progress: RotateCcw, success: CircleCheck, warning: TriangleAlert, error: CircleX };
const TONE_CLASS = {
	progress: 'text-foreground',
	success: 'text-status-success',
	warning: 'text-status-warning',
	error: 'text-status-error',
};

const onlyLink = $derived(phase.kind === 'confirm-only-link');
const confirmTarget = $derived(
	phase.kind === 'confirm' || phase.kind === 'confirm-only-link' ? phase.target : undefined,
);
const streaming = $derived(phase.kind === 'confirm' && phase.streaming);
</script>

{#if line}
	{const Icon = $derived(ICON[line.tone])}
	<div
		class="flex items-start gap-2 border-b px-4 py-2 text-sm"
		role="status"
		aria-live="polite"
		data-testid="modem-restart-status"
		data-phase={phase.kind}
		data-outcome={phase.kind === 'result' ? phase.result.outcome : undefined}
	>
		<Icon class={cn('mt-0.5 size-4 shrink-0', TONE_CLASS[line.tone])} aria-hidden="true" />
		<p class="min-w-0 flex-1 leading-snug tabular-nums">{line.text}</p>
		{#if phase.kind !== 'restarting'}
			<Button
				class="-my-1 size-8 min-h-[var(--touch-target-min)] shrink-0"
				size="icon"
				variant="ghost"
				aria-label={m['network.restart.dismiss']()}
				data-testid="modem-restart-dismiss"
				onclick={() => flow.dismiss()}
			>
				<X class="size-4" aria-hidden="true" />
			</Button>
		{/if}
	</div>
{/if}

<AppDialog
	bind:open
	title={onlyLink ? m['network.restart.onlyLink.title']() : m['network.restart.confirm.title']()}
	description={confirmTarget?.name}
	icon={onlyLink ? TriangleAlert : RotateCcw}
	destructive={onlyLink}
	primaryLabel={onlyLink ? m['network.restart.onlyLink.primary']() : m['network.restart.confirm.primary']()}
	onPrimary={() => void flow.confirm()}
	onSecondary={() => flow.cancel()}
>
	{#if confirmTarget}
		<div class="space-y-2 text-sm" data-testid="modem-restart-confirm" data-only-link={onlyLink ? 'true' : 'false'}>
			{#if onlyLink}
				<p>{m['network.restart.onlyLink.body']({ seconds: String(confirmTarget.expectedSeconds) })}</p>
			{:else}
				<p>{m['network.restart.confirm.body']({ seconds: String(confirmTarget.expectedSeconds) })}</p>
				{#if streaming}
					<p class="text-muted-foreground">{m['network.restart.confirm.streaming']()}</p>
				{/if}
			{/if}
		</div>
	{/if}
</AppDialog>
