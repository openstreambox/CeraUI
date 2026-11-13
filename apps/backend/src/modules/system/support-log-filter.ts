import { isIP } from "node:net";
import { logRedact } from "../../helpers/logger.ts";
import { isShapeSource, matchLineShape } from "./support-line-shapes.ts";

export const WITHHELD = "[REDACTED support log line]";
export const MAX_SUPPORT_LINE_BYTES = 8192;

const CODES = new Set([
	"no_route",
	"network_timeout",
	"gsm-registration-denied",
	"missing-or-unknown-apn",
	"start_invalid",
	"capture_source_unavailable",
	"device_busy",
	"engine_unavailable",
	"discovery_failed",
	"read_failed",
	"timeout",
	"exit-code",
	"signal",
	"oom-kill",
	"ENOENT",
	"EACCES",
	"EPERM",
	"EBUSY",
	"EIO",
	"ENOSPC",
	"EPIPE",
	"EINVAL",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"Network timeout",
	"capture device busy",
	"network unavailable",
]);
const STATES = new Set([
	"unknown",
	"unavailable",
	"available",
	"ready",
	"idle",
	"pending",
	"initializing",
	"starting",
	"running",
	"stopping",
	"stopped",
	"connecting",
	"connected",
	"disconnecting",
	"disconnected",
	"failed",
	"registered",
	"searching",
	"denied",
	"input",
	"output",
	"params",
	"prepare",
	"launch",
	"retry",
	"retrying",
	"settled",
	"completed",
	"cancelled",
	"active",
	"inactive",
	"enabled",
	"disabled",
]);
const MODULES = new Set([
	"streaming",
	"streamloop",
	"modems",
	"cellular",
	"network",
	"system",
	"ui",
	"updates",
	"audio",
	"bluetooth",
	"hotspot",
	"srtla",
	"cerastream",
]);
const SIGNALS = new Set([
	"SIGTERM",
	"SIGKILL",
	"SIGINT",
	"SIGHUP",
	"SIGABRT",
	"SIGSEGV",
	"SIGPIPE",
	"SIGQUIT",
	"SIGBUS",
	"SIGILL",
]);
// Words that follow a credential keyword in status text rather than a value.
const EMPTY_VALUES = new Set(
	(
		"missing required unknown unavailable none invalid empty rejected refused " +
		"expired mismatch incorrect wrong changed updated set unset not is was may " +
		"must cannot negotiation exchange management handshake length format error " +
		"failed accepted ok cancelled requested denied locked disabled enabled " +
		"too has and or the a an"
	).split(" "),
);

export function oversizedSupportLine(line: string): boolean {
	// Check length before encoding or running any pattern. Encoding work is bounded.
	return (
		line.length > MAX_SUPPORT_LINE_BYTES ||
		new TextEncoder().encode(line).byteLength > MAX_SUPPORT_LINE_BYTES
	);
}

/** Replace network and hardware address spans while keeping the line. */
function maskAddresses(text: string): string {
	// IPv4 first, so IPv4-mapped IPv6 forms never leave a dotted tail. A port,
	// trailing punctuation or an `addr:` prefix does not hide the address.
	let out = text.replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d)/g, (value) =>
		isIP(value) ? "[address]" : value,
	);
	out = out.replace(
		/(?<![0-9a-z:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%[0-9a-z]{1,16})?/gi,
		(value) => {
			let core = value;
			let tail = "";
			while (core.endsWith(":") && !core.endsWith("::")) {
				core = core.slice(0, -1);
				tail = `:${tail}`;
			}
			return isIP(core.split("%")[0] ?? "") ? `[address]${tail}` : value;
		},
	);
	// MACs with colons or dashes, DHCP client ids, dotted and bare MACs, and
	// interface names derived from a MAC.
	out = out.replace(
		/(?<![0-9a-f:-])[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5,7}(?![0-9a-f:-])/gi,
		"[address]",
	);
	out = out.replace(
		/(?<![0-9a-f.])[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}(?![0-9a-f.])/gi,
		"[address]",
	);
	out = out.replace(/\b(wlx|enx|wwx)[0-9a-f]{12}\b/gi, "$1[address]");
	return out.replace(/(?<![0-9a-z])[0-9a-f]{12}(?![0-9a-z])/gi, "[address]");
}

/** Network and connection names often carry a person's or account's name,
 * and a home SSID can be located through public Wi-Fi maps.
 */
function maskNames(text: string): string {
	return text
		.replace(/\b(ssid=)(["'])[^"'\n]{0,64}\2/gi, "$1$2[name]$2")
		.replace(
			/\b(connection|access point|policy: set) '[^'\n]{0,64}'/gi,
			"$1 '[name]'",
		)
		.replace(/\b(ssid)[ \t]+(?!\[name\])[^\s'"]{1,64}/gi, "$1 [name]");
}

/** Value-bearing fields are withheld while status phrases remain readable. */
export function filterDiagnosticText(
	text: string,
	source?: string,
): string | undefined {
	if (oversizedSupportLine(text)) return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters at the disclosure boundary.
	if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text)) return undefined;
	if (source === "NetworkManager")
		text = text.replace(/\[\d{10}\.\d{3,6}\][ \t]{0,8}/, "");
	if (
		/(?:COMMAND|Environment|ExecStart|ExecStop|argv)\s*[:=]|#!::|\$[A-Z]{2,8},/i.test(
			text,
		)
	)
		return undefined;
	if (
		/\+C(?:G|E|5G)?REG\s*:|\+QENG\s*:|<{3,12}|>{3,12}|\[[^\]\s]{0,80}\/at\][ \t]{0,8}(?:-->|<--)/i.test(
			text,
		)
	)
		return undefined;
	if (source === "ModemManager" && /^<(?:debug|dbg)>/.test(text))
		return undefined;
	if (
		/\b(?:[a-z0-9_.-]{0,32}(?:key|token|secret|password|passwd|passphrase|psk|stream[_.-]?id|username|account)[a-z0-9_.-]{0,24})["']?[ \t]{0,8}[:=][ \t]{0,8}["']?\S/i.test(
			text,
		)
	)
		return undefined;
	// Credentials in prose: "with password …", "stream id live/…", "login for …".
	for (const phrase of text.matchAll(
		/\b(?:pass(?:phrase|word|wd|code)|psk|stream[ _-]?(?:id|key)|key|login|user(?:name)?|account|token|secret)(?:[ \t]{1,4}(?:for|of|is|was|to|as))?[ \t:='"]{1,8}([^\s'",;)\]]{1,128})/gi,
	))
		if (phrase[1] && !EMPTY_VALUES.has(phrase[1].toLowerCase()))
			return undefined;
	if (
		/\b(?:imei|iccid|imsi|msisdn|eid|meid|esn|subscriber(?:id)?|equipment[_. -]?(?:id|identifier)|device[_. -]?(?:id|identifier)|own[_. -]?numbers?|phone(?:number)?)["' \t:=]{1,8}["']?[+a-z0-9][a-z0-9+_.() /-]{3,128}/i.test(
			text,
		)
	)
		return undefined;
	if (
		/\bserial[ _-]*(?:number|no)?[ \t"']{0,8}[:=][ \t"']{0,8}[a-z0-9]{4,80}/i.test(
			text,
		)
	)
		return undefined;
	if (
		/\b(?:pin|puk)[ \t:=]{0,8}\d{4,8}\b|\bapn[ \t"']{0,8}[:=][ \t"']{0,8}\S/i.test(
			text,
		)
	)
		return undefined;
	if (
		/(?:^|[^a-z0-9])(?:cell(?:[_. -]?id|[_. -]?identity)?|ci|cid|eci|nci|lac|tac|tracking[_. -]?area|location[_. -]?area)["' \t:=]{1,8}["']?(?:0x)?[a-f0-9]{4,32}\b/i.test(
			text,
		)
	)
		return undefined;
	if (
		/(?:^|[^a-z])(?:gps[_-]?)?(?:lat(?:itude)?|lon(?:gitude)?|lng)[ \t:=]{1,8}-?\d|(?:^|[^\d])-?\d{1,3}\.\d{4,10}[ \t]{0,3}[,;/ ][ \t]{0,3}-?\d{1,3}\.\d{4,10}/i.test(
			text,
		)
	)
		return undefined;
	if (/(?:\b[a-f0-9]{2}[: \t-]){7,63}[a-f0-9]{2}\b/i.test(text))
		return undefined;
	if (/\bstderr\s*:/i.test(text) || logRedact(text) !== text) return undefined;
	// Replace address and name spans, preserving the surrounding evidence.
	text = maskNames(maskAddresses(text));
	// Named bounded counters are diagnostic quantities. Test the other text for
	// numeric identities without treating byte/packet totals as subscriber ids.
	const numericText = text
		.replace(
			/\b(?:[rt]x[_ -]?)?(?:bytes|packets|counter|uptime)[ \t:=]{1,4}\d{1,12}\b/gi,
			"[counter]",
		)
		.replace(/\b\d{1,12}[ \t]{1,3}(?:bytes|packets)\b/gi, "[counter]");
	if (/\d(?:[ \t.()/+-]{0,3}\d){8,21}/.test(numericText)) return undefined;
	return text;
}

function safeCode(value: unknown): boolean {
	return typeof value === "string"
		? CODES.has(value)
		: typeof value === "number" &&
				Number.isInteger(value) &&
				Math.abs(value) <= 65535;
}

function safeError(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		if (value.length > 300) return undefined;
		const message = filterDiagnosticText(value);
		return message === undefined ? undefined : { message };
	}

	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const error = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (
		typeof error.name === "string" &&
		[
			"Error",
			"TypeError",
			"RangeError",
			"RpcError",
			"RunTimeoutError",
			"SpawnTimeoutError",
			"OsStageError",
		].includes(error.name)
	)
		out.name = error.name;
	if (safeCode(error.code)) out.code = error.code;
	if (typeof error.message === "string" && error.message.length <= 300) {
		const message = filterDiagnosticText(error.message);
		if (message !== undefined) out.message = message;
	}
	return Object.keys(out).length ? out : undefined;
}

function safeMetadata(
	value: unknown,
	procedure: string | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, inner] of Object.entries(value)) {
		if (procedure !== undefined) {
			if (key === "procedure" && inner === procedure) out[key] = inner;
			if (
				key === "latency_ms" &&
				typeof inner === "number" &&
				Number.isFinite(inner) &&
				inner >= 0 &&
				inner <= 300000
			)
				out[key] = inner;
			if (key === "ok" && typeof inner === "boolean") out[key] = inner;
			continue;
		}
		if (["err", "error"].includes(key)) {
			const error = safeError(inner);
			if (error) out[key] = error;
		} else if (["reason", "code"].includes(key) && safeCode(inner))
			out[key] = inner;
		else if (
			key === "reason" &&
			typeof inner === "string" &&
			inner.length <= 300 &&
			inner.includes(" ") &&
			/\b(?:failed|failure|error|denied|busy|timeout|timed out|missing|unavailable|invalid|required|rejected|unreachable|not found|closed|unsupported|refused)\b/i.test(
				inner,
			)
		) {
			const reason = filterDiagnosticText(inner);
			if (reason !== undefined) out.reason = reason;
		} else if (
			["stage", "phase", "status", "state"].includes(key) &&
			typeof inner === "string" &&
			STATES.has(inner)
		)
			out[key] = inner;
		else if (
			["exitCode", "exit_code"].includes(key) &&
			typeof inner === "number" &&
			Number.isInteger(inner) &&
			inner >= 0 &&
			inner <= 255
		)
			out[key] = inner;
		else if (
			key === "signal" &&
			(inner === null ||
				(typeof inner === "string" && SIGNALS.has(inner)) ||
				(typeof inner === "number" &&
					Number.isInteger(inner) &&
					inner > 0 &&
					inner < 128))
		)
			out[key] = inner;
		else if (
			key === "ifname" &&
			typeof inner === "string" &&
			/^(?:wwan|wlan|eth|enp|cdc-wdm)[a-z0-9.-]{0,20}$/.test(inner)
		)
			out[key] = inner;
		else if (
			["latency_ms", "elapsed_ms", "wait_ms", "attempt", "count"].includes(
				key,
			) &&
			typeof inner === "number" &&
			Number.isFinite(inner) &&
			inner >= 0 &&
			inner <= 1000000
		)
			out[key] = inner;
		else if (
			["ok", "retryable", "available"].includes(key) &&
			typeof inner === "boolean"
		)
			out[key] = inner;
	}
	return out;
}

function systemdMessage(message: string): string | undefined {
	const transition =
		/^(Started|Stopped|Starting|Stopping|Reloaded|Reloading) ([a-zA-Z0-9@_.-]{1,128}\.(?:service|target|scope|socket))\b/.exec(
			message,
		);
	if (transition) return `${transition[1]} ${transition[2]}`;
	if (
		/^[a-zA-Z0-9@_.-]{1,128}\.(?:service|scope|slice): (?:Main process exited,|Failed with result |Killing process |A process of this unit has been killed by the OOM killer|Consumed |Start request repeated too quickly|Scheduled restart job)/.test(
			message,
		)
	)
		return message;
	return undefined;
}

function redactSupportRecord(
	message: string,
	source: "ceralive" | "systemd",
): string {
	if (oversizedSupportLine(message)) return WITHHELD;
	if (source === "systemd")
		return filterDiagnosticText(systemdMessage(message) ?? "") || WITHHELD;
	const trimmed = message.trimStart();
	if (trimmed.startsWith("{")) {
		try {
			const entry = JSON.parse(trimmed);
			const raw = entry?.msg ?? entry?.message;
			if (typeof raw !== "string" || raw.length > 4096) return WITHHELD;
			const msg = filterDiagnosticText(raw, source);
			if (msg === undefined) return WITHHELD;
			const out: Record<string, unknown> = { msg };
			if (
				typeof entry.ts === "string" &&
				/^\d{4}-\d\d-\d\dT[0-9:.]{8,20}Z$/.test(entry.ts)
			)
				out.ts = entry.ts;
			if (
				["error", "warn", "info", "debug", "verbose", "silly"].includes(
					entry.level,
				)
			)
				out.level = entry.level;
			if (typeof entry.module === "string" && MODULES.has(entry.module))
				out.module = entry.module;
			const rpc = /^RPC ([a-zA-Z][a-zA-Z0-9_.]{0,79}) (?:ok|err)$/.exec(msg);
			const meta = safeMetadata(entry.meta, rpc?.[1]);
			if (Object.keys(meta).length) out.meta = meta;
			return JSON.stringify(out);
		} catch {
			return WITHHELD;
		}
	}
	if (/^["{}[\],]/.test(trimmed)) return WITHHELD;
	if (
		source === "ceralive" &&
		!/^streamloop: [a-z_.-]{1,32} exited \(code=(?:-?\d{1,3}|null), signal=(?:SIG[A-Z]{1,10}|null)\)$/.test(
			message,
		)
	)
		return WITHHELD;
	return filterDiagnosticText(message, source) ?? WITHHELD;
}

/** Render one admitted record's message for its trusted source. */
export function renderSourceMessage(source: string, message: string): string {
	if (oversizedSupportLine(message)) return WITHHELD;
	if (isShapeSource(source)) {
		const shaped = matchLineShape(source, message);
		if (shaped === undefined) return WITHHELD;
		return filterDiagnosticText(shaped, source) ?? WITHHELD;
	}
	if (source === "ceralive" || source === "systemd")
		return redactSupportRecord(message, source);
	return WITHHELD;
}
