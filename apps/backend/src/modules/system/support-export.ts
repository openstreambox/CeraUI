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

/** RPC's cid is a request correlation id, not a cellular identity. Remove it
 * before the conservative cell-id filter so the diagnostic event stays useful.
 * This grants no disclosure exception: the correlation value is always dropped.
 */
function withoutRpcCorrelation(line: string): string {
	try {
		const start = line.indexOf("{");
		if (start < 0) return line;
		const entry = JSON.parse(line.slice(start));
		if (
			typeof entry?.msg === "string" &&
			/^RPC [a-zA-Z0-9_.]+ (?:ok|err)$/.test(entry.msg) &&
			entry.meta &&
			typeof entry.meta === "object" &&
			!Array.isArray(entry.meta)
		) {
			delete entry.meta.cid;
			return line.slice(0, start) + JSON.stringify(entry);
		}
	} catch {
		// Journald text and non-JSON device logs follow the same filter below.
	}
	return line;
}

/** Fail closed for whole diagnostic lines carrying identifiers or credentials.
 * Historical journals predate current logger redaction. Long numeric runs are
 * removed even without a field label; APN/TAC come only from the allowlist above.
 */
export function redactSupportJournal(text: string): string {
	return text
		.split("\n")
		.map(withoutRpcCorrelation)
		.map((line) =>
			/imei|iccid|imsi|msisdn|own[_. -]?numbers?|phone|cell[_. -]?(?:id|identity)|(?:^|[^a-z0-9])(?:cid|eci|nci|lac|tac|pci|eid|meid|esn)(?:[^a-z0-9]|$)|tracking[_. -]?area|location[_. -]?area|serial|device[_. -]?(?:id|identifier)|subscriber|equipment[_. -]?(?:id|identifier)|password|passwd|username|\bapn\b|\bpin\b|\bpuk\b|token|secret|authorization|bearer\s+[a-z0-9]|LPA:1\$|\d{9}|\+\d[\d ()-]{6}/i.test(
				line,
			) || logRedact(line) !== line
				? "[REDACTED support log line]"
				: line,
		)
		.join("\n");
}

/** Reserve room under the 10 MiB file ceiling for the bounded carrier summary. */
export function boundSupportJournal(text: string): string {
	const bytes = new TextEncoder().encode(redactSupportJournal(text));
	const limit = 9 * 1024 * 1024;
	if (bytes.byteLength <= limit) return new TextDecoder().decode(bytes);
	return `[Support journal truncated at 9 MiB; newest text retained]\n${new TextDecoder().decode(bytes.subarray(bytes.byteLength - limit))}`;
}
