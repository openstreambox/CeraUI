import { logRedact } from "../../helpers/logger.ts";

/** The only identifier disclosure in a support export is a validated modem TAC. */
export function modemTac(imei: unknown): string | undefined {
	return typeof imei === "string" && /^\d{15}$/.test(imei)
		? imei.slice(0, 8)
		: undefined;
}

interface CarrierSource {
	readonly config?: { readonly apn?: string };
	readonly tac?: string;
}

/** Build from an allowlist, never clone a modem or its credentials. */
export function carrierSupportRows(sources: readonly CarrierSource[]) {
	return sources.slice(0, 64).map((source, index) => {
		const apn = source.config?.apn;
		return {
			modem: index + 1,
			...(apn &&
			apn.length <= 100 &&
			/^[a-zA-Z0-9.-]+$/.test(apn) &&
			!/\d{9}/.test(apn) &&
			logRedact(apn) === apn
				? { apn }
				: {}),
			...(source.tac && /^\d{8}$/.test(source.tac) ? { tac: source.tac } : {}),
		};
	});
}

const WITHHELD = "[REDACTED support log line]";
const CODE_FIELDS = new Set([
	"procedure",
	"reason",
	"code",
	"stage",
	"phase",
	"status",
	"state",
	"module",
]);
const NUMBER_FIELDS = new Set([
	"latency_ms",
	"elapsed_ms",
	"wait_ms",
	"attempt",
	"count",
	"exit_code",
]);
const BOOLEAN_FIELDS = new Set(["ok", "retryable", "available"]);

function safeMetadata(value: unknown, rpc: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, inner] of Object.entries(value)) {
		// RPC payloads and client identity never cross this boundary, even if the
		// producer adds new fields later. Other events retain bounded scalar codes.
		if (rpc && !["procedure", "latency_ms", "ok"].includes(key)) continue;
		if (
			CODE_FIELDS.has(key) &&
			typeof inner === "string" &&
			/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(inner)
		)
			out[key] = inner;
		else if (
			NUMBER_FIELDS.has(key) &&
			typeof inner === "number" &&
			Number.isFinite(inner) &&
			Math.abs(inner) < 100_000_000
		)
			out[key] = inner;
		else if (BOOLEAN_FIELDS.has(key) && typeof inner === "boolean")
			out[key] = inner;
	}
	return out;
}

/** Final structured-record backstop: unknown metadata, request arguments,
 * client addresses, nested payloads and detached JSON fragments are withheld.
 * Preserve the event, severity, timestamp and bounded diagnostic codes instead.
 */
function projectStructuredLine(line: string): string {
	const start = line.indexOf("{");
	if (start < 0)
		return /^\s*["{}[\],]|:\s+["{}[\],]/.test(line) ? WITHHELD : line;
	try {
		const entry = JSON.parse(line.slice(start));
		const msg = entry?.msg ?? entry?.message;
		if (typeof msg !== "string" || msg.length > 4096) return WITHHELD;
		const out: Record<string, unknown> = { msg };
		if (
			typeof entry.ts === "string" &&
			/^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(entry.ts)
		)
			out.ts = entry.ts;
		if (
			["error", "warn", "info", "debug", "verbose", "silly"].includes(
				entry.level,
			)
		)
			out.level = entry.level;
		if (
			typeof entry.module === "string" &&
			/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(entry.module)
		)
			out.module = entry.module;
		const meta = safeMetadata(entry.meta, /^RPC /.test(msg));
		if (Object.keys(meta).length) out.meta = meta;
		return line.slice(0, start) + JSON.stringify(out);
	} catch {
		return WITHHELD;
	}
}

/** Historical journals can contain raw AT/QMI/MBIM payloads and old credentials.
 * Opaque modem traffic is not safe to decode piecemeal at an export boundary.
 */
export function redactSupportJournal(text: string): string {
	return text
		.split("\n")
		.map(projectStructuredLine)
		.map((line) => {
			const sensitive =
				/imei|iccid|imsi|msisdn|own[_. -]?numbers?|phone|cell[_. -]?(?:id|identity)|(?:^|[^a-z0-9])(?:cid|eci|nci|lac|tac|pci|eid|meid|esn)(?:[^a-z0-9]|$)|tracking[_. -]?area|location[_. -]?area|serial|device[_. -]?(?:id|identifier)|subscriber|equipment[_. -]?(?:id|identifier)|password|passwd|passphrase|stream[_. -]?id|psk|username|\bapn\b|\bpin\b|\bpuk\b|token|secret|authorization|bearer\s+[a-z0-9]|LPA:1\$|\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\b|\$[A-Z]{2,8},/i;
			const modemTrace =
				/\[[^\]]*\/at\]|<{3,}|>{3,}|\+C(?:G|E|5G)?REG\s*:|\+QENG\s*:|ModemManager.*<debug>/i;
			const hexDump = /(?:\b[0-9a-f]{2}[:\s-]){7,}[0-9a-f]{2}\b/i;
			const numericIdentity = /\d(?:[\s.-]*\d){8,}/;
			const networkAddress =
				/\b(?:[a-f0-9]{2}:){5}[a-f0-9]{2}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|::[a-f0-9:.]+|(?:[a-f0-9]{1,4}:){7}[a-f0-9]{1,4}/i;
			return sensitive.test(line) ||
				modemTrace.test(line) ||
				hexDump.test(line) ||
				numericIdentity.test(line) ||
				networkAddress.test(line) ||
				logRedact(line) !== line
				? WITHHELD
				: line;
		})
		.join("\n");
}

/** Reserve room under the 10 MiB file ceiling for the bounded carrier summary. */
export function boundSupportJournal(text: string): string {
	const bytes = new TextEncoder().encode(redactSupportJournal(text));
	const limit = 9 * 1024 * 1024;
	if (bytes.byteLength <= limit) return new TextDecoder().decode(bytes);
	return `[Support journal truncated at 9 MiB; newest text retained]\n${new TextDecoder().decode(bytes.subarray(bytes.byteLength - limit))}`;
}
