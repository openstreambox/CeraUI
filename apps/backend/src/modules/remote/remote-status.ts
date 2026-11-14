import { publicSrtConfig } from "../../helpers/srt-secret-redaction.ts";
import { publicStreamIds } from "../../helpers/stream-id-secret.ts";

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

/** Withhold pairing, Stream ID and encryption credentials from remote config. */
export function projectRemoteConfig(payload: unknown): unknown {
	payload = publicSrtConfig(payload);
	if (typeof payload !== "object" || payload === null) return payload;
	const projected =
		"srt_streamid" in payload || "relay_streamid_override" in payload
			? publicStreamIds(payload)
			: payload;
	if (!("pairing_secret" in projected)) return projected;
	const config = { ...projected };
	Reflect.deleteProperty(config, "pairing_secret");
	return config;
}

/** Remote status retains credentials and omits only local radio lifetime tokens. */
export function projectRemoteStatus(payload: unknown): unknown {
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
