<script lang="ts">
	import { m } from '@ceraui/i18n/svelte';
	import type {
		MoblinkResult,
		MoblinkStatus,
		PhoneBoxSettings,
		PhoneWay,
		StatusResponse,
	} from '@ceraui/rpc/schemas';
	import { onMount } from 'svelte';
	import PhoneBoxHealth from './PhoneBoxHealth.svelte';
	import { phoneState, remotePhoneState, showPhoneQr } from './phone-home';

	let {
		carrying,
		reachable = true,
		settings,
		receiver,
		links = [],
		health = [],
		temperature = null,
		kiosk = false,
		wifi,
		moblink,
		oncredential,
		onclearcredential,
		onsave,
		onrestart,
		onnetwork,
		onserver,
	}: {
		moblink?: MoblinkStatus;
		oncredential?: (password: string) => Promise<MoblinkResult>;
		onclearcredential?: () => Promise<MoblinkResult>;
		wifi?: { name?: string; password?: string; clients?: number };
		kiosk?: boolean;
		reachable?: boolean;
		carrying?: 'streaming' | 'idle' | 'unknown';
		settings?: PhoneBoxSettings;
		receiver?: string;
		links?: { id: string; label: string; internet: 'yes' | 'no' | 'unknown' }[];
		health?: NonNullable<StatusResponse['box_health']>;
		temperature?: number | null;
		onsave?: (way: PhoneWay) => Promise<void>;
		onrestart?: () => void;
		onnetwork?: () => void;
		onserver?: () => void;
	} = $props();
	const viewState = $derived(phoneState(reachable ? carrying : undefined));
	let connect = $state(false);
	let password = $state('');
	let credentialBusy = $state(false);
	const clearAllowed = $derived(reachable && carrying === 'idle' && !credentialBusy);
	const credentialAllowed = $derived(
		reachable && carrying === 'idle' && moblink?.available === true && !credentialBusy,
	);
	async function submitCredential(clear = false) {
		if (clear ? !clearAllowed : !credentialAllowed) return;
		credentialBusy = true;
		const submitted = password;
		password = '';
		try {
			const reply = clear ? await onclearcredential?.() : await oncredential?.(submitted);
			result = reply?.success
				? clear
					? m['live.phone.moblinCleared']()
					: m['live.phone.moblinSaved']()
				: m['live.phone.moblinFailed']();
		} catch {
			result = m['live.phone.moblinFailed']();
		} finally {
			credentialBusy = false;
		}
	}
	$effect(() => {
		if (!connect || selected !== 'moblin' || !credentialAllowed) password = '';
	});
	let way = $state<PhoneWay | null>(null);
	let choosing = $state(true);
	let result = $state('');
	let qr = $state('');
	let wifiQr = $state('');
	let width = $state(0);
	const selected = $derived(way ?? settings?.way ?? null);
	const computer = $derived(showPhoneQr(width, kiosk));
	onMount(() => {
		width = window.innerWidth;
		const resize = () => (width = window.innerWidth);
		window.addEventListener('resize', resize);
		return () => window.removeEventListener('resize', resize);
	});
	$effect(() => {
		let active = true;
		qr = '';
		const address = settings?.srt?.address;
		if (computer && address)
			void import('qrcode')
				.then((q) => q.toDataURL(address))
				.then((value) => {
					if (active) qr = value;
				})
				.catch(() => {
					/* Copy remains available if QR generation fails. */
				});
		return () => {
			active = false;
		};
	});
	function choose(value: PhoneWay) {
		password = '';
		way = value;
		choosing = false;
		result = '';
	}
	let wasCarrying = false;
	$effect(() => {
		const active = carrying === 'streaming';
		if (active && !wasCarrying && way) void remember(way);
		wasCarrying = active;
	});
	async function remember(value: PhoneWay) {
		try {
			await onsave?.(value);
		} catch {
			result = m['live.phone.saveFailed']();
		}
	}
	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			result = m['live.phone.copied']();
		} catch {
			result = m['live.phone.copyFailed']();
		}
	}
	function escapeWifi(value: string) {
		return value.replace(/[\\;,:"]/g, '\\$&');
	}
	$effect(() => {
		let active = true;
		wifiQr = '';
		if (computer && wifi?.name && wifi.password) {
			const payload = `WIFI:T:WPA;S:${escapeWifi(wifi.name)};P:${escapeWifi(wifi.password)};;`;
			void import('qrcode')
				.then((q) => q.toDataURL(payload))
				.then((value) => {
					if (active) wifiQr = value;
				})
				.catch(() => {
					/* Copy remains available. */
				});
		}
		return () => {
			active = false;
		};
	});
	const lastWay = $derived(settings?.way ?? null);
	const last = $derived(
		lastWay === 'moblin'
			? 'lastMoblin'
			: lastWay === 'srt'
				? 'lastSrt'
				: lastWay === 'internet'
					? 'lastInternet'
					: 'lastNone',
	);
</script>

<div class="phone-home" data-testid="phone-home">
	{#if connect}
		<button type="button" onclick={() => (connect = false)}>{m['live.phone.back']()}</button>
		<h1>{m['live.phone.connect']()}</h1>
		{#if choosing}<p>{m['live.phone.intro']()}</p>{/if}
		{#if choosing}
			<div class="choices">
				{#each ['moblin', 'srt', 'internet'] as const as app (app)}<button
						type="button"
						aria-label={m[`live.phone.${app}`]()}
						onclick={() => choose(app as PhoneWay)}
						>{m[`live.phone.${app}`]()}<small>{m[`live.phone.${app}Choice`]()}</small></button
					>{/each}
				<button type="button" onclick={() => choose('srt')}>{m['live.phone.another']()}</button>
			</div>
			<p>{m['live.phone.unsure']()}</p>
		{:else}<p>{selected ? m[`live.phone.${selected}`]() : ''}</p><button type="button" onclick={() => (choosing = true)}
				>{m['live.phone.change']()}</button
			>{/if}
		{#if !choosing}
			<section>
				<h2>1. {m['live.phone.join']()}</h2>
				<p>{wifi?.name ? m['live.phone.joinNamed']({name:wifi.name}) : m['live.phone.joinBody']()}</p>
				{#if wifi?.name}<p>{m['live.phone.wifiName']()}</p><code>{wifi.name}</code>{/if}
				{#if wifi?.password}<p>{m['live.phone.wifiPassword']()}</p>
					<input
						type="password"
						readonly
						value={wifi.password}
						aria-label={m['live.phone.wifiPassword']()}
					/><button type="button" onclick={() => copy(wifi?.password ?? '')}
						>{m['live.phone.copy']()}</button
					>{/if}
				{#if computer && wifiQr}<img
						src={wifiQr}
						alt={m['live.phone.wifiScan']()}
						width="160"
						height="160"
					/>{/if}
				<button type="button" onclick={onnetwork}>{m['live.phone.wifiSettings']()}</button>
			</section>
			{#if selected === 'moblin'}
				<section>
					<h2>2. {m['live.phone.moblinEnable']()}</h2>
					<p>{m['live.phone.moblinBody']()}</p>
					<label
						>{m['live.phone.moblinPassword']()}<input
							type="password"
							autocomplete="off"
							data-1p-ignore=""
							data-lpignore="true"
							data-bwignore=""
							data-form-type="other"
							bind:value={password}
							disabled={!credentialAllowed}
						/></label
					>
					{#if moblink?.available}
						<p>
							{moblink.configured
								? m['live.phone.moblinConfigured']()
								: m['live.phone.moblinBinding']()}
						</p>
						{#if !reachable || carrying !== 'idle'}<p>{m['live.phone.moblinBusy']()}</p>{/if}
						<button
							type="button"
							disabled={!credentialAllowed || !password}
							onclick={() => submitCredential()}>{m['live.phone.moblinSave']()}</button
						>
					{:else}<p>{m['live.phone.moblinUnavailable']()}</p>{/if}
					<button
						type="button"
						disabled={!clearAllowed}
						onclick={() => submitCredential(true)}>{m['live.phone.moblinClear']()}</button
					>

					<button type="button" onclick={() => choose('internet')}
						>{m['live.phone.internet']()}</button
					>
				</section>
			{:else if selected === 'srt'}
				<section>
					<h2>2. {m['live.phone.receiver']()}</h2>
					{#if receiver}<code>{receiver}</code>{:else}<p>{m['live.phone.noServer']()}</p>{/if}
					<p>{m['live.phone.receiverBody']()}</p><button type="button" onclick={() => choose('internet')}>{m['live.phone.internet']()}</button>
					<button type="button" disabled={carrying !== 'idle'} onclick={onserver}
						>{receiver ? m['live.phone.serverChange']() : m['live.phone.setServer']()}</button
					>
				</section>
				<section>
					<h2>3. {m['live.phone.srtPoint']()}</h2>
					{#if settings?.srt}
						<p>{m['live.phone.address']()}</p>
						<code>{settings.srt.address}</code><button
							type="button"
							onclick={() => copy(settings?.srt?.address ?? '')}>{m['live.phone.copy']()}</button
						>
						{#if computer && qr}<img
								src={qr}
								alt={m['live.phone.scan']()}
								width="160"
								height="160"
							/>{/if}
						<p>{m['live.phone.passphrase']()}</p>
						<input
							readonly
							type="password"
							value={settings.srt.passphrase}
							aria-label={m['live.phone.passphrase']()}
						/><button type="button" onclick={() => copy(settings?.srt?.passphrase ?? '')}
							>{m['live.phone.copy']()}</button
						>
					{:else}<p>{m['live.phone.srtUnavailable']()}</p><button type="button" onclick={() => choose('internet')}>{m['live.phone.internet']()}</button>{/if}
					<p>{m['live.phone.srtBody']()}</p>
				</section>
			{/if}
			<section>
				<h2>{m['live.phone.try']()}</h2>
				<p>{selected === 'internet' ? m['live.phone.internetTry']() : selected === 'srt' ? m['live.phone.srtTry']() : m['live.phone.tryBody']()}</p>
			</section>
		{/if}
	{:else}
		<div class="home-grid">
			<section class="state-card" data-state={viewState}>
				<span class="badge"
					>{viewState === 'active'
						? m['live.phone.badgeActive']()
						: viewState === 'ready'
							? m['live.phone.badgeReady']()
							: m['live.phone.badgeChecking']()}</span
				>
				<h1>{m[`live.phone.${viewState}`]()}</h1>
				<p>
					{reachable ? m[`live.phone.${viewState}Body`]() : m['live.phone.remoteUnreachable']()}
				</p>
				{#if viewState === 'ready'}<p>{m[`live.phone.${last}`]()}</p>{/if}
				<h2>{m['live.phone.links']()}</h2>
				{#if links.length === 0}<p>{viewState === 'active' ? m['live.phone.linkUnavailable']() : m['live.phone.linkChecking']()}</p>{/if}
				<ul>
					{#each links as link (link.id)}<li>
							<strong>{link.label}</strong><span
								>{reachable && link.internet === 'yes'
									? m['live.phone.internetOk']()
									: reachable && link.internet === 'no'
										? m['live.phone.noInternet']()
										: viewState === 'active' ? m['live.phone.linkUnavailable']() : m['live.phone.linkChecking']()}</span
							>
						</li>{/each}
				</ul>
				<p>{viewState === 'active' ? m['live.phone.hold']() : m['live.phone.linkHint']()}</p>
				{#if viewState !== 'active'}<button
						type="button"
						onclick={() => {
							connect = true;
							choosing = selected === null;
						}}>{m['live.phone.connect']()}</button
					><button
						type="button"
						onclick={() => {
							connect = true;
							choosing = selected === null;
						}}>{m['live.phone.check']()}</button
					>
					<p>{m['live.phone.small']()}</p>{/if}
			</section>
			<aside>
				<section>
					<h2>{m['live.phone.temperature']()}</h2>
					<p>{!reachable || temperature === null ? '—' : `${Math.round(temperature)} °C${temperature < 70 ? ` · ${m['live.phone.fine']()}` : ''}`}</p>
				</section>
				<section>
					<h2>{m['live.phone.wifi']()}</h2>
					<p>{wifi?.name ?? m['live.phone.notSetUp']()}</p>
					{#if reachable && wifi?.clients !== undefined}<p>
							{wifi.clients === 1 ? m['live.phone.wifiClient']() : m['live.phone.wifiClients']({ count: wifi.clients })}
						</p>{/if}<button type="button" onclick={onnetwork}>{m['live.phone.wifiSettings']()}</button>
				</section>
				<PhoneBoxHealth way={lastWay} {reachable} {health} {links} {carrying} {onrestart} />
			</aside>
		</div>
	{/if}
	<details>
		<summary>{m['live.phone.helpers']()}</summary>
		<p>{remotePhoneState(carrying, reachable)}</p>
	</details>
	<p role="status">{result}</p>
</div>

<style>
	.phone-home {
		max-width: 1100px;
		margin: auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.home-grid {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: 1.25rem;
	}
	section {
		border: 1px solid var(--border);
		border-radius: 1rem;
		padding: 1.25rem;
		margin-bottom: 1rem;
		min-width: 0;
	}
	.state-card[data-state='active'] {
		border-color: var(--primary);
	}
	h1 {
		font-size: 1.75rem;
		line-height: 1.25;
		margin: 1rem 0;
		font-weight: 650;
	}
	h2 {
		font-weight: 600;
		margin-bottom: 0.75rem;
	}
	p {
		margin: 0.75rem 0;
		color: var(--muted-foreground);
		line-height: 1.6;
	}
	.badge {
		font-family: monospace;
		font-weight: 600;
	}
	button {
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		padding: 0.65rem 0.9rem;
		min-height: 44px;
		margin: 0.25rem 0.5rem 0.25rem 0;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button:focus-visible {
		outline: 2px solid var(--primary);
	}
	small,
	li span {
		display: block;
		color: var(--muted-foreground);
		margin-top: 0.5rem;
	}
	li {
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--border);
	}
	code {
		display: block;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	input {
		max-width: 100%;
		min-width: 0;
		display: block;
		border: 1px solid var(--border);
		padding: 0.5rem;
	}
	.choices {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.choices button {
		text-align: left;
	}
	img {
		margin: 0.75rem 0;
	}
	@media (max-width: 767px) {
		.home-grid,
		.choices {
			grid-template-columns: minmax(0, 1fr);
		}
		h1 {
			font-size: 1.5rem;
		}
		section {
			padding: 1rem;
		}
	}
</style>
