<!--
  RadioHealthPanel.svelte: read-only radio readout inside a cellular row's
  Details. Status first (a chip with its own icon and word, one short line, the
  next step if there is one), then registration and network. Signal stays on the
  row; the measured values are in the dialog. The whole card opens
  every raw reading, the other modems and the recent history in a dialog. The
  only control is the optional Restart modem button the row passes in for a
  "no data" finding; the panel itself never acts on the modem.
-->
<script lang="ts">
import { m } from '@ceraui/i18n/svelte';
import type { RadioHealth, RadioMetric } from '@ceraui/rpc/schemas';
import {
	ArrowRight,
	ChevronRight,
	CircleCheck,
	CircleHelp,
	CircleOff,
	CircleX,
	RadioTower,
	Search,
	SignalHigh,
	SignalLow,
	SignalMedium,
	TriangleAlert,
} from '@lucide/svelte';
import type { Snippet } from 'svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import AppDialog from '$lib/components/dialogs/AppDialog.svelte';
import { cn } from '$lib/utils';

import {
	bandLabel,
	formatValue,
	metricLabel,
	networkType,
	RADIO_STATUS_TONE,
	type RadioStatusKind,
	type RadioTone,
	radioStatus,
	registrationWord,
	type SignalLevel,
	secondsToNextReading,
	signalReadings,
} from './radio-health-view';

let {
	radio,
	id,
	network,
	noSim = false,
	connected = false,
	modemName = (other: string) => m['network.radio.neighbour']({ id: other }),
	restartAction,
	restartSeconds,
}: {
	radio: RadioHealth;
	id: string;
	/** The carrier name, when the row knows it. */
	network?: string | undefined;
	noSim?: boolean;
	/** The row reports a data connection (bearer up). */
	connected?: boolean;
	/** How the cellular section names another modem's row. */
	modemName?: (id: string) => string;
	/**
	 * The row's Restart modem button, passed only for a model with a qualified
	 * software restart. With it, a "no data" finding suggests restarting instead
	 * of replugging and shows the button under the next step.
	 */
	restartAction?: Snippet | undefined;
	/** How long the restart takes this model, for the next-step wording. */
	restartSeconds?: number | undefined;
} = $props();

const headingId = $derived(`radio-health-${id}`);
let detailsOpen = $state(false);

// A one-second clock, running only while a countdown or the dialog is shown.
let now = $state(Date.now());
$effect(() => {
	if (status !== 'unchecked' && !detailsOpen) return;
	now = Date.now();
	const timer = setInterval(() => {
		now = Date.now();
	}, 1000);
	return () => clearInterval(timer);
});
const nextIn = $derived(secondsToNextReading(radio.capturedAt, now));
const nextText = $derived(
	nextIn === null
		? m['network.radio.next.unchecked']()
		: nextIn === 0
			? m['network.radio.next.checking']()
			: m['network.radio.next.countdown']({ seconds: String(nextIn) }),
);
const status = $derived<RadioStatusKind>(radioStatus(radio, { noSim, connected }));
const tone = $derived(RADIO_STATUS_TONE[status]);
// Solid token pairs: the tinted status pill measures below 4.5:1 for these
// tones on the panel. Dark red takes the dark page colour for the same reason.
const CHIP_CLASS: Record<RadioTone, string> = {
	success: 'bg-status-success text-status-success-foreground',
	warning: 'bg-status-warning text-status-warning-foreground',
	error: 'bg-status-error text-status-error-foreground dark:text-background',
	neutral: 'bg-status-neutral text-status-neutral-foreground',
};

const STATUS_ICON = {
	ok: CircleCheck,
	registered: RadioTower,
	'sim-account': CircleX,
	'data-path': CircleX,
	disturbed: TriangleAlert,
	'no-sim': CircleOff,
	'not-registered': Search,
	unchecked: CircleHelp,
} satisfies Record<RadioStatusKind, unknown>;
const StatusIcon = $derived(STATUS_ICON[status]);

const chip = $derived(
	{
		ok: m['network.radio.chip.ok'](),
		registered: m['network.radio.chip.registered'](),
		'sim-account': m['network.radio.chip.simRefused'](),
		'data-path': m['network.radio.chip.noData'](),
		disturbed: m['network.radio.chip.interference'](),
		'no-sim': m['network.radio.chip.noSim'](),
		'not-registered': m['network.radio.chip.notRegistered'](),
		unchecked: m['network.radio.chip.unchecked'](),
	}[status],
);

const reg = $derived(registrationWord(radio.registration.value));

const line = $derived.by(() => {
	switch (status) {
		case 'ok':
			return m['network.radio.line.ok']();
		case 'registered':
			return reg === 'sms-only'
				? m['network.radio.line.smsOnly']()
				: connected
					? m['network.radio.line.registeredConnected']()
					: m['network.radio.line.registered']();
		case 'sim-account':
			return network
				? m['network.radio.line.sim']({ network })
				: m['network.radio.line.simUnnamed']();
		case 'data-path':
			return m['network.radio.line.data']();
		case 'disturbed':
			return m['network.radio.line.disturbed']({
				neighbour: radio.finding.neighbour
					? modemName(radio.finding.neighbour)
					: m['network.radio.anotherModem'](),
			});
		case 'no-sim':
			return m['network.radio.line.noSim']();
		case 'not-registered':
			return reg === 'searching'
				? m['network.radio.line.searching']()
				: reg === 'denied'
					? m['network.radio.line.denied']()
					: m['network.radio.line.idle']();
		case 'unchecked':
			return m['network.radio.line.unchecked']();
	}
});

const next = $derived.by(() => {
	switch (status) {
		case 'sim-account':
			return m['network.radio.next.sim']();
		case 'data-path':
			return restartAction && restartSeconds !== undefined
				? m['network.radio.next.restart']({ seconds: String(restartSeconds) })
				: m['network.radio.next.data']();
		case 'disturbed':
			return m['network.radio.next.disturbed']();
		case 'no-sim':
			return m['network.radio.next.noSim']();
		case 'unchecked':
			return nextText;
		default:
			return undefined;
	}
});

const REG_LABEL = $derived<Record<string, string>>({
	home: m['network.radio.reg.home'](),
	roaming: m['network.radio.reg.roaming'](),
	registered: m['network.radio.reg.registered'](),
	'sms-only': m['network.radio.reg.smsOnly'](),
	searching: m['network.radio.reg.searching'](),
	idle: m['network.radio.reg.idle'](),
	denied: m['network.radio.reg.denied'](),
});
const registrationText = $derived(
	radio.registration.value === null
		? null
		: (REG_LABEL[reg] ?? String(radio.registration.value)),
);

const networkText = $derived(
	[networkType(radio.layer.value), bandLabel(radio.band.value)]
		.filter((part): part is string => part !== null && part !== '')
		.join(' · ') || null,
);



const signals = $derived(signalReadings(radio));
const SIGNAL_ICON = {
	high: SignalHigh,
	medium: SignalMedium,
	low: SignalLow,
} satisfies Record<SignalLevel, unknown>;
const SIGNAL_COLOR: Record<SignalLevel, string> = {
	high: 'text-signal-good',
	medium: 'text-signal-fair',
	low: 'text-signal-weak',
};
const levelWord = (level: SignalLevel) =>
	({
		high: m['network.radio.level.high'](),
		medium: m['network.radio.level.medium'](),
		low: m['network.radio.level.low'](),
	})[level];

const time = (at: number) =>
	at > 0
		? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
		: null;

const unavailable = $derived(m['network.radio.unavailable']());
const readingRows = $derived<[string, RadioMetric][]>([
	[m['network.radio.registration'](), radio.registration],
	[m['network.radio.networkType'](), radio.layer],
	[m['network.radio.band'](), radio.band],
	...Object.entries(radio.metrics)
		// An empty generic slot says nothing once a layer reports the same metric.
		.filter(
			([key, metric]) =>
				metric.value !== null ||
				key.includes('.') ||
				!Object.entries(radio.metrics).some(
					([other, reading]) => other.endsWith(`.${key}`) && reading.value !== null,
				),
		)
		.map(
			([key, metric]) =>
				[
					key === 'servingCell' ? m['network.radio.servingCell']() : metricLabel(key),
					metric,
				] as [string, RadioMetric],
		),
]);

const FINDING_CHIP = $derived<Record<string, string>>({
	'sim-account': m['network.radio.chip.simRefused'](),
	'data-path': m['network.radio.chip.noData'](),
	disturbed: m['network.radio.chip.interference'](),
	unknown: m['network.radio.chip.noFinding'](),
});

type HistoryRow = { at: number; text: string; detail: string };
const history = $derived<HistoryRow[]>(
	[
		...radio.usb.events.map((event) => ({
			at: event.at,
			text:
				event.kind === 'reset'
					? m['network.radio.usbEvent.reset']()
					: m['network.radio.usbEvent.disconnect'](),
			detail: '',
		})),
		...radio.timeline.map((event) => ({
			at: event.at,
			text: FINDING_CHIP[event.finding.kind] ?? event.finding.kind,
			// The evidence tokens stay: they are what supported a finding.
			detail: [
				...(event.observation
					? [
							bandLabel(event.observation.band.value),
							formatValue(event.observation.rsrp),
							formatValue(event.observation.quality),
						]
					: []),
				...event.finding.evidence,
			]
				.filter(Boolean)
				.join(' · '),
		})),
	].sort((a, b) => b.at - a.at),
);
</script>

<section
	aria-labelledby={headingId}
	class="hover:bg-muted/50 relative space-y-2 rounded-lg border p-3 text-xs transition-colors"
	data-testid="radio-health"
	data-status={status}
>
	<!-- The chip and line already say what this block is inside a modem's
	     Details, so the heading is for screen readers only. -->
	<h3 id={headingId} class="sr-only">{m['network.radio.title']()}</h3>
	<div class="space-y-1 pe-5">
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
			<Badge
				variant={tone}
				class={CHIP_CLASS[tone]}
				data-testid="radio-health-status"
				data-tone={tone}
			>
				<StatusIcon class="size-3.5" aria-hidden="true" />
				{chip}
			</Badge>
			<p class="text-sm font-medium leading-snug" data-testid="radio-health-summary">{line}</p>
		</div>
		{#if next}
			<p class="text-muted-foreground flex items-start gap-1.5 leading-snug tabular-nums" data-testid="radio-health-next">
				<ArrowRight class="mt-0.5 size-3.5 shrink-0 rtl:rotate-180" aria-hidden="true" />
				<span><span class="sr-only">{m['network.radio.nextStep']()}: </span>{next}</span>
			</p>
		{/if}
		{#if status === 'data-path' && restartAction}
			<!-- Above the stretched card button, so a click restarts rather than
			     opening the readings. -->
			<div class="relative z-10 pt-1" data-testid="radio-health-restart">
				{@render restartAction()}
			</div>
		{/if}
	</div>
	<ChevronRight
		aria-hidden="true"
		class="text-muted-foreground absolute end-3 top-3.5 size-4 rtl:rotate-180"
	/>

	{#if status !== 'no-sim'}
		<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="radio-health-readings">
			<dt class="text-muted-foreground">{m['network.radio.registration']()}</dt>
			<dd class={cn('min-w-0', registrationText === null && 'text-muted-foreground')}>
				{registrationText ?? unavailable}
			</dd>

			<dt class="text-muted-foreground">{m['network.radio.network']()}</dt>
			<dd class={cn('min-w-0', networkText === null && 'text-muted-foreground')}>
				{#if networkText === null}{unavailable}{:else}<span dir="ltr">{networkText}</span>{/if}
			</dd>

			{#if radio.usb.available && radio.usb.events.length > 0}
				<dt class="text-muted-foreground">{m['network.radio.usb']()}</dt>
				<dd class="min-w-0 tabular-nums" data-testid="radio-health-usb">{radio.usb.events.length}</dd>
			{/if}
		</dl>
	{/if}

	<!-- One button stretched over the card: the whole card opens the readings,
	     while the markup inside stays plain text rather than button content. -->
	<button
		type="button"
		class="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-lg focus-visible:ring-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent"
		aria-haspopup="dialog"
		aria-label={m['network.radio.showDetails']({ modem: modemName(id) })}
		data-testid="radio-health-open"
		onclick={() => (detailsOpen = true)}
	></button>
</section>

<AppDialog
	bind:open={detailsOpen}
	title={m['network.radio.title']()}
	description={modemName(id)}
	hideFooter
>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (This read-only scroll region needs keyboard focus; Close is the dialog's only other tab stop.) -->
	<!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this named read-only region to scroll the dialog body. -->
	<section tabindex="0"
		class="space-y-4 rounded-md text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
		data-testid="radio-health-details"
		aria-label={m['network.radio.readingsRegion']()}
	>
		{#if radio.capturedAt > 0}
			<p class="text-muted-foreground tabular-nums" data-testid="radio-health-timing">
				{m['network.radio.lastReading']({ time: time(radio.capturedAt) ?? '' })}{' · '}{nextText}
			</p>
		{/if}
		<div class="space-y-1">
			<h4 class="text-sm font-medium">{m['network.radio.signal']()}</h4>
			{#if signals.length === 0}
				<p class="text-muted-foreground">{unavailable}</p>
			{:else}
				<ul class="space-y-1" data-testid="radio-health-signal">
					{#each signals as reading (reading.tech)}
						{const Icon = $derived(SIGNAL_ICON[reading.level])}
						<li class="flex items-center gap-2" data-signal-level={reading.level}>
							<Icon class={cn('size-4 shrink-0', SIGNAL_COLOR[reading.level])} aria-hidden="true" />
							<span class="font-mono text-sm tabular-nums" dir="ltr">{reading.dbm} dBm</span>
							<span>{levelWord(reading.level)}</span>
							<span class="text-muted-foreground"
								>RSRP{#if reading.tech !== 'other'}{' · '}{reading.tech === 'nr' ? '5G' : 'LTE'}{/if}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<div class="space-y-1">
			<h4 class="text-sm font-medium">{m['network.radio.readings']()}</h4>
			<dl class="divide-y" data-testid="radio-health-raw">
				{#each readingRows as [name, metric] (name)}
					{const shown = $derived(formatValue(metric))}
					{const at = $derived(time(metric.capturedAt))}
					<div class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 py-1">
						<dt class="text-muted-foreground">{name}</dt>
						<dd class="min-w-0">
							{#if shown === null}
								<span class="text-muted-foreground">{unavailable}</span>
							{:else}
								<span class="font-mono tabular-nums" dir="ltr">{shown}</span>
							{/if}
							{#if shown !== null || metric.source !== 'not-observed'}
								<span class="text-muted-foreground block break-words text-(length:--text-micro)" dir="ltr">
									{metric.source}{#if at && shown !== null}{' · '}{at}{/if}
								</span>
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		</div>
		{#if radio.neighbours.length > 0}
			<div class="space-y-1">
				<h4 class="text-sm font-medium">{m['network.radio.otherModems']()}</h4>
				<dl class="divide-y" data-testid="radio-health-neighbours">
					{#each radio.neighbours as neighbour (neighbour.id)}
						{const band = $derived(formatValue(neighbour.band))}
						{const at = $derived(time(neighbour.capturedAt))}
						<div class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 py-1">
							<dt class="text-muted-foreground">{modemName(neighbour.id)}</dt>
							<dd class="min-w-0">
								{neighbour.transmitting === 'yes'
									? m['network.radio.sending']()
									: m['network.radio.unknownValue']()}{' · '}{#if band === null}<span
										class="text-muted-foreground">{unavailable}</span
									>{:else}<span class="font-mono" dir="ltr">{bandLabel(band)}</span>{/if}
								<span class="text-muted-foreground block break-words text-(length:--text-micro)" dir="ltr">
									{neighbour.source}{#if at}{' · '}{at}{/if}
								</span>
							</dd>
						</div>
					{/each}
				</dl>
			</div>
		{/if}
		<div class="space-y-1">
			<h4 class="text-sm font-medium">{m['network.radio.history']()}</h4>
			{#if history.length === 0}
				<p class="text-muted-foreground">{m['network.radio.historyEmpty']()}</p>
			{:else}
				<ol class="space-y-0.5" data-testid="radio-health-history">
					{#each history as row, index (`${row.at}-${index}`)}
						<li class="grid grid-cols-[auto_1fr] gap-x-3">
							<span class="text-muted-foreground font-mono tabular-nums" dir="ltr">{time(row.at)}</span>
							<span class="min-w-0">
								{row.text}{#if row.detail}<span class="text-muted-foreground block font-mono break-words" dir="ltr"
										>{row.detail}</span
									>{/if}
							</span>
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	</section>
</AppDialog>
