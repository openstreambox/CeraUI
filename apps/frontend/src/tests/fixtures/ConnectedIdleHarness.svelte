<script lang="ts">
import BondedLinksSection from '$main/network/BondedLinksSection.svelte';
import { links, telemetry } from '$main/network/connected-idle-fixture';

let sample = $state({ ...telemetry(), lastReadMs: 0 });
let at = 0;
$effect(() => {
 const timer = setInterval(() => advance(), 5500);
 return () => clearInterval(timer);
});
function advance(bitrate = 0) {
	at += 5500;
	sample = { ...telemetry(bitrate), lastReadMs: at };
}
</script>
<button type="button" onclick={() => advance()}>Next quiet sample</button>
<button type="button" onclick={() => advance(100_000)}>Resume traffic</button>
<BondedLinksSection {links} modemEntries={[]} linkTelemetry={sample} isStreaming={true} />
