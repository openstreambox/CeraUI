<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { toast } from 'svelte-sonner';
import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import { loadWithinBound } from '$lib/modem/async-surface';
import { rpc } from '$lib/rpc';

let { token }: { token: string } = $props();

async function clearRecord() {
	const result = await loadWithinBound('clearUnreadableRecord', () =>
		rpc.modems.clearUnreadableRecord({ token, confirm: true }),
	);
	if (result.phase !== 'loaded' || !result.value.success)
		toast.warning(m["notifications.modemRecoveryCheck"]());
}
</script>

<SimpleAlertDialog
	buttonText={m["notifications.modemRecoveryReview"]()}
	extraButtonClasses="mt-2 me-2 h-8 px-3 text-xs"
	confirmButtonText={m["notifications.modemRecoveryClear"]()}
	confirmVariant="destructive"
	onconfirm={clearRecord}
>
	{#snippet dialogTitle()}{m["notifications.modemRecoveryClear"]()}{/snippet}
	{#snippet description()}{m["notifications.modemRecoveryConfirm"]()}{/snippet}
</SimpleAlertDialog>
