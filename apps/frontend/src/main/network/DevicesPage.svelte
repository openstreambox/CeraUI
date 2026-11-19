<!--
  Network › Devices. Read-only. One group per physical socket.
  An empty socket is rendered from presence, never from kind "other".
  States the reader cannot know yet (resting, off, retrying, unplugged)
  come from the development fixture and stay blank on a real tree.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { DeviceCalm, UsbDevicesWire, UsbEventWire } from '@ceraui/rpc/schemas';
import { ChevronRight, Copy, Info, Usb } from '@lucide/svelte';

import DevicesPortEdge, { type EdgeTone } from './DevicesPortEdge.svelte';
import { type DeviceRow, type DeviceRowState, devicesPageModel, devicesSummary } from './devices-model';

interface Props {
	wire: UsbDevicesWire | undefined;
	events?: readonly UsbEventWire[] | undefined;
	calm?: DeviceCalm | undefined;
	onBack: () => void;
}

const { wire, events = [], calm, onBack }: Props = $props();
const page = $derived(devicesPageModel(wire));
const summary = $derived(devicesSummary(wire, calm));

const LINK_COLOR = [
	'',
	'var(--link-1)',
	'var(--link-2)',
	'var(--link-3)',
	'var(--link-4)',
	'var(--link-5)',
	'var(--link-6)',
	'var(--link-6)',
	'var(--link-6)',
];

function kindLabel(row: DeviceRow): string {
	if (row.title) return row.title;
	if (row.kind === null) return '';
	if (row.kind === 'modem' && row.generation === '5g') return m['network.devices.kind.modem5g']();
	if (row.kind === 'modem' && row.generation === '4g') return m['network.devices.kind.modem4g']();
	return resolveMessageKey(`network.devices.kind.${row.kind}`);
}

function stateLabel(state: DeviceRowState): string {
	if (state === 'empty') return m['network.devices.state.empty']();
	if (state === 'unused') return m['network.devices.state.unused']();
	if (state === 'checking') return m['network.devices.state.checking']();
	if (state === 'resting') return m['network.devices.state.resting']();
	if (state === 'off') return m['network.devices.state.off']();
	if (state === 'unresponsive') return m['network.devices.state.unresponsive']();
	if (state === 'unplugged') return m['network.devices.state.unplugged']();
	return m['network.devices.state.on']();
}

function reason(row: DeviceRow): string {
	const key = row.reasonKey;
	if (key === 'in-bond') return m['network.devices.reason.inBond']();
	if (key === 'video-source') {
		return m['network.devices.reason.videoSource']({ name: row.sourceName ?? '' });
	}
	if (key === 'hub-own-power') return m['network.devices.reason.hubPower']();
	if (key === 'dropped') {
		return m['network.devices.reason.dropped']({
			time: row.clock ?? '',
			attempt: row.retry ?? 0,
			limit: row.retryMax ?? 0,
		});
	}
	if (key === 'resting-warm') return m['network.devices.reason.resting']();
	if (key === 'unused-heat') return m['network.devices.reason.unusedHeat']();
	if (key === 'unplugged-wifi') {
		return m['network.devices.reason.unpluggedWifi']({ minutes: row.minutesAgo ?? 0 });
	}
	if (key === 'turned-off') return m['network.devices.reason.turnedOff']({ time: row.clock ?? '' });
	if (key === 'bond-hotspot') return m['network.devices.reason.bondHotspot']();
	if (key === 'bond-venue') return m['network.devices.reason.bondVenue']();
	if (key === 'not-used' || row.state === 'unused') return m['network.devices.reason.unused']();
	if (row.state === 'empty' || row.state === 'unplugged') return '';
	if (row.kind === 'hub') return m['network.devices.reason.hub']();
	return m['network.devices.reason.on']();
}

function stateClass(state: DeviceRowState): string {
	if (state === 'on') return 'text-status-success';
	if (state === 'resting') return 'text-status-info';
	if (state === 'unresponsive') return 'text-status-error';
	if (state === 'off') return 'text-status-neutral';
	return 'text-muted-foreground';
}

function dotClass(state: DeviceRowState): string {
	if (state === 'on') return 'bg-status-success';
	if (state === 'resting') return 'bg-status-info';
	if (state === 'unresponsive') return 'bg-status-error';
	if (state === 'off') return 'border-status-neutral border bg-transparent';
	if (state === 'unplugged' || state === 'empty') return 'border-muted-foreground border border-dashed bg-transparent';
	return 'bg-muted-foreground';
}

function speedText(row: DeviceRow): string {
	if (row.hint === 'rm520-usb2') return m['network.devices.detail.speedUsb2Set']();
	if (row.speedClass === 'usb3') return m['network.devices.detail.speedUsb3']();
	if (row.speedClass === 'usb2') return 'USB 2';
	return row.speedClass;
}

function eventSentence(event: UsbEventWire): string {
	const kind = resolveMessageKey(`network.devices.kind.${event.kind}`);
	if (event.reason === 'left') return m['network.devices.events.unplugged']({ kind });
	if (event.reason === 'appeared') return m['network.devices.events.plugged']({ kind });
	if (event.reason === 'resting') {
		return m['network.devices.events.resting']({ kind, temp: event.tempC ?? 0 });
	}
	if (event.reason === 'retry') {
		return m['network.devices.events.retrySecond']({ slot: event.linkSlot ?? 0 });
	}
	if (event.reason === 'dropped') {
		return m['network.devices.events.droppedRetry']({ slot: event.linkSlot ?? 0 });
	}
	if (event.reason === 'turned-off') {
		const named = event.generation === '4g' ? m['network.devices.kind.modem4g']() : kind;
		return m['network.devices.events.turnedOff']({ kind: named });
	}
	if (event.reason === 'usb2') {
		return m['network.devices.events.usb2']({ slot: event.linkSlot ?? 0 });
	}
	return kind;
}

function eventClock(event: UsbEventWire): string {
	if (event.clock) return event.clock;
	return new Date(event.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function eventLine(event: UsbEventWire): string {
	return `${eventClock(event)} · ${eventSentence(event)} ${event.socketName}`;
}

async function copyEvents() {
	const text = events.map((event) => eventLine(event)).join('\n');
	if (text.length === 0 || navigator.clipboard === undefined) return;
	await navigator.clipboard.writeText(text);
}

function summaryLine(): string {
	if (summary === null) return '';
	const head =
		summary.hubs > 0
			? m['network.devices.summary.withHub']({ devices: summary.devices, ports: summary.ports })
			: summary.devices === 1 && summary.ports === 1
				? m['network.devices.summary.one']()
				: m['network.devices.summary.plain']({ devices: summary.devices, ports: summary.ports });
	const extra: string[] = [];
	if (summary.restingWifi) extra.push(m['network.devices.summary.restingWifi']());
	else if (summary.resting > 0) extra.push(m['network.devices.calm.restingMany']({ count: summary.resting }));
	if (summary.unresponsive > 0) extra.push(m['network.devices.summary.unresponsive']());
	return [head, ...extra].join(' ');
}

const openDetailsKey = $derived.by(() => {
	if (page.status !== 'ok') return null;
	for (const group of page.groups) {
		for (const row of group.rows) {
			if (row.hint === 'rm520-usb2') return row.key;
		}
	}
	return null;
});

const alert = $derived(
	page.status === 'ok' && page.groups.some((group) => group.rows.some((row) => row.state === 'unresponsive')),
);

function edgeCaption(kind: DeviceRow['kind']): string {
	if (kind === 'wifi') return m['network.devices.edge.wifi']();
	if (kind === 'capture') return m['network.devices.edge.capture']();
	if (kind === 'hub') return m['network.devices.edge.hub']();
	if (kind === 'modem') return m['network.devices.edge.modem']();
	return m['network.devices.edge.empty']();
}

function edgeTone(state: DeviceRowState | undefined): EdgeTone {
	if (state === 'unresponsive') return 'warn';
	if (state === 'resting') return 'rest';
	if (state === 'off') return 'off';
	if (state === 'on') return 'on';
	return 'empty';
}

function markFor(label: 'A2-top' | 'A2-bot' | 'A3-top' | 'A3-bot') {
	if (page.status !== 'ok') return { tone: 'empty' as const, caption: m['network.devices.edge.empty']() };
	const group = page.groups.find((item) => item.label === label);
	const head = group?.rows[0];
	const bad = group?.rows.some((item) => item.state === 'unresponsive') ?? false;
	return {
		tone: bad ? 'warn' : edgeTone(head?.state),
		caption:
			head && head.state !== 'empty' && head.state !== 'unplugged'
				? edgeCaption(head.kind)
				: m['network.devices.edge.empty'](),
	};
}

const marks = $derived({
	'A2-top': markFor('A2-top'),
	'A2-bot': markFor('A2-bot'),
	'A3-top': markFor('A3-top'),
	'A3-bot': markFor('A3-bot'),
});
</script>

<div class="space-y-3" data-testid="devices-page">
	<button
		type="button"
		data-testid="devices-back"
		class="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-md text-sm focus-visible:ring-2 focus-visible:outline-none"
		onclick={onBack}
	>
		{m['network.devices.back']()}
	</button>
	<header class="flex items-center gap-2.5">
		<Usb aria-hidden="true" class="text-primary size-5 shrink-0" />
		<h1 class="text-xl font-semibold tracking-tight">{m['network.devices.title']()}</h1>
	</header>
	<p class="text-muted-foreground text-sm">{m['network.devices.lede']()}</p>

	{#if page.status === 'checking'}
		<section class="bg-card rounded-xl border p-4" aria-busy="true" data-testid="devices-checking">
			<p class="text-sm font-semibold">{m['network.devices.checkingTitle']()}</p>
			<p class="text-muted-foreground text-sm">{m['network.devices.checkingReason']()}</p>
		</section>
	{:else}
		{#if summary}
			<div
				class="bg-card flex items-start gap-2.5 rounded-xl border p-3"
				data-testid="devices-summary"
				role="status"
			>
				<Info aria-hidden="true" class="text-status-info mt-0.5 size-4 shrink-0" />
				<p class="text-sm">{summaryLine()}</p>
			</div>
		{/if}
		<div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<section
				class="bg-card order-2 overflow-hidden rounded-xl border lg:order-1"
				data-testid="devices-ports"
				aria-label={m['network.devices.cardTitle']()}
			>
				<div class="flex items-center justify-between gap-2 px-4 py-3">
					<h2 class="flex items-center gap-2 text-sm font-semibold tracking-tight">
						<Usb aria-hidden="true" class="size-4" />
						{m['network.devices.cardTitle']()}
					</h2>
					{#if page.board === 'rock-5b-plus'}
						<span class="text-muted-foreground text-xs">ROCK 5B+</span>
					{/if}
				</div>
				{#each page.groups as group (group.id)}
					<div class="border-t" data-testid="device-port" data-socket={group.id}>
						<div class="flex flex-wrap items-baseline gap-2 px-4 pt-3">
							<h3 class="text-sm font-semibold">
								{group.builtIn ? m['network.devices.builtIn']() : group.name}
							</h3>
							{#if group.portClass === 'usb3'}
								<span class="text-status-info border-status-info/40 rounded border px-1 font-mono text-[11px] leading-5">USB 3</span>
							{:else if group.portClass === 'usb2'}
								<span class="text-muted-foreground rounded border px-1 font-mono text-[11px] leading-5">USB 2</span>
							{/if}
							{#if group.label}
								<span class="text-muted-foreground rounded border px-1 font-mono text-[11px] leading-5">{group.label}</span>
							{/if}
							{#if group.builtIn}
								<span class="text-muted-foreground text-xs">{m['network.devices.notOnAPort']()}</span>
							{/if}
						</div>
						{#each group.rows as row (row.key)}
							<div
								class="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-2.5 {row.depth > 0
									? 'pl-10'
									: ''}"
								data-testid={row.state === 'empty' ? 'device-empty' : 'device-row'}
								data-state={row.state}
								data-kind={row.kind ?? ''}
							>
								{#if row.depth > 0}
									<span
										class="border-border absolute top-0 left-6 border-l {row.lastChild ? 'h-5' : 'bottom-0'}"
										aria-hidden="true"
									></span>
									<span class="border-border absolute top-5 left-6 w-2.5 border-t" aria-hidden="true"></span>
								{/if}
								{#if row.state === 'empty'}
									<p class="text-muted-foreground col-span-3 pl-6 text-sm">{m['network.devices.empty']()}</p>
								{:else}
									<span class="mt-1.5 size-2 shrink-0 rounded-full {dotClass(row.state)}" aria-hidden="true"></span>
									<p class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
										{#if row.slot}
											<span class="text-muted-foreground font-mono text-xs font-normal">{row.slot}</span>
										{/if}
										<span class:text-muted-foreground={row.state === 'unplugged'}>
											{row.state === 'unplugged' ? m['network.devices.state.empty']() : kindLabel(row)}
										</span>
										{#if row.linkSlot}
											<span
												class="rounded px-1 font-mono text-[11px] leading-5 font-semibold"
												style:color={LINK_COLOR[row.linkSlot]}
												style:background={`color-mix(in oklab, ${LINK_COLOR[row.linkSlot]} 14%, transparent)`}
											>
												L{row.linkSlot}
											</span>
										{/if}
										{#if row.hubPorts}
											<span class="text-muted-foreground font-normal">{m['network.devices.hubPorts']({ count: row.hubPorts })}</span>
										{:else if row.product}
											<span class="text-muted-foreground font-normal">{row.product}</span>
										{/if}
									</p>
									<span class="pt-0.5 text-xs font-semibold {stateClass(row.state)}">{stateLabel(row.state)}</span>
									{#if reason(row)}
										<p class="text-muted-foreground col-start-2 text-sm">
											{reason(row)}
											{#if row.reasonKey === 'turned-off'}
												<button type="button" class="text-foreground font-medium" onclick={onBack}>
													{m['network.devices.reason.turnOn']()}
												</button>
											{/if}
										</p>
									{/if}
									{#if row.hint}
										<p class="text-muted-foreground col-start-2 flex items-start gap-1.5 text-sm" data-testid="device-hint">
											<Info
												aria-hidden="true"
												class="mt-0.5 size-3.5 shrink-0 {row.hint === 'capture-usb2' ? 'text-status-warning' : 'text-status-info'}"
											/>
											<span>
												{#if row.hint === 'rm520-usb2'}
													{m['network.devices.hint.rm520Usb2']()}
												{:else if row.hint === 'rm520-usb3'}
													{m['network.devices.hint.rm520Usb3']()}
												{:else if row.hint === 'capture-usb3'}
													{m['network.devices.hint.captureUsb3']()}
												{:else}
													{m['network.devices.hint.captureUsb2']()}
												{/if}
											</span>
										</p>
									{/if}
									{#if row.state !== 'unplugged'}
									<details class="group col-start-2 text-sm" open={row.key === openDetailsKey ? true : undefined}>
										<summary
											class="text-muted-foreground focus-visible:ring-ring inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md focus-visible:ring-2 focus-visible:outline-none"
										>
											<ChevronRight aria-hidden="true" class="size-4 transition-transform group-open:rotate-90" />
											{m['network.devices.details']()}
										</summary>
										<dl class="bg-muted grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg p-2.5 text-xs">
											<dt class="text-muted-foreground">{m['network.devices.detail.port']()}</dt>
											<dd class="font-mono" dir="ltr">{row.place ?? ''}</dd>
											<dt class="text-muted-foreground">{m['network.devices.detail.linux']()}</dt>
											<dd class="font-mono" dir="ltr">{row.controller ?? ''}{row.portPath ? ` · ${row.portPath}` : ''}</dd>
											<dt class="text-muted-foreground">{m['network.devices.detail.speed']()}</dt>
											<dd class="font-mono" dir="ltr">{speedText(row)}</dd>
											{#if row.hint === 'rm520-usb2'}
												<dt class="text-muted-foreground">{m['network.devices.detail.whyUsb2']()}</dt>
												<dd>{m['network.devices.detail.whyUsb2Value']()}</dd>
											{/if}
											<dt class="text-muted-foreground">{m['network.devices.detail.usbId']()}</dt>
											<dd class="font-mono" dir="ltr">
												{row.vendorId && row.productId ? `${row.vendorId}:${row.productId}` : ''}
												{#if row.kind === 'modem' && row.vendorId}
													· {m['network.devices.detail.modemMode']()}
												{/if}
											</dd>
											{#if row.since}
												<dt class="text-muted-foreground">{m['network.devices.detail.since']()}</dt>
												<dd class="font-mono" dir="ltr">
													{m['network.devices.detail.sinceValue']({ time: row.since, count: row.drops ?? 0 })}
												</dd>
											{/if}
											{#if row.linkId}
												<dt class="text-muted-foreground">{m['network.devices.detail.link']()}</dt>
												<dd class="font-mono break-all" dir="ltr">{row.linkId}</dd>
											{/if}
										</dl>
									</details>
									{/if}
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</section>
			<div class="order-1 contents gap-3 lg:order-2 lg:grid">
				{#if page.board === 'rock-5b-plus'}
					<div class="order-1">
						<DevicesPortEdge {marks} {alert} />
					</div>
				{:else}
					<section class="bg-card order-1 rounded-xl border p-4" data-testid="devices-where">
						<h2 class="text-sm font-semibold tracking-tight">{m['network.devices.where']()}</h2>
						<ul class="mt-2 space-y-1">
							{#each page.groups as group (group.id)}
								<li class="flex items-center gap-2 text-sm">
									<span class="size-2 rounded-sm {group.portClass === 'usb3' ? 'bg-status-info' : 'bg-foreground/70'}" aria-hidden="true"></span>
									<span>{group.builtIn ? m['network.devices.builtIn']() : group.name}</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				<section data-testid="device-events" class="bg-card order-3 overflow-hidden rounded-xl border">
					<div class="flex items-center justify-between gap-2 px-4 py-3">
						<h2 class="text-sm font-semibold tracking-tight">{m['network.devices.events.heading']()}</h2>
						<span class="text-muted-foreground text-xs">{m['network.devices.events.helpers']()}</span>
					</div>
					{#if events.length === 0}
						<p class="text-muted-foreground px-4 pb-3 text-sm">{m['network.devices.events.empty']()}</p>
					{:else}
						<ul>
							{#each events as event (event.seq)}
								<li class="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2.5 border-t px-4 py-2 text-sm" data-testid="device-event">
									<time class="text-muted-foreground font-mono text-xs">{eventClock(event)}</time>
									<span>
										{eventSentence(event)}
										<span class="text-muted-foreground block text-xs">{event.socketName}</span>
									</span>
								</li>
							{/each}
						</ul>
					{/if}
					<div class="text-muted-foreground flex items-center gap-2 border-t px-4 py-2 text-xs">
						<span>{m['network.devices.events.since']()}</span>
						<span>{m['network.devices.privacy']()}</span>
						{#if events.length > 0}
							<button
								type="button"
								data-testid="device-events-copy"
								class="bg-secondary focus-visible:ring-ring ms-auto inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
								onclick={copyEvents}
							>
								<Copy aria-hidden="true" class="size-3.5" />
								{m['network.devices.events.copy']()}
							</button>
						{/if}
					</div>
				</section>
			</div>
		</div>
	{/if}
</div>
