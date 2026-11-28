<!--
  HotspotDialog.svelte — configure / start / stop the device WiFi hotspot.

  Composes the shared AppDialog chrome (responsive Dialog ⇆ Sheet). Hotspot and
  the WiFi station are independent: this dialog never disables WiFi, it only
  drives the hotspot RPCs (configure / start / stop) for one WiFi interface.

  • Name / password / channel form, schema-driven bounds from ValidationAdapter
    (HOTSPOT_NAME_MIN/MAX, HOTSPOT_PASSWORD_MIN/MAX) — single source of truth.
  • Security is offered from the DEVICE's own `available_security` map and never
    from a local table; the read-only radio line states the width/generation the
    same capability read produced. Both derive in `hotspot-options.ts`, and both
    render NOTHING when the device did not report them — which is what keeps an
    older backend showing exactly the name/password/channel set it always did.
    There is deliberately no width SELECTOR: NetworkManager 1.42 publishes no
    hotspot channel-width property, so the control could not act.
  • Save  → rpc.wifi.hotspotConfigure, Start → rpc.wifi.hotspotStart,
    Stop → rpc.wifi.hotspotStop — all dispatched through `osCommand` (the single
    OS-op feedback path: keyed spinner, DEVICE_BUSY + failure toasts). Save and
    New Wi-Fi password share one bound write (`writeHotspotConfig`: radio token,
    entry retry, terminal receipt, one keyed op).
  • Start never dispatches directly (#413): it opens `HotspotActivationConfirm`,
    which shows the exact credentials the AP will broadcast (or stores the
    operator's own) and needs an explicit acknowledgement.
  • While the hotspot is off, the live form is NOT rendered (`hotspotConfigure`
    only reconfigures a live AP). `HotspotOffEditor` edits the name and password
    instead, through `hotspotPrepare` with the chosen pair: it modifies the
    owned profile, or before a first start stores the choice durably. Saving
    never brings the AP up. Channel and security stay live-only.
  • When the hotspot is active, ONE QR encoding the live credentials can be shown
    so phones can join by scan. It sits behind Show code in `WifiCode` (hidden by
    default, hides itself again) together with the join line and New Wi-Fi
    password. Its `T:` token follows the LIVE security mode
    (`hotspotQrSecurity`): a WPA3-SAE AP advertised as `T:WPA` yields a code that
    scans perfectly and then refuses to join.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { HotspotSecurityId, WifiInterface } from '@ceraui/rpc/schemas';
import {
	Copy,
	Eye,
	EyeOff,
	Loader2,
	Power,
	Radio,
	Router,
	Save,
	ShieldCheck,
	Trash2,
	Wifi,
} from '@lucide/svelte';
import { onDestroy, untrack } from 'svelte';
import { toast } from 'svelte-sonner';

import { AppDialog } from '$lib/components/dialogs';
import { networkConstraints } from '$lib/components/streaming';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { copyToClipboard } from '$lib/helpers/clipboard';
import { classifyWifiMutation, wifiFailureReason } from '$lib/helpers/wifi-mode-outcome';
import {
	confirmOperation,
	getOperationAttempt,
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { hotspotIsActive, hotspotToggleConfirmed } from '$lib/rpc/os-toggle-predicates';
import { getLinkEpoch } from '$lib/rpc/session-epoch.svelte';
import { getStatus } from '$lib/rpc/subscriptions.svelte';
import { getWifiAdapterModeEntry } from '$lib/rpc/wifi-adapter-modes.svelte';
import { withWifiStartReceipt } from '$lib/rpc/wifi-status-receipt';
import { getHotspotLifetime } from '$lib/stores/hotspot-joins.svelte';
import { cn } from '$lib/utils';
import HotspotActivationConfirm from '$main/network/HotspotActivationConfirm.svelte';
import HotspotOffEditor from '$main/network/HotspotOffEditor.svelte';
import { type HotspotConfigFields, writeHotspotConfig } from '$main/network/hotspot-config-write';
import {
	canRenewHotspotPassword,
	mayCarryStream,
	newHotspotPasswordFields,
} from '$main/network/hotspot-new-password';
import { generateHotspotPassword } from '$main/network/hotspot-password';
import WifiCode from '$main/network/WifiCode.svelte';
import WifiModeBadge from '$main/network/WifiModeBadge.svelte';
import WifiModeSelector from '$main/network/WifiModeSelector.svelte';
import {
	actionableWifiModeConsequence,
	deriveWifiAdapterModeView,
	type WifiModeConfirmation,
	wifiModeFrom,
	wifiModeTarget,
} from '$main/network/wifi-adapter-mode-view';
import { withWifiEntryRetry } from '$main/network/wifi-entry-request';
import { sameWifiRadio, type WifiRadioBinding, wifiRadioChanged } from '$main/network/wifi-radio-binding';
import { deriveWifiStationLock, wifiHotspotConfigOpKey, wifiHotspotOpKey, wifiModeOpKey } from '$main/network/wifi-station-lock';

import {
	deriveHotspotRadioTruth,
	deriveHotspotSecurityChoice,
	type HotspotSecurityOption,
} from './hotspot-options';

interface Props {
	open?: boolean;
	/** WiFi interface device key (record key in the wifi status map). */
	deviceId: string;
	/** The target WiFi interface — carries the live hotspot config when active. */
	iface?: WifiInterface;
}

let { open = $bindable(false), deviceId, iface }: Props = $props();

const bounds = networkConstraints.hotspot;

// The hotspot is "active" when the interface is currently broadcasting one.
const isActive = $derived(hotspotIsActive(iface));
const radioDevice = $derived(deviceId);
const radioToken = $derived(iface?.incarnation);
const radioReason = $derived(iface?.degraded_reason);
// The page-local lifetime of the AP this row shows (see `hotspot-joins.ts`):
// it changes on a Stop and Start, another radio, or an AP recreated in another
// mode or from another profile.
const apLifetime = $derived(isActive ? getHotspotLifetime(deviceId, iface) : undefined);
let ownerSession = $state(0);
let formBinding = $state.raw<WifiRadioBinding | undefined>(undefined);
let radioNotice = $state(false);
let startRefused = $state<'radio-changed' | 'deactivation-failed'>();
let bindingUnsupported = $state(false);
let admission: AbortController | undefined;
let admissionOwner: WifiRadioBinding | undefined;
// A withheld token retires the draft session, not the same radio's Save receipt.
let saveReceiptOwner: WifiRadioBinding | undefined;
let configAdmissionKey = $state<string>();
let startAdmission = $state.raw<{ readonly key: string; readonly controller: AbortController }>();
// A Start already sent when the dialog closed for a changed radio keeps its
// receipt; its correlated refusal then arrives as a notice.
let detachedStart: AbortController | undefined;
let detachedExpiry: ReturnType<typeof setTimeout> | undefined;
const START_RECEIPT_TTL_MS = 60_000;

/** At most one detached receipt, bounded on its own and gone with the view. */
function retireDetachedStart() {
	clearTimeout(detachedExpiry);
	detachedExpiry = undefined;
	detachedStart?.abort();
	detachedStart = undefined;
}

/** The dialog's own refusal wording for a Start it no longer shows. */
function startRefusalNotice(result: { error?: string; reason?: string }): string {
	if (result.reason === 'deactivation-failed') return m['network.wifiMode.error.notConfirmed']();
	if (result.error === 'radio-changed') return m['hotspotConfirm.radioChangedNotStarted']();
	if (result.error === 'DEVICE_BUSY') return m['network.os.deviceBusy']();
	if (wifiFailureReason(result) === 'hybrid-channel-not-permitted')
		return m['network.wifiMode.error.hybridChannelNotPermitted']();
	if (result.error === 'radio-unverified') return m['hotspotConfirm.radioUnverified']();
	return m['network.os.operationFailed']();
}

function capture(): WifiRadioBinding {
	return { device: deviceId, incarnation: radioToken, link: getLinkEpoch(), session: ownerSession };
}

function current(binding: WifiRadioBinding): boolean {
	return open && sameWifiRadio(binding, capture());
}

onDestroy(() => { ownerSession += 1; admission?.abort(); retireDetachedStart(); });

function beginAdmission(binding: WifiRadioBinding): AbortController {
	admission?.abort();
	configAdmissionKey = undefined;
	saveReceiptOwner = undefined;
	admissionOwner = binding;
	admission = new AbortController();
	return admission;
}

function ownsAdmission(binding: WifiRadioBinding): boolean {
	return open && deviceId === binding.device && getLinkEpoch() === binding.link;
}

// The shared adapter-mode derivation. `undefined` only while the dialog has no
// interface to describe — never a fallback rendering of its own.
const modeView = $derived(
	iface
		? deriveWifiAdapterModeView({
				device: deviceId,
				iface,
				entry: getWifiAdapterModeEntry(deviceId),
				phase: getOperationPhase(wifiModeOpKey(deviceId, radioToken)),
				target: wifiModeTarget(getOperationTarget(wifiModeOpKey(deviceId, radioToken))),
				from: wifiModeFrom(getOperationTarget(wifiModeOpKey(deviceId, radioToken))),
				failureReason: getOperationReason(wifiModeOpKey(deviceId, radioToken)),
			})
		: undefined,
);

// ── Keyed async-operation phases ──────────────────────────────────────────
// start/stop shares the `hotspot:${deviceId}` key with WifiSection's mode switch
// (T8) — the osCommand re-entry guard enforces a single hotspot op per device.
// configure uses a SEPARATE key so a save never collides with a start/stop.
const toggleKey = $derived(wifiHotspotOpKey(deviceId, radioToken));
const configKey = $derived(wifiHotspotConfigOpKey(deviceId, radioToken));
const togglePhase = $derived(getOperationPhase(toggleKey));
const toggling = $derived(togglePhase === 'pending');
const stationLock = $derived(deriveWifiStationLock({
	hotspot: togglePhase,
	mode: getOperationPhase(wifiModeOpKey(deviceId, radioToken)),
	status: iface,
}));
const stationLockReason = $derived(stationLock.reasonKey === undefined
	? undefined : resolveMessageKey(stationLock.reasonKey));
const configuring = $derived(getOperationPhase(configKey) === 'pending');
const configFailure = $derived(getOperationReason(configKey));
const toggleFailure = $derived(getOperationReason(toggleKey));
const followsStationChannel = $derived(
	modeView?.desiredMode === 'hybrid' && iface?.capabilities?.staApCombo.sameChannelOnly === true,
);

$effect(() => {
	if (!configAdmissionKey) return;
	const phase = getOperationPhase(configAdmissionKey);
	if (phase === 'idle' || phase === 'timed_out') admission?.abort();
});

$effect(() => {
	if (!startAdmission) return;
	if (getOperationPhase(startAdmission.key) !== 'pending') startAdmission.controller.abort();
});

// Local intent for the pending start/stop: the confirm $effect flips the op to
// `confirmed` the moment the authoritative snapshot reports the target mode.
let toggleTarget = $state<'hotspot' | 'station' | null>(null);
// The credential gate is open; the start is dispatched only from its confirm.
let confirmingStart = $state(false);
let confirmingMode = $state<WifiModeConfirmation>();
let modePanel = $state<HTMLDivElement>();
let toggleButton = $state<HTMLButtonElement | null>(null);
let focusRecoveredStart = $state(false);
const modeContext = $derived({
	stationLinkLive: modeView?.displayMode !== 'hotspot' && Boolean(iface?.conn),
	hotspotLive: isActive,
});
const modeOwnsConsent = $derived(Boolean(modeView && confirmingMode &&
	(confirmingMode.kind === 'credentials' ||
		actionableWifiModeConsequence(modeView, confirmingMode.mode, modeContext, stationLock.locked))));

function enableHasFocus() {
	return !isActive && toggleButton !== null && document.activeElement === toggleButton;
}

function reopenStartGate(unsupported = false) {
	if (confirmingStart || modeOwnsConsent || isActive) return;
	const focused = document.activeElement;
	focusRecoveredStart = enableHasFocus() || (focused instanceof HTMLButtonElement &&
		modePanel?.contains(focused) === true && focused.getAttribute('role') === 'radio' &&
		focused.dataset.mode !== 'station');
	if (unsupported) bindingUnsupported = true;
	ownerSession += 1;
	confirmingStart = true;
}

// ── Form state (ordinary status updates do not overwrite edits) ──
let name = $state('');
let password = $state('');
let channel = $state('auto');
let showPassword = $state(false);
let refreshFormOnSettlement = $state(false);
// `undefined` until the one-time sync runs AND the device offers a real choice;
// a save then omits `security` entirely, which the device reads as "leave the
// adapter's current selection alone".
let security = $state<HotspotSecurityId | undefined>(undefined);

function reloadForm() {
	name = iface?.hotspot?.name ?? '';
	password = iface?.hotspot?.password ?? '';
	channel = iface?.hotspot?.channel ?? 'auto';
	const choice = deriveHotspotSecurityChoice(iface?.hotspot);
	security = choice?.kind === 'select' ? choice.selected : undefined;
}

// ── Capability-derived options (device truth only — see hotspot-options.ts) ──
const securityChoice = $derived(deriveHotspotSecurityChoice(iface?.hotspot));
const radioTruth = $derived(deriveHotspotRadioTruth(iface?.hotspot, iface?.capabilities));

let prevOpen = false;
let openedTarget: { device: string; incarnation: string | undefined } | undefined;
let prevActive = false;
// The last resolved lifetime of the live AP this dialog showed.
let shownLifetime: number | undefined;
$effect.pre(() => {
	const opened = open;
	const active = isActive;
	const lifetime = apLifetime;
	const hasModeView = modeView !== undefined;
	const next = { device: radioDevice, incarnation: radioToken, link: getLinkEpoch() };
	const reason = radioReason;
	const locked = stationLock.locked;
	const refreshOnSettlement = refreshFormOnSettlement;
	untrack(() => {
		if (opened && !prevOpen) {
			retireDetachedStart();
			openedTarget = { device: next.device, incarnation: next.incarnation };
		}
		// The dialog is bound to the radio lifetime it opened on. A changed or
		// vanished pair closes it with a notice; it never follows a new
		// incarnation of the same id, which needs a fresh pick.
		if (opened && prevOpen && openedTarget && (openedTarget.device !== next.device ||
			openedTarget.incarnation !== next.incarnation)) {
			if (startAdmission && startAdmission.controller === admission &&
				getOperationPhase(startAdmission.key) === 'pending') {
				retireDetachedStart();
				const detached = startAdmission.controller;
				detachedStart = detached;
				admission = undefined;
				// Bounded like the Start operation itself.
				detachedExpiry = setTimeout(() => {
					if (detachedStart === detached) retireDetachedStart();
				}, START_RECEIPT_TTL_MS);
			} else admission?.abort();
			confirmingStart = false;
			openedTarget = undefined;
			open = false;
			toast.warning(m['network.view.hotspotRadioLost']());
			return;
		}
		if (!opened || (admissionOwner &&
			(admissionOwner.device !== next.device || admissionOwner.link !== next.link))) {
			admission?.abort();
			startRefused = undefined;
		}
		if (saveReceiptOwner && (!opened || saveReceiptOwner.device !== next.device ||
			saveReceiptOwner.link !== next.link || (next.incarnation !== undefined &&
			saveReceiptOwner.incarnation !== next.incarnation))) saveReceiptOwner = undefined;
		const changed = formBinding !== undefined && (
			formBinding.device !== next.device || formBinding.incarnation !== next.incarnation ||
			formBinding.link !== next.link
		);
		if (opened !== prevOpen || changed) ownerSession += 1;
		if (!opened || (formBinding && (formBinding.device !== next.device ||
			formBinding.link !== next.link))) refreshFormOnSettlement = false;
		if (!opened || !prevOpen || !hasModeView) confirmingMode = undefined;
		if (opened && !prevOpen) confirmingStart = false;
		if (opened && active) confirmingStart = false;
		// A live AP replaced by another lifetime of the same radio (recreated in
		// another mode or from another profile) loads like a fresh Start: the form
		// holds the AP that is up now, never one that is gone.
		const replaced = active && prevActive && shownLifetime !== undefined &&
			lifetime !== undefined && lifetime !== shownLifetime;
		if (opened && ((!prevOpen) || (active && !prevActive) || changed || replaced)) {
			bindingUnsupported = false;
			radioNotice = formBinding !== undefined && (changed || !prevOpen);
			formBinding = { ...next, session: ownerSession };
			reloadForm();
			// An editor opened or rebound during a restart has only a read-only preview.
			if (active && locked) refreshFormOnSettlement = true;
		}
		if (opened && refreshFormOnSettlement && !locked && next.incarnation && !reason) {
			reloadForm();
			refreshFormOnSettlement = false;
		}
		prevOpen = opened;
		prevActive = active;
		if (!active) shownLifetime = undefined;
		else if (lifetime !== undefined) shownLifetime = lifetime;
	});
});

const canEdit = $derived(Boolean(radioToken) && !radioReason && !bindingUnsupported &&
	formBinding !== undefined && current(formBinding));
const canEditNow = $derived(canEdit && !stationLock.locked && !refreshFormOnSettlement);

const securityLabel = $derived(
	securityChoice?.kind === 'select'
		? (securityChoice.options.find((o: HotspotSecurityOption) => o.id === security)?.name ??
				m["hotspotConfigurator.hotspot.selectSecurity"]())
		: '',
);

// ── Channel options: prefer device-reported channels, else common bands ──
const channelOptions = $derived.by(() => {
	const available = iface?.hotspot?.available_channels;
	if (available && Object.keys(available).length > 0) {
		return Object.entries(available).map(([id, c]) => ({ id, name: c.name }));
	}
	return [
		{ id: 'auto', name: m["network.modem.automaticRoamingNetwork"]() },
		{ id: 'auto_50', name: m["wifiBands.band_5ghz"]() },
		{ id: 'auto_24', name: m["wifiBands.band_2_4ghz"]() },
	];
});

const channelLabel = $derived(
	channelOptions.find((c) => c.id === channel)?.name ?? m["hotspotConfigurator.hotspot.selectChannel"](),
);

// ── Schema-driven validation ──
const nameValid = $derived(name.length >= bounds.name.min && name.length <= bounds.name.max);
const passwordValid = $derived(
	password.length >= bounds.password.min && password.length <= bounds.password.max,
);
const isFormValid = $derived(nameValid && passwordValid);

// Reason surfaced on the start/stop control while it is disabled, so the operator
// is never left guessing (busy op vs an incomplete form).
const toggleDisabledReason = $derived(
	toggling ? m["hotspotConfigurator.toggleReason.busy"]() : stationLockReason,
);

const nameError = $derived(
	name.length === 0 || nameValid
		? ''
		: name.length < bounds.name.min
			? m["hotspotConfigurator.validation.nameMinLength"]()
			: m["hotspotConfigurator.validation.nameMaxLength"](),
);
const passwordError = $derived(
	password.length === 0 || passwordValid
		? ''
		: password.length < bounds.password.min
			? m["hotspotConfigurator.validation.passwordMinLength"]()
			: m["hotspotConfigurator.validation.passwordMaxLength"](),
);

// ── New Wi-Fi password: the live setup with only the password changed ──
// Offered only while the hotspot runs and this form is bound to its radio; it
// goes through Save's own write (`writeConfig`: same binding, keyed op and
// terminal receipt), so the two can never run at once. A completed renewal
// also refreshes the form's password, so a later Save cannot put the old one back.
//
// The record belongs to one owner: the form binding (radio, link, dialog
// session), the AP lifetime it was asked on, the config key and the op attempt
// it began. Only THAT attempt can write the field, from an authoritative
// signal: the device's confirmation, or
// live credentials on the bound radio that already carry the new password. The
// dispatch ack is not waited for: the confirmation already re-enables Save, so a
// form still holding the revoked password in that gap could send it straight
// back. A timeout also writes the field: the operator asked to revoke the old
// password and accepted the drop, so a later Save completes the renewal instead
// of undoing it. The ack only drops a dispatch that was refused or never sent.
// An operator edit of the password field wins over the renewal. Closing,
// rebinding, a Stop, a restarted or replaced AP, a failure or a replacing
// dispatch drops the record, so a late completion can never write into a form
// it no longer owns.
type Renewal = {
	readonly id: object;
	readonly binding: WifiRadioBinding;
	readonly lifetime: number | undefined;
	readonly key: string;
	readonly password: string;
	readonly attempt: symbol | undefined;
};
let renewal = $state.raw<Renewal | undefined>(undefined);

function startRenewal() {
	const binding = formBinding;
	if (!isActive || !binding?.incarnation || !current(binding) || configuring) return;
	const next = generateHotspotPassword();
	const fields = newHotspotPasswordFields(deviceId, iface, next);
	if (!fields) return;
	const id = {};
	renewal = { id, binding, lifetime: apLifetime, key: configKey, password: next, attempt: undefined };
	void writeConfig(binding, fields, (attempt) => {
		if (renewal?.id === id) renewal = { ...renewal, attempt };
	}).then((result) => {
		if (renewal?.id === id && result?.success !== true) renewal = undefined;
	});
}

$effect(() => {
	const record = renewal;
	if (record === undefined) return;
	// Another known lifetime ends the record; a lifetime not resolved yet (the
	// roster feed has not matched this frame) only holds the write back.
	const sameAp = apLifetime === record.lifetime;
	const owned = isActive && record.key === configKey && current(record.binding) &&
		(sameAp || apLifetime === undefined);
	const phase = getOperationPhase(record.key);
	const attempt = getOperationAttempt(record.key);
	const live = iface?.hotspot?.password;
	untrack(() => {
		if (!owned) {
			renewal = undefined;
			return;
		}
		if (record.attempt === undefined || !sameAp) return;
		// Replaced by another dispatch or released: never ours to write again.
		if (attempt !== record.attempt) {
			renewal = undefined;
			return;
		}
		if (phase === 'failed') {
			renewal = undefined;
			return;
		}
		if (phase === 'confirmed' || phase === 'timed_out' || live === record.password) {
			password = record.password;
			renewal = undefined;
		}
	});
});

const renewOffer = $derived(
	isActive && canEditNow && canRenewHotspotPassword(deviceId, iface)
		? {
				phase: getOperationPhase(configKey),
				streaming: mayCarryStream(getStatus()),
				onrenew: startRenewal,
			}
		: undefined,
);

// Save dispatches the reconfigure; `hotspotConfigure` resolves immediately with a
// dispatch ack, so we DON'T confirmOnResolve — the real outcome arrives later as
// a `wifi` event carrying `hotspot.config`, which the subscriptions handler routes
// into `hotspot-config:${deviceId}`. The one-time form sync (`initialized` guard)
// keeps the live QR/iface re-broadcast from clobbering the in-progress edits.
async function handleSave() {
	const original = formBinding;
	if (!isFormValid || configuring || !canEditNow || !original?.incarnation) return;
	await writeConfig(original, {
		name, password, channel,
		...(security !== undefined ? { security } : {}),
	});
}

// The one config write of this dialog, shared by Save and New Wi-Fi password:
// the form's radio binding, one admission (closing or rebinding aborts the
// wait for the terminal frame) and Save's keyed op. The op stays on the
// approved radio's key: the entry retry resends only on that token, and a
// replaced radio keeps the first refusal (#675).
async function writeConfig(
	original: WifiRadioBinding,
	fields: HotspotConfigFields,
	onDispatch?: (attempt: symbol | undefined) => void,
) {
	const incarnation = original.incarnation;
	if (!incarnation) return undefined;
	const controller = beginAdmission(original);
	saveReceiptOwner = original;
	configAdmissionKey = wifiHotspotConfigOpKey(original.device, incarnation);
	let replaced = false;
	const result = await writeHotspotConfig({ ...original, incarnation }, fields, {
		signal: controller.signal,
		current: () => ownsAdmission(original),
		currentToken: () => radioToken,
		canRetry: () => current(original),
		isCurrent: () => admission === controller && !controller.signal.aborted &&
			ownsAdmission(original) && (replaced || saveReceiptOwner === original),
		...(onDispatch ? { onDispatch: (_key: string, attempt: symbol | undefined) => onDispatch(attempt) } : {}),
		onReplacement: (owned) => {
			replaced = owned;
		},
		onUnsupported: () => {
			bindingUnsupported = true;
		},
		onResult: (outcome) => {
			if (wifiRadioChanged(outcome) && current(original)) {
				radioNotice = true;
				formBinding = capture();
				// A restart row still carries pre-commit credentials.
				if (stationLock.locked) refreshFormOnSettlement = true;
				else reloadForm();
			}
		},
	});
	controller.abort();
	return result;
}

// Start/stop through the shared keyed op. Stay `pending` after dispatch; the
// confirm $effect below flips to `confirmed` once the snapshot reports the target
// mode (the 60 s Start TTL valve is the backstop if the device never reports back).
async function handleToggle() {
	if (stationLock.locked) return;
	if (isActive) {
		const binding = capture();
		toggleTarget = 'station';
		await osCommand({
			key: toggleKey,
			target: 'station',
			rpc: () => rpc.wifi.hotspotStop({
				device: binding.device,
				...(binding.incarnation !== undefined ? { incarnation: binding.incarnation } : {}),
			}),
			isCurrent: () => current(binding),
			failMessage: () => m["network.os.operationFailed"](),
			busyMessage: () => m["network.os.deviceBusy"](),
		});
	} else if (!modeOwnsConsent) {
		bindingUnsupported = false;
		ownerSession += 1;
		startRefused = undefined;
		focusRecoveredStart = false;
		confirmingStart = true;
	}
}

async function startConfirmed(incarnation: string) {
	retireDetachedStart();
	const original = capture();
	if (stationLock.locked || incarnation !== original.incarnation || radioReason) return;
	startRefused = undefined;
	const controller = beginAdmission(original);
	const key = wifiHotspotOpKey(original.device, incarnation);
	let correlated = false;
	let replaced = false;
	const ownsStart = () => admission === controller && !controller.signal.aborted && ownsAdmission(original);
	confirmingStart = false;
	toggleTarget = 'hotspot';
	await osCommand({
		key,
		target: 'hotspot',
		// The terminal waits for verified client steering after NM confirms.
		pendingTtlMs: START_RECEIPT_TTL_MS,
		classify: classifyWifiMutation,
		rpc: async (handoff) => {
			startAdmission = { key, controller };
			const result = await withWifiEntryRetry(original,
				(token) => withWifiStartReceipt(original.device,
					(attempt) => rpc.wifi.hotspotStart({ device: original.device, incarnation: token, attempt }),
					controller.signal,
				),
				{
					signal: controller.signal,
					current: ownsStart,
					currentToken: () => radioToken,
					canRetry: () => current(original) && handoff(key),
					onReplacement: () => { replaced = handoff(key); },
				},
			);
			correlated = result?.correlated === true;
			if (correlated && result && !result.success && detachedStart === controller)
				toast.error(startRefusalNotice(result));
			if (!result && ownsStart()) reopenStartGate(true);
			return result ?? { success: false, error: 'binding-required', reason: undefined };
		},
		isCurrent: () => ownsStart() && (replaced || correlated || current(original)),
		onResult: (result) => {
			if (wifiRadioChanged(result) && !confirmingStart) {
				startRefused = result.reason === 'deactivation-failed' ? 'deactivation-failed' : 'radio-changed';
				if (startRefused === 'radio-changed') reopenStartGate();
			}
		},
		failMessage: (result) => wifiFailureReason(result ?? {}) === 'hybrid-channel-not-permitted'
			? m['network.wifiMode.error.hybridChannelNotPermitted']()
			: result?.error === 'radio-unverified'
			? m['hotspotConfirm.radioUnverified']() : m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
	if (startAdmission?.controller === controller) startAdmission = undefined;
	if (detachedStart === controller) retireDetachedStart();
}

// Confirm a pending start/stop as soon as the authoritative `wifi` snapshot
// reports the target mode — the QR section then syncs from the live `iface.hotspot`
// naturally (post-confirm).
$effect(() => {
	if (getOperationPhase(toggleKey) !== 'pending') return;
	if (hotspotToggleConfirmed(toggleTarget, isActive, iface?.transition)) {
		confirmOperation(toggleKey);
	}
});

// ── Copy SSID / password to clipboard (never logs the secret) ──
async function copyName() {
	if (!name) return;
	if (await copyToClipboard(name)) {
		toast.success(m["network.clipboard.nameCopied"]());
	} else {
		toast.error(m["network.clipboard.copyFailed"](), {
			description: m["network.clipboard.copyFailedDescription"](),
		});
	}
}

async function copyPassword() {
	if (!password) return;
	if (await copyToClipboard(password)) {
		toast.success(m["network.clipboard.passwordCopied"]());
	} else {
		toast.error(m["network.clipboard.copyFailed"](), {
			description: m["network.clipboard.copyFailedDescription"](),
		});
	}
}
</script>

<AppDialog
	bind:open
	contentClass="sm:max-w-md"
	description={m["hotspotConfigurator.help.description"]()}
	hideFooter={confirmingStart}
	icon={Router}
	title={m["hotspotConfigurator.dialog.configHotspot"]()}
>
	<div class="space-y-5">
		{#if isActive && radioNotice && !refreshFormOnSettlement}
			<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-editor-radio-changed">
				{m['hotspotConfigurator.radioChanged']()}
			</p>
		{/if}
		{#if (isActive && !canEdit) || radioReason === 'permanent-mac-unresolved'}
			<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-editor-unavailable">
				{#if radioReason}{resolveMessageKey(`network.wifiDegraded.${radioReason}`)} {/if}
				{radioReason ? m['hotspotConfigurator.radioUnverified']() : m['hotspotConfirm.bindingUnsupported']()}
			</p>
		{/if}
		{#if configFailure === 'hybrid-channel-not-permitted' || toggleFailure === 'hybrid-channel-not-permitted'}
			<p class="text-muted-foreground text-xs" role="status">{m['network.wifiMode.error.hybridChannelNotPermitted']()}</p>
		{:else if configFailure === 'radio-unverified'}
			<p class="text-muted-foreground text-xs" role="status">{m['hotspotConfigurator.radioUnverified']()}</p>
		{:else if configFailure === 'radio-changed' || configFailure === 'binding-required' || configFailure === 'activating'}
			<p class="text-muted-foreground text-xs" role="status">
				{configFailure === 'activating' ? m['hotspotConfigurator.saveInterrupted']() : m['hotspotConfigurator.saveRefused']()}
			</p>
		{/if}
		{#if startRefused}
			<p class="text-muted-foreground text-xs" role="status" data-testid="hotspot-start-refused">
				{startRefused === 'deactivation-failed'
					? m['network.wifiMode.error.notConfirmed']()
					: m['hotspotConfirm.radioChangedNotStarted']()}
			</p>
		{/if}
		<!-- Status row -->
		<div
			class={cn(
				'flex items-center gap-3 rounded-lg border px-3 py-2.5',
				isActive ? 'border-status-info/30 bg-status-info/5' : 'bg-muted/40',
			)}
		>
			<span
				class={cn(
					'grid size-8 shrink-0 place-items-center rounded-md',
					isActive ? 'bg-status-info/15 text-status-info' : 'bg-secondary text-muted-foreground',
				)}
			>
				<Wifi class="size-4" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-sm font-medium" data-testid="hotspot-status" data-active={isActive}>
					{isActive ? m["network.status.active"]() : m["network.status.inactive"]()}
				</p>
				{#if iface?.ifname}
					<p class="text-muted-foreground truncate text-xs">{iface.ifname}</p>
				{/if}
			</div>
			{#if modeView?.modeKnown}
				<WifiModeBadge device={deviceId} mode={modeView.displayMode} />
			{/if}
			<span
				class={cn(
					'size-2 shrink-0 rounded-full',
					isActive ? 'bg-status-info' : 'bg-muted-foreground/40',
				)}
				aria-hidden="true"
			></span>
		</div>

		<!-- The SAME derivation the WiFi row renders. It replaced a local
		     `supports_ap_sta_concurrency` band — a third vocabulary for one fact,
		     which could not say WHY hybrid was unavailable. -->
		{#if modeView}
			<!-- biome-ignore lint/a11y/useSemanticElements: This named wrapper groups the existing WiFi mode widget; a fieldset introduces intrinsic sizing and form-group layout. -->
			<div
				bind:this={modePanel}
				class="rounded-lg border px-3 py-2.5"
				data-testid="hotspot-concurrency-status"
				role="group"
				aria-label={m["network.wifiMode.label"]()}
			>
				<WifiModeSelector
					view={modeView}
					bind:confirmation={confirmingMode}
					consentBlocked={confirmingStart}
					shouldFocusRecoveredGate={enableHasFocus}
					context={modeContext}
					lockedReason={stationLockReason}
				/>
			</div>
		{/if}

		{#if !isActive}
			{#if confirmingStart}
				<HotspotActivationConfirm
					device={deviceId}
					incarnation={bindingUnsupported ? undefined : radioToken}
					degradedReason={radioReason}
					session={ownerSession}
					reloaded={radioNotice}
					focusOnOpen={focusRecoveredStart}
					locked={stationLock.locked}
					keepsStation={iface?.supports_ap_sta_concurrency === true &&
						modeView?.desiredMode !== 'hotspot'}
					onCancel={() => {
						startAdmission?.controller.abort();
						ownerSession += 1;
						confirmingStart = false;
					}}
					onConfirm={startConfirmed}
				/>
			{:else}
				<p class="text-muted-foreground text-xs" data-testid="hotspot-inactive-hint">
					{m["hotspotConfirm.inactiveHint"]()}
				</p>
				{#if radioReason !== 'permanent-mac-unresolved'}
					<HotspotOffEditor
						device={deviceId}
						incarnation={radioToken}
						degradedReason={radioReason}
						session={ownerSession}
					/>
				{/if}
			{/if}
		{:else}
		<!-- Name -->
		<div class="space-y-1.5">
			<Label class="text-sm font-medium" for="hotspot-name">{m["network.hotspot.name"]()}</Label>
			<div class="relative">
				<Input
					id="hotspot-name"
					readonly={!canEditNow}
					class="pe-10"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					maxlength={bounds.name.max}
					minlength={bounds.name.min}
					placeholder={m["hotspotConfigurator.hotspot.placeholderName"]()}
					aria-invalid={Boolean(nameError)}
					bind:value={name}
				/>
				<Button
					class="absolute end-1 top-1/2 size-8 -translate-y-1/2 rounded-md"
					aria-label={m["network.accessibility.copyName"]()}
					disabled={!name}
					onclick={copyName}
					size="icon"
					type="button"
					variant="ghost"
				>
					<Copy class="size-4" />
				</Button>
			</div>
			{#if nameError}
				<p class="text-destructive text-xs">{nameError}</p>
			{/if}
		</div>

		<!-- Password -->
		<div class="space-y-1.5">
			<Label class="text-sm font-medium" for="hotspot-password">
				{m["network.hotspot.password"]()}
			</Label>
			<div class="relative">
				<Input
					id="hotspot-password"
					readonly={!canEditNow}
					class="pe-20"
					autocapitalize="none"
					autocomplete="off"
					autocorrect="off"
					maxlength={bounds.password.max}
					minlength={bounds.password.min}
					placeholder={m["hotspotConfigurator.hotspot.placeholderPassword"]()}
					type={showPassword ? 'text' : 'password'}
					aria-invalid={Boolean(passwordError)}
					oninput={() => {
						// The operator's own password wins over a renewal in flight.
						renewal = undefined;
					}}
					bind:value={password}
				/>
				<div class="absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
					<Button
						class="size-8 rounded-md"
						aria-label={m["network.accessibility.copyPassword"]()}
						disabled={!password}
						onclick={copyPassword}
						size="icon"
						type="button"
						variant="ghost"
					>
						<Copy class="size-4" />
					</Button>
					<Button
						class="size-8 rounded-md"
						aria-label={showPassword ? m["auth.hidePassword"]() : m["auth.showPassword"]()}
						onclick={() => (showPassword = !showPassword)}
						size="icon"
						type="button"
						variant="ghost"
					>
						{#if showPassword}
							<EyeOff class="size-4" />
						{:else}
							<Eye class="size-4" />
						{/if}
					</Button>
				</div>
			</div>
			{#if passwordError}
				<p class="text-destructive text-xs">{passwordError}</p>
			{/if}
		</div>

		<!-- Channel -->
		<div class="space-y-1.5">
			<Label class="text-sm font-medium" for="hotspot-channel">
				{m["network.hotspot.channel"]()}
			</Label>
			<Select.Root disabled={!canEditNow} onValueChange={(v) => (channel = v)} type="single" bind:value={channel}>
				<Select.Trigger id="hotspot-channel" class="w-full">{channelLabel}</Select.Trigger>
				<Select.Content>
					{#each channelOptions as option (option.id)}
						<Select.Item label={option.name} value={option.id} />
					{/each}
				</Select.Content>
			</Select.Root>
			<p class="text-muted-foreground text-xs" data-testid={followsStationChannel ? 'hotspot-hybrid-channel-hint' : undefined}>
				{followsStationChannel ? m['hotspotConfigurator.help.hybridChannel']() : m["hotspotConfigurator.help.channelHelp"]()}
			</p>
		</div>

		<!--
			Security. Rendered ONLY from the device's own offered map:
			 · two or more modes → a real selector
			 · exactly one       → stated, because one option is not a choice
			 · none reported     → nothing at all (older backend / no derivation)
		-->
		{#if securityChoice?.kind === 'select'}
			<div class="space-y-1.5" data-testid="hotspot-security-select">
				<Label class="text-sm font-medium" for="hotspot-security">
					{m["hotspotConfigurator.hotspot.security"]()}
				</Label>
				<Select.Root
					disabled={!canEditNow}
					onValueChange={(v) => {
						// Narrowed rather than cast: the wire enum is the acceptance set,
						// so a value outside it is refused instead of persisted.
						if (v === 'wpa2' || v === 'wpa3-sae') security = v;
					}}
					type="single"
					value={security ?? ''}
				>
					<Select.Trigger id="hotspot-security" class="w-full">{securityLabel}</Select.Trigger>
					<Select.Content>
						{#each securityChoice.options as option (option.id)}
							<Select.Item
								data-testid="hotspot-security-option-{option.id}"
								label={option.name}
								value={option.id}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
				<p class="text-muted-foreground text-xs">
					{m["hotspotConfigurator.help.securityHelp"]()}
				</p>
			</div>
		{:else if securityChoice?.kind === 'stated'}
			<div
				class="text-muted-foreground flex items-center gap-2 text-xs"
				data-testid="hotspot-security-stated"
			>
				<ShieldCheck aria-hidden="true" class="size-3.5 shrink-0" />
				<span>{m["hotspotConfigurator.hotspot.security"]()}</span>
				<span class="text-foreground font-medium">{securityChoice.option.name}</span>
			</div>
		{/if}

		<!--
			READ-ONLY radio truth. Width has no selector anywhere in this contract —
			NetworkManager 1.42 exposes no hotspot channel-width property, so one
			could not act. Demoted per DESIGN.md §2 (hardware tags, muted, never the
			phosphor-lime accent, which stays reserved for the live signal).
		-->
		{#if radioTruth}
			<div
				class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
				data-testid="hotspot-radio-truth"
			>
				<Radio aria-hidden="true" class="size-3.5 shrink-0" />
				{#if radioTruth.generationLabelKey}
					<span data-testid="hotspot-radio-generation">
						{resolveMessageKey(radioTruth.generationLabelKey)}
					</span>
				{/if}
				{#each radioTruth.bands as band (band.band)}
					<span data-testid="hotspot-radio-width-{band.band}">
						{resolveMessageKey(band.labelKey)}
						·
						{m["network.wifiCapability.width"]({ mhz: band.widthMhz })}
					</span>
				{/each}
			</div>
		{/if}
		{/if}

		<!-- The live hotspot's join code, hidden until Show (WifiCode) -->
		{#if isActive}
			<div class="bg-muted/40 space-y-2 rounded-lg border p-4" data-testid="hotspot-wifi-code">
				<p class="text-muted-foreground text-center text-xs font-medium">
					{m["network.accessibility.wifiQrCode"]()}
				</p>
				{#if iface?.hotspot?.name}
					<p class="text-center text-sm font-medium">{iface.hotspot.name}</p>
				{/if}
				<WifiCode
					name={iface?.hotspot?.name}
					password={iface?.hotspot?.password}
					security={iface?.hotspot?.security}
					owner={{ device: deviceId, incarnation: radioToken, lifetime: apLifetime }}
					renew={renewOffer}
				/>
			</div>
		{/if}
	</div>

	{#snippet actions()}
		{#if !confirmingStart && isActive && radioReason !== 'permanent-mac-unresolved'}
		<Button class="sm:min-w-24" data-testid="hotspot-save" disabled={!canEditNow || !isFormValid || configuring} onclick={handleSave}>
			{#if configuring}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{:else}
				<Save class="size-4" />
			{/if}
			{configuring ? m["hotspotConfigurator.dialog.saving"]() : m["hotspotConfigurator.dialog.save"]()}
		</Button>
		{/if}
		<!-- One action row at a time: while the credential gate is open, its own
		     Cancel / Turn on are the only way forward. -->
		{#if !confirmingStart && (isActive || radioReason !== 'permanent-mac-unresolved')}
		<Button
			bind:ref={toggleButton}
			class="sm:min-w-28"
			data-testid="hotspot-toggle"
			disabled={stationLock.locked || (!isActive && modeOwnsConsent)}
			onclick={handleToggle}
			title={toggleDisabledReason}
			variant={isActive ? 'outline' : 'default'}
		>
			{#if toggling}
				<Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
			{:else}
				<Power class="size-4" />
			{/if}
			{isActive ? m["network.status.turnOff"]() : m["hotspotConfirm.activate"]()}
		</Button>
		{/if}
	{/snippet}
</AppDialog>
