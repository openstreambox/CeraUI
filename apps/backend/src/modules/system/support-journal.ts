import {
	oversizedSupportLine,
	redactSupportRecord,
	WITHHELD,
} from "./support-log-filter.ts";

const UNITS: Readonly<Record<string, string>> = {
	"ceralive.service": "ceralive",
	"ModemManager.service": "ModemManager",
	"NetworkManager.service": "NetworkManager",
	"wpa_supplicant.service": "wpa_supplicant",
	"hostapd.service": "hostapd",
};

function field(record: Record<string, unknown>, name: string): string {
	// journalctl renders binary or oversized fields as arrays or null. Treat any
	// non-string as absent so malformed records are withheld, never coerced.
	const value = record[name];
	return typeof value === "string" ? value : "";
}

function recordSource(record: Record<string, unknown>): string | undefined {
	// These trusted journal fields cannot be set by a message body. Child sudo
	// and audit records are excluded even when they inherit an allowed unit.
	if (
		"SYSLOG_IDENTIFIER" in record &&
		typeof record.SYSLOG_IDENTIFIER !== "string"
	)
		return undefined;
	if (
		["sudo", "audit", "auditd"].includes(field(record, "SYSLOG_IDENTIFIER")) ||
		["sudo", "auditd"].includes(field(record, "_COMM"))
	)
		return undefined;
	if (record._TRANSPORT === "kernel") return "kernel";
	if (
		record._PID === "1" &&
		record.SYSLOG_IDENTIFIER === "systemd" &&
		record._SYSTEMD_UNIT === "init.scope"
	)
		return "systemd";
	if (typeof record._SYSTEMD_UNIT !== "string") return undefined;
	const source = UNITS[record._SYSTEMD_UNIT];
	return typeof source === "string" ? source : undefined;
}

function timestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined;
	const millis = Number(value) / 1000;
	if (!Number.isFinite(millis) || millis < 0 || millis > 253402300799999)
		return undefined;
	return new Date(millis).toISOString();
}

/** Read JSON journal records so source admission uses trusted metadata.
 * Hostnames, raw boot ids, pids and stream ids are never rendered.
 */
export function renderSupportJournal(text: string): string {
	const interrupted = new Set<string>();
	const boots = new Map<string, number>();
	const rendered = text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			// A journal envelope can escape an up-to-48 KiB MESSAGE. Parse a bounded
			// envelope to retain trusted stream/line-break fields, never regex-match it.
			// If even this envelope bound is exceeded, subsequent framing is uncertain.
			if (line.length > 512 * 1024) {
				interrupted.add("unknown");
				return WITHHELD;
			}
			let record: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
					return WITHHELD;
				record = parsed as Record<string, unknown>;
			} catch {
				return WITHHELD;
			}
			const source = recordSource(record);
			if (!source || typeof record.MESSAGE !== "string") return WITHHELD;
			const stream =
				typeof record._STREAM_ID === "string" && record._STREAM_ID.length <= 128
					? record._STREAM_ID
					: `${source}:${typeof record._PID === "string" && record._PID.length <= 10 ? record._PID : "unknown"}`;
			const cut = ["line-max", "pid-change"].includes(
				field(record, "_LINE_BREAK"),
			);
			if (interrupted.has("unknown")) return WITHHELD;
			const continuation = interrupted.has(stream);
			if (cut) interrupted.add(stream);
			if (continuation && !cut) {
				interrupted.delete(stream);
			}
			if (
				cut ||
				continuation ||
				oversizedSupportLine(line) ||
				oversizedSupportLine(record.MESSAGE) ||
				/\baudit(?:\[|:|\()/i.test(record.MESSAGE)
			)
				return WITHHELD;
			// Embedded line breaks can be raw continuation chunks. A single compact
			// structured event is the supported application-log representation.
			if (record.MESSAGE.includes("\n") || record.MESSAGE.includes("\r"))
				return WITHHELD;
			const filtered = redactSupportRecord(record.MESSAGE, source);
			if (filtered === WITHHELD) return WITHHELD;
			const time = timestamp(record.__REALTIME_TIMESTAMP);
			let boot: number | undefined;
			if (typeof record._BOOT_ID === "string") {
				boot = boots.get(record._BOOT_ID);
				if (boot === undefined) {
					boot = boots.size + 1;
					boots.set(record._BOOT_ID, boot);
				}
			}
			return `${boot ? `[boot ${boot}] ` : ""}${time ? `${time} ` : ""}${source}: ${filtered}`;
		});
	return collapseWithheld(rendered).join("\n");
}

/** Unnamed sources are withheld wholesale; one counted marker per run keeps
 * the system log readable while still showing where records were removed.
 */
function collapseWithheld(lines: readonly string[]): string[] {
	const out: string[] = [];
	let run = 0;
	const flush = () => {
		if (run === 1) out.push(WITHHELD);
		else if (run > 1) out.push(`[REDACTED ${run} support log lines]`);
		run = 0;
	};
	for (const line of lines) {
		if (line === WITHHELD) run++;
		else {
			flush();
			out.push(line);
		}
	}
	flush();
	return out;
}

/** Dev hosts supply the same trusted-source shape, with an explicit mock label. */
export function mockSupportJournal(
	lines: readonly string[],
	service?: string,
): string {
	const header = service
		? `-- Logs begin for unit ${service} (CeraUI mock journal) --`
		: "-- Logs begin, full CeraUI system journal (mock) --";
	return [
		JSON.stringify({
			_SYSTEMD_UNIT: "ceralive.service",
			MESSAGE: JSON.stringify({ msg: header }),
		}),
		...lines.map((line) =>
			JSON.stringify({ _SYSTEMD_UNIT: "ceralive.service", MESSAGE: line }),
		),
	].join("\n");
}
