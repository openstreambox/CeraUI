<script lang="ts">
/**
 * The box's reconnect settings, in the Streaming group beside Autostart: whether
 * the stream reconnects on its own after every link was lost, and for how long
 * it keeps trying (default two minutes). Both follow the authoritative config
 * broadcast; a write adopts the persisted `applied` values, and a refused or
 * failed write leaves the controls where they were (one toast, from osCommand).
 */
import { m } from '@ceraui/i18n/svelte';
import { RefreshCw } from '@lucide/svelte';

import AsyncSwitch from '$lib/components/custom/async-switch.svelte';
import * as Select from '$lib/components/ui/select';
import { osCommand } from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { getConfig } from '$lib/rpc/subscriptions.svelte';

const DEFAULT_MAX_S = 120;
const CHOICES_S = [60, 120, 300, 600, 1800];

let enabled = $derived(getConfig()?.auto_reconnect !== false);
let maxS = $derived(getConfig()?.auto_reconnect_max_s ?? DEFAULT_MAX_S);
const choices = $derived(CHOICES_S.includes(maxS) ? CHOICES_S : [...CHOICES_S, maxS].sort((a, b) => a - b));

function label(seconds: number): string {
	const minutes = Math.round((seconds / 60) * 10) / 10;
	return m['settings.index.autoReconnectMinutes']({ minutes: String(minutes) });
}

async function save(input: { enabled?: boolean; max_s?: number }) {
	const result = await osCommand({
		key: 'auto-reconnect',
		target: input,
		rpc: () => rpc.streaming.setReconnect(input),
		confirmOnResolve: true,
		failMessage: () => m['settings.index.autoReconnectError'](),
	});
	if (!result?.success) throw new Error('auto_reconnect_failed');
	enabled = result.applied.enabled;
	maxS = result.applied.max_s;
}

async function changeEnabled(next: boolean) {
	await save({ enabled: next });
}

function changeMax(value: string) {
	const next = Number(value);
	if (!Number.isInteger(next) || next === maxS) return;
	void save({ max_s: next }).catch(() => {
		// osCommand already said so; the select follows the config, unchanged.
	});
}
</script>

<div class="flex w-full flex-col gap-3 px-4 py-3.5" data-testid="settings-auto-reconnect">
	<div class="flex w-full items-center gap-4">
		<span class="bg-secondary text-foreground grid size-9 shrink-0 place-items-center rounded-lg">
			<RefreshCw class="size-[18px]" />
		</span>
		<span class="text-slot">
			<span class="block text-sm font-semibold">{m['settings.index.autoReconnect']()}</span>
			<span class="text-muted-foreground block text-xs">{m['settings.index.autoReconnectDesc']()}</span>
		</span>
		<span class="shrink-0">
			<AsyncSwitch
				aria-label={m['settings.index.autoReconnect']()}
				checked={enabled}
				data-testid="settings-auto-reconnect-switch"
				onCheckedChange={changeEnabled}
			/>
		</span>
	</div>
	<div class="flex w-full flex-wrap items-center gap-x-4 gap-y-2 ps-13">
		<span class="text-slot">
			<span class="block text-sm" id="settings-auto-reconnect-max-label">{m['settings.index.autoReconnectMax']()}</span>
			<span class="text-muted-foreground block text-xs">{m['settings.index.autoReconnectMaxDesc']()}</span>
		</span>
		<Select.Root type="single" value={String(maxS)} disabled={!enabled} onValueChange={changeMax}>
			<Select.Trigger
				aria-labelledby="settings-auto-reconnect-max-label"
				class="w-32 shrink-0"
				data-testid="settings-auto-reconnect-max"
			>
				{label(maxS)}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each choices as seconds (seconds)}
						<Select.Item label={label(seconds)} value={String(seconds)}></Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
	</div>
</div>
