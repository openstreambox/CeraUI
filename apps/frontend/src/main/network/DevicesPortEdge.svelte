<!--
  ROCK 5B+ port edge, seen from the port side. Socket colour follows the row state.
  The contact bars stay inside the drawing. The names are HTML, so their size
  does not shrink with the outline and they cannot sit on the bars.
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

function captionClass(tone: EdgeTone): string {
	if (tone === 'on') return 'text-status-success';
	if (tone === 'warn') return 'text-status-warning';
	if (tone === 'rest') return 'text-status-info';
	return 'text-muted-foreground';
}
</script>

<section class="bg-card rounded-xl border p-4" data-testid="devices-where">
	<h2 class="text-sm font-semibold tracking-tight">{m['network.devices.where']()}</h2>
	<svg
		class="mt-2 h-auto w-full"
		viewBox="128 34 162 72"
		role="img"
		aria-label={m['network.devices.whereAria']()}
	>
		<rect x="24" y="90" width="260" height="3" rx="1" fill="var(--border)" />
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
		<rect x="148" y="56" width="15" height="3" fill="var(--muted)" />
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
		<rect x="148" y="79" width="15" height="3" fill="var(--muted)" />

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
		<rect x="203" y="56" width="15" height="3" fill="var(--status-info)" />
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
		<rect x="203" y="79" width="15" height="3" fill="var(--status-info)" />

		<rect x="240.4" y="40" width="46.8" height="50" rx="2" fill="none" stroke="var(--border)" />
	</svg>
	<div class="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-3 text-sm leading-5">
		<div class="text-center">
			<p class="font-semibold">USB 2</p>
			<p class="font-medium break-words {captionClass(marks['A2-top'].tone)}">{marks['A2-top'].caption}</p>
			<p class="font-medium break-words {captionClass(marks['A2-bot'].tone)}">{marks['A2-bot'].caption}</p>
		</div>
		<div class="text-center">
			<p class="font-semibold">USB 3</p>
			<p class="font-medium break-words {captionClass(marks['A3-top'].tone)}">{marks['A3-top'].caption}</p>
			<p class="font-medium break-words {captionClass(marks['A3-bot'].tone)}">{marks['A3-bot'].caption}</p>
		</div>
		<p class="text-muted-foreground text-sm">Ethernet</p>
	</div>
	<p class="text-muted-foreground mt-2 text-sm leading-5">
		{m['network.devices.whereHdmi']()}
	</p>
	<p class="text-muted-foreground mt-2 text-xs">
		{alert ? m['network.devices.whereCaptionAlert']() : m['network.devices.whereCaption']()}
	</p>
</section>
