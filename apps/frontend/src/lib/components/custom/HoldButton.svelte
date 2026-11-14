<!--
  HoldButton.svelte — a button that acts only after it is held.

  Pointer: press and hold for `holdMs`; releasing early, moving off or a cancel
  stops it. Keyboard: hold Enter or Space for the same time. A plain click or a
  short tap does nothing except show `hint` in a polite live region, so an
  accidental tap in a pocket or backpack never acts.

  Long press is never the only way in: the caller must also offer a plain
  button for the same action (see PowerDialog's "Restart without holding"), and
  `hint` names it, so screen-reader and switch users have an equivalent.
-->
<script lang="ts">
import { onDestroy } from 'svelte';

import { cn } from '$lib/utils';

interface Props {
	label: string;
	holdingLabel: string;
	hint: string;
	onhold: () => void;
	holdMs?: number;
	disabled?: boolean;
	describedby?: string;
	class?: string;
}

let {
	label,
	holdingLabel,
	hint,
	onhold,
	holdMs = 1000,
	disabled = false,
	describedby,
	class: className,
}: Props = $props();

let holding = $state(false);
let showHint = $state(false);
let timer: ReturnType<typeof setTimeout> | null = null;
const uid = $props.id();
const hintId = `hold-hint-${uid}`;
// Set when the hold fired, so the click that follows the release is ignored.
let fired = false;

function start() {
	if (disabled || holding) return;
	holding = true;
	fired = false;
	showHint = false;
	timer = setTimeout(() => {
		timer = null;
		holding = false;
		fired = true;
		onhold();
	}, holdMs);
}

function stop() {
	if (timer === null) return;
	clearTimeout(timer);
	timer = null;
	holding = false;
	showHint = true;
}

function onpointerdown(event: PointerEvent) {
	if (event.button !== 0) return;
	(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
	start();
}

function onkeydown(event: KeyboardEvent) {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	if (!event.repeat) start();
}

function onkeyup(event: KeyboardEvent) {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	stop();
}

function onclick(event: MouseEvent) {
	// The action runs from the timer only. A click that arrives without a hold
	// (assistive technology, a short tap) explains the alternative instead.
	event.preventDefault();
	if (fired) fired = false;
	else if (timer === null) showHint = true;
}

onDestroy(() => {
	if (timer !== null) clearTimeout(timer);
});
</script>

<button
	aria-describedby={[describedby, hintId].filter(Boolean).join(' ')}
	class={cn(
		'hold-button border-border bg-background relative inline-flex min-h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-lg border px-3 text-sm font-medium select-none',
		'focus-visible:ring-ring/50 outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50',
		className,
	)}
	data-holding={holding ? 'true' : 'false'}
	{disabled}
	onblur={stop}
	{onclick}
	oncontextmenu={(event) => event.preventDefault()}
	{onkeydown}
	{onkeyup}
	{onpointerdown}
	onpointercancel={stop}
	onpointerleave={stop}
	onpointerup={stop}
	style:--hold-ms={`${holdMs}ms`}
	type="button"
>
	<span aria-hidden="true" class="hold-fill bg-destructive/15 absolute inset-y-0 start-0"></span>
	<span class="relative">{holding ? holdingLabel : label}</span>
</button>
<p aria-live="polite" class="text-muted-foreground mt-2 text-xs" id={hintId}>
	{showHint ? hint : ''}
</p>

<style>
	.hold-button {
		touch-action: manipulation;
		-webkit-touch-callout: none;
	}
	.hold-fill {
		width: 0;
	}
	.hold-button[data-holding='true'] .hold-fill {
		width: 100%;
		transition: width var(--hold-ms) linear;
	}
	@media (prefers-reduced-motion: reduce) {
		.hold-button[data-holding='true'] .hold-fill {
			transition: none;
		}
	}
</style>
