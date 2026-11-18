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
 * Remote access is reported to a cloud remote as its state word only. The
 * device's name and address on the owner's private network stay local.
 */
function projectRemoteTailscale(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("state" in value)) {
		return value;
	}
	return { state: value.state };
}

/** Remote status retains credentials and omits only local radio lifetime tokens. */
export function projectRemoteStatus(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	let projected = payload;
	if ("tailscale" in payload) {
		projected = {
			...projected,
			tailscale: projectRemoteTailscale(payload.tailscale),
		};
	}
	if (
		!("wifi" in payload) ||
		typeof payload.wifi !== "object" ||
		payload.wifi === null
	) {
		return projected;
	}

	return {
		...projected,
		wifi: Array.isArray(payload.wifi)
			? payload.wifi.map(omitIncarnation)
			: Object.fromEntries(
					Object.entries(payload.wifi).map(([id, iface]) => [
						id,
						omitIncarnation(iface),
					]),
				),
	};
}
