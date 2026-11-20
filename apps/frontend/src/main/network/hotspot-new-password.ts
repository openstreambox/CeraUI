/**
 * New Wi-Fi password: a fresh random password on the running hotspot, through the
 * same bound config write the hotspot dialog's Save uses (`writeHotspotConfig`:
 * same RPC, same `{device, incarnation}` binding, same keyed op and terminal
 * receipt, so the two can never run at once). NetworkManager keeps one password
 * per hotspot profile and restarts the profile to apply a new one, so every
 * joined device drops and has to join again; the UI says so before it asks.
 *
 * Renewal exists only while the AP is up: `hotspotConfigure` reconfigures a live
 * AP, and a stopped hotspot has no `hotspot` block to renew from.
 */
import type {
	HotspotConfigInput,
	StatusResponse,
	WifiInterface,
} from "@ceraui/rpc/schemas";

import { resolveAsyncOpTtlMs } from "$lib/rpc/async-operation.svelte";
import { getLinkEpoch } from "$lib/rpc/session-epoch.svelte";

import {
	type HotspotConfigFields,
	type HotspotConfigWriteOwner,
	writeHotspotConfig,
} from "./hotspot-config-write";
import { generateHotspotPassword } from "./hotspot-password";
import { wifiHotspotConfigOpKey } from "./wifi-station-lock";

/**
 * The config input that changes ONLY the password. `undefined` when the live
 * hotspot is not fully known (no live AP, no binding token, name or channel) or
 * its radio is unverified, so a partial setup is never written.
 */
export function newHotspotPasswordInput(
	device: string,
	iface: WifiInterface | undefined,
	password: string,
): HotspotConfigInput | undefined {
	const hotspot = iface?.hotspot;
	if (
		!iface?.incarnation ||
		iface.degraded_reason !== undefined ||
		!hotspot?.name ||
		!hotspot.channel
	)
		return undefined;
	return {
		device,
		incarnation: iface.incarnation,
		name: hotspot.name,
		password,
		channel: hotspot.channel,
		...(hotspot.security !== undefined ? { security: hotspot.security } : {}),
	};
}

/** The same input without its binding, for a caller that binds it itself. */
export function newHotspotPasswordFields(
	device: string,
	iface: WifiInterface | undefined,
	password: string,
): HotspotConfigFields | undefined {
	const input = newHotspotPasswordInput(device, iface, password);
	if (!input) return undefined;
	const { device: _device, incarnation: _incarnation, ...fields } = input;
	return fields;
}

/** Whether the live hotspot is known well enough to renew its password. */
export function canRenewHotspotPassword(
	device: string,
	iface: WifiInterface | undefined,
): boolean {
	return newHotspotPasswordInput(device, iface, "") !== undefined;
}

/**
 * Whether a stream may be going through the box's Wi-Fi right now: the box's own
 * encoder is streaming, or a link box is carrying a phone's stream or cannot say
 * yet. The confirmation then adds the cost line for that stream.
 */
export function mayCarryStream(status: StatusResponse | undefined): boolean {
	if (status?.is_streaming === true) return true;
	return status?.phone_box === true && status.carrying?.state !== "idle";
}

/** The keyed op a renewal runs under, shared with the dialog's Save. */
export function newHotspotPasswordKey(
	device: string,
	iface: WifiInterface | undefined,
): string {
	return wifiHotspotConfigOpKey(device, iface?.incarnation);
}

export type RenewHotspotPasswordOptions = {
	readonly generate?: () => string;
	/** Runs once the keyed op has begun, with that attempt's token. */
	readonly onDispatch?: (attempt: symbol | undefined) => void;
	/**
	 * Aborts the wait for the device's terminal frame. Without one, the wait
	 * ends with the keyed op's pending window.
	 */
	readonly signal?: AbortSignal;
};

/**
 * Renew from a surface without its own form (the Connect your phone panel).
 * Resolves to the password once the device's terminal frame accepted it (or
 * the wait ended with the request still accepted), or `undefined` when nothing
 * was sent, the dispatch was refused, or the terminal refused it.
 * `onDispatch` lets a caller tell its own confirmation from a later one under
 * the same key.
 */
export async function renewHotspotPassword(
	device: string,
	iface: WifiInterface | undefined,
	options: RenewHotspotPasswordOptions = {},
): Promise<string | undefined> {
	const password = (options.generate ?? generateHotspotPassword)();
	const fields = newHotspotPasswordFields(device, iface, password);
	const incarnation = iface?.incarnation;
	if (!fields || !incarnation) return undefined;
	const link = getLinkEpoch();
	const local = new AbortController();
	const timer = setTimeout(() => local.abort(), resolveAsyncOpTtlMs());
	const signal = options.signal
		? AbortSignal.any([options.signal, local.signal])
		: local.signal;
	const owner: HotspotConfigWriteOwner = {
		signal,
		current: () => getLinkEpoch() === link,
		...(options.onDispatch
			? { onDispatch: (_key, attempt) => options.onDispatch?.(attempt) }
			: {}),
	};
	try {
		const result = await writeHotspotConfig(
			{ device, incarnation, link, session: 0 },
			fields,
			owner,
		);
		return result?.success === true ? password : undefined;
	} finally {
		clearTimeout(timer);
		local.abort();
	}
}
