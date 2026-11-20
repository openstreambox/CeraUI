<!--
  LiveCockpitStub.svelte — inert stand-in for LiveCockpit in the LiveView
  cockpit-switch tests. Ignores every prop except `summaryMode`, which it mirrors
  onto `data-summary-mode` so the post-stream summary-window test can assert the
  cockpit is held in summary-only mode after a stop, and `bitrateDraft`, mirrored
  onto `data-bitrate-draft` — the real BitrateAdjuster is purely presentational,
  so the value LiveView threads down IS the value the operator sees. `restarting`
  is mirrored onto `data-restarting` for the connection-restart test.
-->
<script lang="ts">
const props: { summaryMode?: boolean; bitrateDraft?: number; restarting?: boolean } = $props();
</script>

<div
	data-testid="live-cockpit"
	data-summary-mode={props.summaryMode ? 'true' : 'false'}
	data-bitrate-draft={props.bitrateDraft}
	data-restarting={props.restarting ? 'true' : 'false'}
></div>
