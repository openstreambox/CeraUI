function omitIncarnation(value: unknown): unknown {
	if (
		typeof value !== "object" ||
		value === null ||
		!("incarnation" in value)
	) {
		return value;
	}
	const { incarnation: _incarnation, ...legacy } = value;
	return legacy;
}

/** Keep unmodified frames by reference so their serialized bytes stay intact. */
export function projectRemoteWifiFrame(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	let projected = payload;
	if ("adapter_mode" in payload) {
		const mode = omitIncarnation(payload.adapter_mode);
		if (mode !== payload.adapter_mode) {
			projected = { ...projected, adapter_mode: mode };
		}
	}
	if (
		"hotspot" in payload &&
		typeof payload.hotspot === "object" &&
		payload.hotspot !== null &&
		"config" in payload.hotspot
	) {
		const config = omitIncarnation(payload.hotspot.config);
		if (config !== payload.hotspot.config) {
			projected = {
				...projected,
				hotspot: { ...payload.hotspot, config },
			};
		}
	}
	return projected;
}

/** Only the internal pairing seed is withheld from authenticated remote config. */
export function projectRemoteConfig(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	if (!("pairing_secret" in payload)) return payload;
	const config = { ...payload };
	Reflect.deleteProperty(config, "pairing_secret");
	return config;
}

/**
 * Remote status retains credentials and omits only local radio lifetime tokens.
 * The USB tree is local. A later counts-only devices case is the remote form.
 */
export function projectRemoteStatus(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const hasUsbDevices = "usb_devices" in payload;
	const wifi = "wifi" in payload ? payload.wifi : undefined;
	if (!hasUsbDevices && (typeof wifi !== "object" || wifi === null)) {
		return payload;
	}

	const projected: Record<string, unknown> = { ...payload };
	if (hasUsbDevices) Reflect.deleteProperty(projected, "usb_devices");
	if (typeof wifi === "object" && wifi !== null) {
		projected.wifi = Array.isArray(wifi)
			? wifi.map(omitIncarnation)
			: Object.fromEntries(
					Object.entries(wifi).map(([id, iface]) => [
						id,
						omitIncarnation(iface),
					]),
				);
	}
	return projected;
}

/** The bytes the cloud remote socket sends. Local status keeps usb_devices. */
export function serializeRemoteSocketMessage(data: string): string {
	const frame: Record<string, unknown> = JSON.parse(data);
	let projected =
		frame.status === undefined
			? frame
			: { ...frame, status: projectRemoteStatus(frame.status) };
	const config = projectRemoteConfig(frame.config);
	if (config !== frame.config) projected = { ...projected, config };
	const wifi = projectRemoteWifiFrame(frame.wifi);
	if (wifi !== frame.wifi) projected = { ...projected, wifi };
	return projected === frame ? data : JSON.stringify(projected);
}
