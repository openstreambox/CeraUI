<script lang="ts">
let { open = false }: { open?: boolean; [key: string]: unknown } = $props();
</script>

{#if open}<div data-testid="server-dialog-open"></div>{/if}
