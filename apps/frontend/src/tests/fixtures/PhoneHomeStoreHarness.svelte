<script lang="ts">
import { getStatus } from '$lib/rpc/subscriptions.svelte';
import PhoneHome from '../../main/PhoneHome.svelte';
</script>
<PhoneHome carrying={getStatus()?.carrying?.state} />
