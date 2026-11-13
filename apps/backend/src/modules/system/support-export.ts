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

export { redactSupportJournal } from "./support-log-filter.ts";

/** Reserve room under the 10 MiB file ceiling for the bounded carrier summary. */
export function boundRedactedSupportJournal(redactedText: string): string {
	const bytes = new TextEncoder().encode(redactedText);
	const limit = 9 * 1024 * 1024;
	if (bytes.byteLength <= limit) return new TextDecoder().decode(bytes);
	return `[Support journal truncated at 9 MiB; newest text retained]\n${new TextDecoder().decode(bytes.subarray(bytes.byteLength - limit))}`;
}
