import {
	connectionStatusSchema,
	streamProfileIdSchema,
} from "@ceraui/rpc/schemas";

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
const interfaceLabels = new Map<string, string>();
function interfaceLabel(original: unknown, fallback?: string): string {
	if (typeof original !== "string") return fallback ?? "Link";
	let name = interfaceLabels.get(original);
	if (!name) {
		name = fallback ?? label("Link", original);
		interfaceLabels.set(original, name);
	}
	return name;
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
					label("Wi-Fi", key),
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
										id: label("Link", String(row.id ?? i)),
										iface: interfaceLabel(row.iface, label("Link", String(i))),
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
		case "status":
			return projectRemoteStatus(v);
		case "config":
			return v === null ? {} : projectRemoteConfig(v);
		case "netif":
			return rows(v, "Link", (row) => ({
				...numbers(row, ["tp", "tx_bps", "rx_bps"]),
				...booleans(row, ["enabled"]),
			}));
		case "modems":
			return modems(v);
		case "sensors":
			return {}; // formatted free text, including ingest names
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
