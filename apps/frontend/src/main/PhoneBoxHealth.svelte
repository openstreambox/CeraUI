<script lang="ts">
	import { m } from '@ceraui/i18n/svelte';
	import type { StatusResponse } from '@ceraui/rpc/schemas';

	let {
		reachable = true,
		health = [],
		links = [],
		carrying,
		onrestart,
	}: {
		reachable?: boolean;
		health?: NonNullable<StatusResponse['box_health']>;
		links?: { label: string; internet: string }[];
		carrying?: 'streaming' | 'idle' | 'unknown';
		onrestart?: () => void;
	} = $props();
	const state = $derived(carrying === 'idle' ? 'ready' : 'protected');
</script>

<section>
	<h2>{m['live.phone.health']()}</h2>
	{#if !reachable}<p>{m['live.phone.remoteUnreachable']()}</p>{:else}
		{#if health.length}<p class="health-line">
				{m['live.phone.healthSummary']({
					parts: health.map((part) => m[`live.phone.part.${part.part}`]()).join(', '),
					links:
						links
							.filter((l) => l.internet === 'yes')
							.map((l) => l.label)
							.join(', ') || m['live.phone.noneWorking'](),
				})}
			</p>
		{/if}
		<details>
			<summary>{m['live.phone.details']()}</summary>{#each health as part (part.part)}<p>
					{m[`live.phone.${part.part}`]()} <time>{new Date(part.since).toLocaleTimeString()}</time>
				</p>{/each}
			<p>{m['live.phone.restartCost']()}</p>
		</details>
		{#if !health.length}<p>{m['live.phone.healthOk']()}</p>{/if}
	{/if}
	<button type="button" disabled={!reachable || state !== 'ready'} onclick={onrestart}
		>{m['live.phone.restart']()}</button
	>{#if state !== 'ready'}<p>{m['live.phone.restartHold']()}</p>{/if}
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
