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

/** Phone-only remote status is allowlisted; encoder status keeps its existing contract. */
export function projectRemoteStatus(
	payload: unknown,
	phoneBox = false,
): unknown {
	if (phoneBox && (typeof payload !== "object" || payload === null))
		return { phone_box: true };
	if (
		typeof payload === "object" &&
		payload !== null &&
		(phoneBox || ("phone_box" in payload && payload.phone_box === true))
	) {
		const source = payload as Record<string, unknown>;
		return {
			phone_box: true,
			carrying: source.carrying,
			box_health: source.box_health,
			phone_links: source.phone_links,
		};
	}

	if (
		typeof payload !== "object" ||
		payload === null ||
		!("wifi" in payload) ||
		typeof payload.wifi !== "object" ||
		payload.wifi === null
	) {
		return payload;
	}

	return {
		...payload,
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

/** Every phone-box remote frame uses backend identity, including partial frames. */
export function projectPhoneFrame(
	type: string,
	payload: unknown,
	phoneBox: boolean,
): unknown {
	if (!phoneBox)
		return type === "config"
			? projectRemoteConfig(payload)
			: projectRemoteStatus(payload);
	return type === "status" ? projectRemoteStatus(payload, true) : undefined;
}
