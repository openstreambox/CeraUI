<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';

let { id, value, configured = false, disabled = false, onChange }: { id: string; value: string; configured?: boolean | undefined; disabled?: boolean; onChange: (value: string) => void } = $props();
let revealed = $state(false);
let clearing = $state(false);
</script>
<div class="space-y-2">
 <Label for={id}>{m["settings.srtStreamId"]()}</Label>
 <p id={`${id}-help`} class="text-muted-foreground text-sm">{m["settings.streamIdSecurity"]()}</p>
 {#if clearing}<p role="status" class="text-muted-foreground text-sm">{m["settings.streamIdClearing"]()}</p>{:else if configured}<p role="status" class="text-muted-foreground text-sm">{m["settings.streamIdStored"]()}</p>{/if}
 <Input {id} {disabled} type={revealed ? 'text' : 'password'} autocomplete="new-password" spellcheck={false} aria-describedby={`${id}-help`} {value} oninput={(e) => { clearing = false; onChange(e.currentTarget.value); }} />
 <Button type="button" variant="outline" {disabled} aria-controls={id} aria-pressed={revealed} onclick={() => (revealed = !revealed)}>{revealed ? m["settings.streamIdHide"]() : m["settings.streamIdShow"]()}</Button>
 <Button type="button" variant="outline" {disabled} onclick={() => { revealed = false; clearing = true; onChange(''); }}>{m["settings.streamIdClear"]()}</Button>
</div>
