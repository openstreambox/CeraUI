import { createHmac, randomBytes } from "node:crypto";
import {
	connectionStatusSchema,
	streamProfileIdSchema,
} from "@ceraui/rpc/schemas";

import { projectLegacyNotification } from "./legacy-notification-dto.ts";

/** Outbound status is a separate public DTO. No producer objects are spread. */
type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
	v !== null && typeof v === "object" ? (v as Row) : {};
const numbers = (v: unknown, keys: readonly string[]): Row => {
	const src = object(v),
		out: Row = {};
	for (const key of keys)
		if (typeof src[key] === "number" && Number.isFinite(src[key]))
			out[key] = src[key];
	return out;
};
const booleans = (v: unknown, keys: readonly string[]): Row => {
	const src = object(v),
		out: Row = {};
	for (const key of keys)
		if (typeof src[key] === "boolean") out[key] = src[key];
	return out;
};
const choice = (v: unknown, values: readonly string[]) =>
	typeof v === "string" && values.includes(v) ? v : undefined;

/** One namespace shared by legacy and cloud status for the lifetime of this process.
 * Original identifiers remain local. Labels are not authority for mutations.
 */
const labels = new Map<string, Map<string, string>>();
function label(kind: string, key: string): string {
	let group = labels.get(kind);
	if (!group) {
		group = new Map();
		labels.set(kind, group);
	}
	let value = group.get(key);
	if (!value) {
		value = `${kind} ${group.size + 1}`;
		group.set(key, value);
	}
	return value;
}
// Interface labels never depend on the position in a bond or adapter roster.
function interfaceLabel(original: unknown, _fallback?: string): string {
	return label("Link", typeof original === "string" ? original : "unknown");
}
const rowKey = randomBytes(32);
function opaqueRow(kind: string, value: unknown): string {
	return createHmac("sha256", rowKey)
		.update(`${kind}:${String(value)}`)
		.digest("hex");
}
function rows(
	v: unknown,
	kind: string,
	project: (v: Row, key: string) => Row,
): Row {
	const out: Row = {};
	for (const [key, value] of Object.entries(object(v))) {
		if (value === null || typeof value !== "object") continue;
		const name = kind === "Link" ? interfaceLabel(key) : label(kind, key);
		out[name] = project(object(value), name);
	}
	return out;
}
function wifi(v: unknown): Row {
	return rows(v, "Wi-Fi", (row, name) => ({
		ifname: interfaceLabel(row.ifname, name),
		hw: name,
		conn:
			typeof row.conn === "string" && row.conn
				? label("Profile", row.conn)
				: "",
		saved: Object.fromEntries(
			Object.entries(object(row.saved))
				.filter(([, value]) => typeof value === "string")
				.map(([key, value]) => [
					label("Network", key),
					label("Profile", String(value)),
				]),
		),
		...booleans(row, ["supports_hotspot", "supports_ap_sta_concurrency"]),
		...(choice(row.mode, ["station", "hotspot"]) ? { mode: row.mode } : {}),
		...(row.hotspot
			? {
					hotspot: {
						name: "Hotspot",
						...numbers(row.hotspot, ["max_width_mhz"]),
						available_channels: {},
					},
				}
			: {}),
		// Saved/nearby profiles are local management data, not remote diagnostics.
		available: [],
	}));
}
function modems(v: unknown): Row {
	return rows(v, "Modem", (row, name) => ({
		name,
		ifname: interfaceLabel(row.ifname, name),
		status: {
			...numbers(row.status, ["signal"]),
			...booleans(row.status, ["roaming"]),
			connection: connectionStatusSchema.safeParse(
				object(row.status).connection,
			).success
				? object(row.status).connection
				: "unknown",
			network_type:
				choice(object(row.status).network_type, [
					"2g",
					"3g",
					"4g",
					"5g",
					"lte",
					"2G",
					"3G",
					"4G",
					"5G",
					"LTE",
					"LTE-A",
					"5G NSA",
					"5G SA",
				]) ?? "unknown",
		},
	}));
}
export function projectRemoteConfig(v: unknown): unknown {
	if (v === undefined || v === null) return v;
	return {
		...numbers(v, [
			"max_br",
			"srt_latency",
			"delay",
			"bitrate_overlay",
			"slot",
		]),
		...booleans(v, ["fec_enabled", "autostart", "dhcp", "roaming"]),
		...(Array.isArray(object(v).bands)
			? {
					bands: (object(v).bands as unknown[]).filter(
						(n) =>
							typeof n === "number" &&
							Number.isSafeInteger(n) &&
							n >= 0 &&
							n <= 1024,
					),
				}
			: {}),
	};
}
export function projectRemoteWifiFrame(_v: unknown): unknown {
	return {};
}
export function projectRemoteStatus(v: unknown): unknown {
	if (v === undefined) return undefined;
	const src = object(v),
		out: Row = {
			remote_status: true,
			...booleans(src, [
				"is_streaming",
				"cellular_initializing",
				"set_password",
			]),
		};
	const lifecycle = choice(src.stream_lifecycle, [
		"idle",
		"starting",
		"streaming",
		"reconfiguring",
		"stopping",
		"stop_failed",
		"reconciling",
	]);
	if (lifecycle !== undefined) out.stream_lifecycle = lifecycle;
	out.remote_diagnostics = {
		...booleans(src, ["policy_route_missing"]),
		...(src.asrcs !== undefined
			? { audio_present: Array.isArray(src.asrcs) && src.asrcs.length > 0 }
			: {}),
		...(src.audio_sources !== undefined
			? {
					audio_sources_present:
						Array.isArray(src.audio_sources) && src.audio_sources.length > 0,
				}
			: {}),
		...(src.ssh !== undefined
			? { ssh: booleans(src.ssh, ["active", "enabled", "user_pass"]) }
			: {}),
		...(src.relay !== undefined
			? { relay: booleans(src.relay, ["active", "connected", "enabled"]) }
			: {}),
		...(src.available_updates !== undefined
			? {
					updates_available:
						typeof src.available_updates === "object" &&
						src.available_updates !== null &&
						Number(object(src.available_updates).package_count) > 0,
				}
			: {}),
		...(src.updating !== undefined
			? { updating: src.updating !== false && src.updating !== null }
			: {}),
		...(src.update_state !== undefined
			? {
					update_state: choice(object(src.update_state).kind, [
						"idle",
						"checking",
						"available",
						"downloading",
						"installing",
						"check_failed",
						"update_preflight_failed",
						"success",
						"failed",
					]),
				}
			: {}),
	};
	if (Object.keys(object(out.remote_diagnostics)).length === 0)
		delete out.remote_diagnostics;
	if (src.bond_mapping !== undefined)
		out.bond_mapping =
			src.bond_mapping === null
				? null
				: {
						state: choice(object(src.bond_mapping).state, [
							"active",
							"absent",
							"degraded",
						]),
						disposition: choice(object(src.bond_mapping).disposition, [
							"mapped",
							"retained_last_valid",
							"legacy_unique_only",
							"startup_collision_excluded",
						]),
						source: choice(object(src.bond_mapping).source, [
							"sender",
							"writer",
						]),
						...(choice(object(src.bond_mapping).reason, [
							"hash_mismatch",
							"malformed",
							"unknown_iface",
							"retry_exhausted",
							"missing_file",
							"unreadable",
							"unsupported",
						])
							? { reason: object(src.bond_mapping).reason }
							: {}),
					};
	if (src.wifi !== undefined) out.wifi = wifi(src.wifi);
	if (src.modems !== undefined) out.modems = modems(src.modems);
	for (const [key, numeric, flags] of [
		["engine_bitrate", ["applied_kbps", "ceiling_kbps"], []],
		[
			"buffering",
			["spooled_bytes", "data_headroom_bytes"],
			["active", "disk_warning"],
		],
	] as const)
		if (src[key] !== undefined)
			out[key] =
				src[key] === null
					? null
					: { ...numbers(src[key], numeric), ...booleans(src[key], flags) };
	if (src.linkTelemetry !== undefined) {
		const t = object(src.linkTelemetry);
		out.linkTelemetry =
			src.linkTelemetry === null
				? null
				: {
						...numbers(t, ["measured_bps", "bytes_sent_total", "lastReadMs"]),
						links: Array.isArray(t.links)
							? t.links.map((raw, i) => {
									const row = object(raw);
									return {
										conn_id: opaqueRow(
											"connection",
											row.link_id ?? row.iface ?? row.conn_id ?? i,
										),
										...(typeof row.link_id === "string"
											? { link_id: opaqueRow("physical", row.link_id) }
											: {}),
										iface: interfaceLabel(row.iface),
										...numbers(row, [
											"rtt_ms",
											"nak_count",
											"weight_percent",
											"bitrate_bps",
											"bytes_sent_total",
										]),
										...booleans(row, ["stale"]),
									};
								})
							: [],
					};
	}
	return out;
}
/** Unknown message types and fields fail closed, including direct command replies. */
export function projectRemotePayload(type: string, v: unknown): unknown {
	switch (type) {
		case "notification":
			return projectLegacyNotification(v);
		case "telemetry":
			return {
				samples: Array.isArray(object(v).samples)
					? (object(v).samples as unknown[]).map((raw) => ({
							linkId: interfaceLabel(object(raw).linkId),
							...numbers(raw, [
								"rttMs",
								"nakCount",
								"weightPercent",
								"packetLoss",
								"jitterMs",
								"tsMs",
							]),
						}))
					: [],
			};
		case "pipelines":
			return { present: Object.keys(object(object(v).pipelines)).length > 0 };
		case "sources":
		case "acodecs":
		case "relays":
			return { present: Object.keys(object(v)).length > 0 };
		case "status":
			return projectRemoteStatus(v);
		case "config":
			return v === null ? {} : projectRemoteConfig(v);
		case "netif":
			return rows(v, "Link", (row) => ({
				...numbers(row, ["tp", "tx_bps", "rx_bps"]),
				...booleans(row, ["enabled"]),
				...(row.error === "policy_route_missing"
					? { error: "policy_route_missing" }
					: {}),
			}));
		case "modems":
			return modems(v);
		case "sensors":
			return Object.fromEntries(
				Object.entries(object(v)).filter(
					([key, value]) =>
						["SoC temperature", "SoC voltage", "SoC current"].includes(key) &&
						typeof value === "string" &&
						/^-?\d+(?:\.\d+)? (?:°C|V|A)$/.test(value),
				),
			);
		case "device-stats":
			return numbers(v, [
				"cpuLoad1",
				"socTemp",
				"memTotalBytes",
				"memAvailableBytes",
			]);
		case "device.activeProfile": {
			const c = object(object(v).config);
			return {
				config: {
					...(streamProfileIdSchema.safeParse(c.presetId).success
						? { presetId: c.presetId }
						: {}),
					...numbers(c, ["latencyMs"]),
					...booleans(c, ["fecEnabled"]),
					recoveryMode:
						choice(c.recoveryMode, ["standard", "bandwidth-saver"]) ??
						"standard",
				},
			};
		}
		// Notification free text must use the dedicated notification projection.
		default:
			return undefined;
	}
}
export function projectRemoteLegacyFrame(v: unknown): Row {
	const src = object(v),
		out: Row = {};
	for (const [type, payload] of Object.entries(src)) {
		const projected = projectRemotePayload(type, payload);
		if (projected !== undefined) out[type] = projected;
	}
	if (
		typeof src.seq === "number" &&
		Number.isSafeInteger(src.seq) &&
		src.seq >= 0
	)
		out.seq = src.seq;
	return out;
}
