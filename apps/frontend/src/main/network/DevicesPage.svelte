<!--
  Network › Devices. Read-only. One group per physical socket.
  An empty socket is rendered from presence, never from kind "other".
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { UsbDevicesWire } from '@ceraui/rpc/schemas';
import { ChevronRight, Info, Usb } from '@lucide/svelte';

import { type DeviceRow, devicesPageModel } from './devices-model';

interface Props {
	wire: UsbDevicesWire | undefined;
	onBack: () => void;
}

const { wire, onBack }: Props = $props();
const page = $derived(devicesPageModel(wire));

function kindLabel(row: DeviceRow): string {
	if (row.kind === null) return '';
	return resolveMessageKey(`network.devices.kind.${row.kind}`);
}

function stateLabel(row: DeviceRow): string {
	if (row.state === 'empty') return m['network.devices.state.empty']();
	if (row.state === 'unused') return m['network.devices.state.unused']();
	if (row.state === 'checking') return m['network.devices.state.checking']();
	return m['network.devices.state.on']();
}

function reason(row: DeviceRow): string {
	if (row.state === 'empty') return m['network.devices.reason.empty']();
	if (row.state === 'unused') return m['network.devices.reason.unused']();
	if (row.kind === 'hub') return m['network.devices.reason.hub']();
	return m['network.devices.reason.on']();
}

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
		<section
			class="bg-card rounded-xl border p-4"
			aria-busy="true"
			data-testid="devices-checking"
		>
			<p class="text-sm font-semibold">{m['network.devices.checkingTitle']()}</p>
			<p class="text-muted-foreground text-sm">{m['network.devices.checkingReason']()}</p>
		</section>
	{:else}
		<div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<section
				class="bg-card order-2 space-y-4 rounded-xl border p-4 lg:order-1"
				data-testid="devices-ports"
				aria-label={m['network.devices.cardTitle']()}
			>
				<div class="flex items-center justify-between gap-2">
					<h2 class="flex items-center gap-2 text-sm font-semibold tracking-tight">
						<Usb aria-hidden="true" class="size-4" />
						{m['network.devices.cardTitle']()}
					</h2>
					{#if page.board === 'rock-5b-plus'}
						<span class="text-muted-foreground text-xs">ROCK 5B+</span>
					{/if}
				</div>
				{#each page.groups as group (group.id)}
					<div class="space-y-2" data-testid="device-port" data-socket={group.id}>
						<div class="flex flex-wrap items-center gap-2">
							<h3 class="text-sm font-semibold">
								{group.builtIn ? m['network.devices.builtIn']() : group.name}
							</h3>
							{#if group.portClass === 'usb3'}
								<span class="bg-muted rounded-md px-1.5 py-0.5 text-xs">USB 3</span>
							{:else if group.portClass === 'usb2'}
								<span class="bg-muted rounded-md px-1.5 py-0.5 text-xs">USB 2</span>
							{/if}
							{#if group.label}
								<span class="text-muted-foreground text-xs">{group.label}</span>
							{/if}
						</div>
						{#each group.rows as row (row.key)}
							<div
								class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1"
								style:padding-left={`${row.depth * 1}rem`}
								data-testid={row.state === 'empty' ? 'device-empty' : 'device-row'}
								data-state={row.state}
								data-kind={row.kind ?? ''}
							>
								<span
									class="mt-1.5 size-2.5 shrink-0 rounded-full {row.state === 'on'
										? 'bg-status-success'
										: row.state === 'empty'
											? 'border-muted-foreground border border-dashed'
											: 'bg-muted-foreground'}"
									aria-hidden="true"
								></span>
								<div class="min-w-0">
									{#if row.state === 'empty'}
										<p class="text-muted-foreground text-sm">{m['network.devices.empty']()}</p>
									{:else}
										<p class="text-sm">
											{#if row.slot}
												<span class="text-muted-foreground">{row.slot}</span>
											{/if}
											{kindLabel(row)}
											{#if row.product}
												<span class="text-muted-foreground">{row.product}</span>
											{/if}
										</p>
									{/if}
									<p class="text-muted-foreground text-sm">{reason(row)}</p>
									{#if row.hint === 'rm520-usb2'}
										<p class="text-status-info flex items-start gap-1.5 text-sm" data-testid="device-hint">
											<Info aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
											<span>{m['network.devices.hint.rm520Usb2']()}</span>
										</p>
									{:else if row.hint === 'capture-usb2'}
										<p class="text-status-info flex items-start gap-1.5 text-sm" data-testid="device-hint">
											<Info aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
											<span>{m['network.devices.hint.captureUsb2']()}</span>
										</p>
									{/if}
									{#if row.state !== 'empty'}
										<details class="text-sm">
											<summary
												class="text-muted-foreground focus-visible:ring-ring inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md focus-visible:ring-2 focus-visible:outline-none"
											>
												<ChevronRight aria-hidden="true" class="size-4" />
												{m['network.devices.details']()}
											</summary>
											<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-xs">
												<dt class="text-muted-foreground">{m['network.devices.detail.port']()}</dt>
												<dd class="font-mono" dir="ltr">{row.portPath ?? ''}</dd>
												<dt class="text-muted-foreground">{m['network.devices.detail.controller']()}</dt>
												<dd class="font-mono" dir="ltr">{row.controller ?? ''}</dd>
												<dt class="text-muted-foreground">{m['network.devices.detail.speed']()}</dt>
												<dd class="font-mono" dir="ltr">{row.speedClass}</dd>
												<dt class="text-muted-foreground">{m['network.devices.detail.usbId']()}</dt>
												<dd class="font-mono" dir="ltr">
													{row.vendorId && row.productId ? `${row.vendorId}:${row.productId}` : ''}
												</dd>
												<dt class="text-muted-foreground">{m['network.devices.detail.link']()}</dt>
												<dd class="font-mono break-all" dir="ltr">{row.linkId ?? ''}</dd>
											</dl>
										</details>
									{/if}
								</div>
								<span
									class="text-sm {row.state === 'on'
										? 'text-status-success'
										: 'text-muted-foreground'}"
								>
									{stateLabel(row)}
								</span>
							</div>
						{/each}
					</div>
				{/each}
			</section>
			<aside class="order-1 space-y-3 lg:order-2">
				<section class="bg-card rounded-xl border p-4" data-testid="devices-where">
					<h2 class="text-sm font-semibold tracking-tight">{m['network.devices.where']()}</h2>
					<ul class="mt-2 space-y-1">
						{#each page.groups as group (group.id)}
							<li class="flex items-center gap-2 text-sm">
								<span
									class="size-2 rounded-sm {group.portClass === 'usb3'
										? 'bg-sky-500'
										: 'bg-foreground/70'}"
									aria-hidden="true"
								></span>
								<span>{group.builtIn ? m['network.devices.builtIn']() : group.name}</span>
							</li>
						{/each}
					</ul>
				</section>
				<p class="text-muted-foreground text-xs">{m['network.devices.privacy']()}</p>
			</aside>
		</div>
	{/if}
</div>
