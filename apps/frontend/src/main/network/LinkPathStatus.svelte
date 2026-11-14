<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { LinkPathStatus } from '@ceraui/rpc/schemas';

let { status = 'unknown', stale = false }: { status?: LinkPathStatus | undefined; stale?: boolean } = $props();
const state = $derived(stale && status !== 'unknown' ? 'stale' : status);
</script>

<details class="text-muted-foreground basis-full text-xs" data-testid="link-path-status">
	<summary class="cursor-pointer min-h-[var(--touch-target-min)] py-1">
		{m[`network.path.${state}`]()} <span class="ms-2 whitespace-nowrap underline underline-offset-2">{m["network.path.why"]()}</span>
	</summary>
	<p class="pb-2 leading-relaxed">{m[`network.path.${state}Why`]()}</p>
</details>
