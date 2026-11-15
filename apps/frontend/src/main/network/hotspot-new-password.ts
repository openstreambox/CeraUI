/**
 * New Wi-Fi password: a fresh random password on the running hotspot, through the
 * same reconfigure the hotspot dialog's Save uses (same RPC, same keyed op, so the
 * two can never run at once). NetworkManager keeps one password per hotspot
 * profile and restarts the profile to apply a new one, so every joined device
 * drops and has to join again; the UI says so before it asks.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	HotspotConfigInput,
	StatusResponse,
	WifiInterface,
} from "@ceraui/rpc/schemas";

import { osCommand } from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";

import { generateHotspotPassword } from "./hotspot-password";
import { wifiHotspotConfigOpKey } from "./wifi-station-lock";

/**
 * The reconfigure input that changes ONLY the password. `undefined` when the
 * live hotspot is not fully known (no binding token, name or channel), so a
 * partial setup is never written.
 */
export function newHotspotPasswordInput(
	device: string,
	iface: WifiInterface | undefined,
	password: string,
): HotspotConfigInput | undefined {
	const hotspot = iface?.hotspot;
	if (!iface?.incarnation || !hotspot?.name || !hotspot.channel)
		return undefined;
	return {
		device,
		incarnation: iface.incarnation,
		...(iface.radio_identity?.id ? { radio_id: iface.radio_identity.id } : {}),
		name: hotspot.name,
		password,
		channel: hotspot.channel,
		...(hotspot.security !== undefined ? { security: hotspot.security } : {}),
	};
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

/**
 * Dispatch a renewal. Resolves to the password it sent, or `undefined` when
 * nothing was sent. Whether the device applied it arrives later as its
 * `hotspot.config` reply, which settles the keyed op.
 */
export async function renewHotspotPassword(
	device: string,
	iface: WifiInterface | undefined,
	generate: () => string = generateHotspotPassword,
): Promise<string | undefined> {
	const password = generate();
	const input = newHotspotPasswordInput(device, iface, password);
	if (!input) return undefined;
	const sent = await osCommand({
		key: newHotspotPasswordKey(device, iface),
		rpc: () => rpc.wifi.hotspotConfigure(input),
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
	return sent === undefined ? undefined : password;
}
