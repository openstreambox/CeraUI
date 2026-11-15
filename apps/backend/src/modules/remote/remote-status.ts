import { publicSrtConfig } from "../../helpers/srt-secret-redaction.ts";

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

// The local app gets `*_configured` flags for its Stream ID field. Remote
// viewers need stream health, not whether a publish key is saved, so they
// get neither the IDs nor the flags.
const REMOTE_CONFIG_WITHHELD = [
	"pairing_secret",
	"srt_streamid",
	"relay_streamid_override",
	"srt_streamid_configured",
	"relay_streamid_override_configured",
] as const;

/** Withhold pairing, Stream ID and encryption credentials, and whether a Stream ID is saved, from remote config. */
export function projectRemoteConfig(payload: unknown): unknown {
	payload = publicSrtConfig(payload);
	if (typeof payload !== "object" || payload === null) return payload;
	if (!REMOTE_CONFIG_WITHHELD.some((key) => key in payload)) return payload;
	const config = { ...payload };
	for (const key of REMOTE_CONFIG_WITHHELD) Reflect.deleteProperty(config, key);
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
