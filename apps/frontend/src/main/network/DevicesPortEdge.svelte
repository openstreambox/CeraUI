<!--
  ROCK 5B+ port edge, seen from the port side. Socket colour follows the row state.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

export type EdgeTone = 'on' | 'rest' | 'warn' | 'empty' | 'off';

interface Mark {
	tone: EdgeTone;
	caption: string;
}

interface Props {
	marks: {
		'A2-top': Mark;
		'A2-bot': Mark;
		'A3-top': Mark;
		'A3-bot': Mark;
	};
	alert: boolean;
}

const { marks, alert }: Props = $props();

function stroke(tone: EdgeTone): string {
	if (tone === 'on') return 'var(--status-success)';
	if (tone === 'rest') return 'var(--status-info)';
	if (tone === 'warn') return 'var(--status-warning)';
	if (tone === 'off') return 'var(--status-neutral)';
	return 'var(--border)';
}

function dash(tone: EdgeTone): string | undefined {
	return tone === 'empty' || tone === 'off' ? '2 2' : undefined;
}
</script>

<section class="bg-card rounded-xl border p-4" data-testid="devices-where">
	<h2 class="text-sm font-semibold tracking-tight">{m['network.devices.where']()}</h2>
	<svg
		class="mt-2 h-auto w-full"
		viewBox="128 22 166 88"
		role="img"
		aria-label={m['network.devices.whereAria']()}
	>
		<rect x="135.4" y="38" width="40" height="52" rx="2" fill="var(--muted)" stroke="var(--border)" />
		<rect
			x="140"
			y="43"
			width="31"
			height="19"
			rx="1.5"
			fill="var(--background)"
			stroke={stroke(marks['A2-top'].tone)}
			stroke-width="1.6"
			stroke-dasharray={dash(marks['A2-top'].tone)}
		/>
		<text x="155.5" y="55" text-anchor="middle" fill={stroke(marks['A2-top'].tone)} font-size="6">
			{marks['A2-top'].caption}
		</text>
		<rect
			x="140"
			y="66"
			width="31"
			height="19"
			rx="1.5"
			fill="var(--background)"
			stroke={stroke(marks['A2-bot'].tone)}
			stroke-width="1.6"
			stroke-dasharray={dash(marks['A2-bot'].tone)}
		/>
		<text x="155.5" y="78" text-anchor="middle" fill="var(--muted-foreground)" font-size="6">
			{marks['A2-bot'].caption}
		</text>
		<text x="155.4" y="32" text-anchor="middle" fill="var(--foreground)" font-size="7">USB 2</text>

		<rect x="191.4" y="38" width="38.4" height="52" rx="2" fill="var(--muted)" stroke="var(--border)" />
		<rect
			x="195.5"
			y="43"
			width="30"
			height="19"
			rx="1.5"
			fill="var(--background)"
			stroke={stroke(marks['A3-top'].tone)}
			stroke-width="1.6"
		/>
		<text x="210.5" y="55" text-anchor="middle" fill={stroke(marks['A3-top'].tone)} font-size="6">
			{marks['A3-top'].caption}
		</text>
		<rect
			x="195.5"
			y="66"
			width="30"
			height="19"
			rx="1.5"
			fill="var(--background)"
			stroke={stroke(marks['A3-bot'].tone)}
			stroke-width="1.6"
		/>
		<text x="210.5" y="78" text-anchor="middle" fill={stroke(marks['A3-bot'].tone)} font-size="6">
			{marks['A3-bot'].caption}
		</text>
		<text x="210.6" y="32" text-anchor="middle" fill="var(--foreground)" font-size="7">USB 3</text>

		<rect x="240.4" y="40" width="46.8" height="50" rx="2" fill="none" stroke="var(--border)" />
		<text x="263.8" y="104" text-anchor="middle" fill="var(--muted-foreground)" font-size="6.5">Ethernet</text>
	</svg>
	<p class="text-muted-foreground mt-2 text-xs">
		{alert ? m['network.devices.whereCaptionAlert']() : m['network.devices.whereCaption']()}
	</p>
</section>
