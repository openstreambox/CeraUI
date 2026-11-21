<!--
  HotspotDialogTargetStub.svelte — stands in for HotspotDialog and reports the
  target the parent handed it, so a view test can assert dialog binding.
-->
<script lang="ts">
import type { WifiInterface } from '@ceraui/rpc/schemas';

let {
	open = $bindable(false),
	deviceId,
	iface,
}: { open?: boolean; deviceId: string; iface?: WifiInterface } = $props();
</script>

{#if open}
	<div
		data-testid="hotspot-dialog-stub"
		data-device={deviceId}
		data-incarnation={iface?.incarnation ?? ''}
	></div>
{/if}
