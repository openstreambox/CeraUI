<!--
  RadioHealthPanel.svelte — read-only radio readout inside a cellular row's
  Details. Status first (a chip with its own icon and word, one short line, the
  next step if there is one), then a few compact readings, then every raw
  reading and the recent history behind a disclosure. No modem action controls.
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
	Search,
	SignalHigh,
	SignalLow,
	SignalMedium,
	TriangleAlert,
} from '@lucide/svelte';

import Badge from '$lib/components/custom/Badge.svelte';
import { cn } from '$lib/utils';

import {
	bandLabel,
	formatValue,
	metricLabel,
	networkType,
	RADIO_STATUS_TONE,
	type RadioStatusKind,
	radioStatus,
	registrationWord,
	type SignalLevel,
	signalReadings,
} from './radio-health-view';

let {
	radio,
	id,
	network,
	noSim = false,
	modemName = (other: string) => m['network.radio.neighbour']({ id: other }),
}: {
	radio: RadioHealth;
	id: string;
	/** The carrier name, when the row knows it. */
	network?: string | undefined;
	noSim?: boolean;
	/** How the cellular section names another modem's row. */
	modemName?: (id: string) => string;
} = $props();

const headingId = $derived(`radio-health-${id}`);
const status = $derived<RadioStatusKind>(radioStatus(radio, noSim));
const tone = $derived(RADIO_STATUS_TONE[status]);

const STATUS_ICON = {
	ok: CircleCheck,
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
			return m['network.radio.next.data']();
		case 'disturbed':
			return m['network.radio.next.disturbed']();
		case 'no-sim':
			return m['network.radio.next.noSim']();
		case 'unchecked':
			return m['network.radio.next.unchecked']();
		default:
			return undefined;
	}
});

const REG_LABEL = $derived<Record<string, string>>({
	home: m['network.radio.reg.home'](),
	roaming: m['network.radio.reg.roaming'](),
	registered: m['network.radio.reg.registered'](),
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

const sending = $derived(
	radio.neighbours.filter((n) => n.transmitting === 'yes').map((n) => modemName(n.id)),
);

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
			detail: event.observation
				? [
						bandLabel(event.observation.band.value),
						formatValue(event.observation.rsrp),
						formatValue(event.observation.quality),
					]
						.filter(Boolean)
						.join(' · ')
				: '',
		})),
	].sort((a, b) => b.at - a.at),
);
</script>

<section
	aria-labelledby={headingId}
	class="bg-muted/30 space-y-2.5 rounded-lg border p-3 text-xs"
	data-testid="radio-health"
	data-status={status}
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 id={headingId} class="text-xs font-semibold">{m['network.radio.title']()}</h3>
		<Badge variant={tone} data-testid="radio-health-status" data-tone={tone}>
			<StatusIcon class="size-3.5" aria-hidden="true" />
			{chip}
		</Badge>
	</div>

	<div class="space-y-1">
		<p class="text-sm font-medium leading-snug" data-testid="radio-health-summary">{line}</p>
		{#if next}
			<p class="text-muted-foreground flex items-start gap-1.5 leading-snug" data-testid="radio-health-next">
				<ArrowRight class="mt-0.5 size-3.5 shrink-0 rtl:rotate-180" aria-hidden="true" />
				<span><span class="sr-only">{m['network.radio.nextStep']()}: </span>{next}</span>
			</p>
		{/if}
	</div>

	{#if status !== 'no-sim'}
		<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 sm:max-w-2xl sm:grid-cols-[auto_1fr_auto_1fr]" data-testid="radio-health-readings">
			<dt class="text-muted-foreground">{m['network.radio.registration']()}</dt>
			<dd class={cn('min-w-0', registrationText === null && 'text-muted-foreground')}>
				{registrationText ?? unavailable}
			</dd>

			<dt class="text-muted-foreground">{m['network.radio.network']()}</dt>
			<dd class={cn('min-w-0', networkText === null && 'text-muted-foreground')} dir="ltr">
				{networkText ?? unavailable}
			</dd>

			<dt class="text-muted-foreground">{m['network.radio.signal']()}</dt>
			<dd class="min-w-0" data-testid="radio-health-signal">
				{#if signals.length === 0}
					<span class="text-muted-foreground">{unavailable}</span>
				{:else}
					<span class="flex flex-col gap-0.5">
						{#each signals as reading (reading.tech)}
							{const Icon = $derived(SIGNAL_ICON[reading.level])}
							<span class="inline-flex items-center gap-1.5" data-signal-level={reading.level}>
								<Icon class={cn('size-4 shrink-0', SIGNAL_COLOR[reading.level])} aria-hidden="true" />
								<span class="font-mono tabular-nums" dir="ltr">{reading.dbm} dBm</span>
								<span class="text-muted-foreground">
									{levelWord(reading.level)}{#if signals.length > 1}{' · '}{reading.tech === 'nr' ? '5G' : 'LTE'}{/if}
								</span>
							</span>
						{/each}
					</span>
				{/if}
			</dd>

			{#if radio.neighbours.length > 0}
				<dt class="text-muted-foreground">{m['network.radio.othersSending']()}</dt>
				<dd class={cn('min-w-0', sending.length === 0 && 'text-muted-foreground')}>
					{sending.length > 0 ? sending.join(', ') : m['network.radio.unknownValue']()}
				</dd>
			{/if}

			<dt class="text-muted-foreground">{m['network.radio.usb']()}</dt>
			<dd class={cn('min-w-0 tabular-nums', !radio.usb.available && 'text-muted-foreground')}>
				{#if !radio.usb.available}
					{unavailable}
				{:else if radio.usb.events.length === 0}
					{m['network.radio.usbNone']()}
				{:else}
					{radio.usb.events.length}
				{/if}
			</dd>
		</dl>
	{/if}

	<details class="group border-t pt-1.5" data-testid="radio-health-sources">
		<summary
			class="text-muted-foreground hover:text-foreground flex min-h-[var(--touch-target-min)] cursor-pointer list-none items-center gap-1.5 font-medium select-none [&::-webkit-details-marker]:hidden"
		>
			<ChevronRight
				aria-hidden="true"
				class="size-3.5 shrink-0 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:-rotate-90"
			/>
			{m['network.radio.sources']()}
		</summary>
		<div class="space-y-3 pt-1">
			<div class="space-y-1">
				<h4 class="font-medium">{m['network.radio.readings']()}</h4>
				<dl class="divide-y" data-testid="radio-health-raw">
					{#each readingRows as [name, metric] (name)}
						{const shown = $derived(formatValue(metric))}
						{const at = $derived(time(metric.capturedAt))}
						<div class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 py-1">
							<dt class="text-muted-foreground">{name}</dt>
							<dd class="min-w-0">
								<span class={cn(shown === null ? 'text-muted-foreground' : 'font-mono tabular-nums')} dir="ltr">
									{shown ?? unavailable}
								</span>
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
			<div class="space-y-1">
				<h4 class="font-medium">{m['network.radio.history']()}</h4>
				{#if history.length === 0}
					<p class="text-muted-foreground">{m['network.radio.historyEmpty']()}</p>
				{:else}
					<ol class="max-h-48 space-y-0.5 overflow-y-auto" data-testid="radio-health-history">
						{#each history as row, index (`${row.at}-${index}`)}
							<li class="grid grid-cols-[auto_1fr] gap-x-3">
								<span class="text-muted-foreground font-mono tabular-nums" dir="ltr">{time(row.at)}</span>
								<span class="min-w-0">
									{row.text}{#if row.detail}<span class="text-muted-foreground block font-mono sm:inline" dir="ltr"><span class="hidden sm:inline">{' · '}</span>{row.detail}</span>{/if}
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			</div>
		</div>
	</details>
</section>
