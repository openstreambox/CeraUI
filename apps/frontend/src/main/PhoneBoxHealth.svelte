<script lang="ts">
	import { m } from '@ceraui/i18n/svelte';
	import type { StatusResponse } from '@ceraui/rpc/schemas';

	let {
		reachable = true,
		health = [],
		links = [],
		carrying,
		way,
		settingsSummary = false,
		onrestart,
	}: {
		reachable?: boolean;
		health?: NonNullable<StatusResponse['box_health']>;
		links?: { label: string; internet: string }[];
		way?: 'moblin' | 'srt' | 'internet' | null;
		settingsSummary?: boolean;
		carrying?: 'streaming' | 'idle' | 'unknown';
		onrestart?: () => void;
	} = $props();
	const urgent = $derived(health.filter(p => p.part !== 'update-orchestrator-maintenance'));
	const state = $derived(carrying === 'idle' ? 'ready' : 'protected');
</script>

<section>
	<h2>{m['live.phone.health']()}</h2>
	{#if !reachable}<p>{m['live.phone.remoteUnreachable']()}</p>{:else}
		{#if settingsSummary && health.length}<p>{urgent.length ? m['live.phone.healthRestartParts']({parts:urgent.map(part=>m[`live.phone.part.${part.part}`]()).join(', ')}) : ''}{#if health.length > urgent.length}{urgent.length ? ' · ' : ''}{health.length - urgent.length === 1 ? m['live.phone.healthWaitOne']() : m['live.phone.healthWaitMany']({count:health.length-urgent.length})}{/if}</p>{/if}
		{#if urgent.length}<p class="health-line">
				{m[carrying === 'streaming' ? (way === 'moblin' ? 'live.phone.healthMoblin' : 'live.phone.healthActive') : 'live.phone.healthReady']({
					parts: urgent.map((part) => m[`live.phone.part.${part.part}`]()).join(', '),
					links:
						links
							.filter((l) => l.internet === 'yes')
							.map((l) => l.label)
							.join(', ') || m['live.phone.noneWorking'](),
				})}
			</p>
		{/if}
		{#if health.length}<details>
			<summary>{m['live.phone.details']()}</summary>{#each health as part (part.part)}<p>
					{m[`live.phone.${part.part}`]()} <time>{new Date(part.since).toLocaleTimeString()}</time>
				</p>{/each}
		</details>{/if}
		{#if !health.length}<p>{m['live.phone.healthOk']()}</p>{/if}
	{/if}
	<p>{m['live.phone.restartCost']()}</p>
	<button type="button" disabled={!reachable || state !== 'ready'} onclick={onrestart}
		>{m['live.phone.restart']()}</button
	>{#if state !== 'ready'}<p>{carrying === 'streaming' ? m['live.phone.restartHold']() : m['live.phone.restartChecking']()}</p>{/if}
</section>

<style>
	section {
		border: 1px solid var(--border);
		border-radius: 1rem;
		padding: 1.25rem;
		margin-bottom: 1rem;
		overflow-wrap: anywhere;
	}
	h2 {
		font-weight: 600;
		margin-bottom: 0.75rem;
	}
	p {
		margin: 0.75rem 0;
		color: var(--muted-foreground);
		line-height: 1.6;
	}
	.health-line {
		color: var(--status-warning);
	}
	button {
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		padding: 0.65rem 0.9rem;
		min-height: 44px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button:focus-visible {
		outline: 2px solid var(--primary);
	}
</style>
