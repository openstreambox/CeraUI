<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import { DEFAULT_SRT_KEY_LENGTH, srtPassphraseSchema } from '@ceraui/rpc/schemas';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';

let { supported = false, disabled = false, onChange }: {
	supported?: boolean;
	disabled?: boolean;
	onChange: (passphrase: string, keyLength: 16 | 24 | 32) => void;
} = $props();
let passphrase = $state('');
let keyLength = $state<16 | 24 | 32>(DEFAULT_SRT_KEY_LENGTH);
let visible = $state(false);
const valid = $derived(srtPassphraseSchema.safeParse(passphrase).success);
</script>

{#if supported}
 <div class="space-y-2">
  <Label for="srt-output-passphrase">{m['settings.srtEncryptionPassphrase']()}</Label>
  <Input id="srt-output-passphrase" type={visible ? 'text' : 'password'}
   autocomplete="new-password" {disabled} bind:value={passphrase}
   aria-invalid={!valid} oninput={(event) => onChange(event.currentTarget.value, keyLength)} />
  <label><input type="checkbox" bind:checked={visible} {disabled} /> {m['settings.srtEncryptionShow']()}</label>
  <p class="text-muted-foreground text-sm">{m['settings.srtEncryptionHelp']()}</p>
  {#if !valid}<p role="alert">{m['settings.srtEncryptionInvalid']()}</p>{/if}
  <Label for="srt-output-key-length">{m['settings.srtEncryptionKeyLength']()}</Label>
  <select id="srt-output-key-length" bind:value={keyLength} {disabled}
   onchange={(event) => onChange(passphrase, Number(event.currentTarget.value) as 16 | 24 | 32)}>
   <option value={16}>AES-128</option><option value={24}>AES-192</option><option value={32}>AES-256</option>
  </select>
 </div>
{/if}
