import { isIPv4 } from "node:net";
import type { RequestedFamily, TransportMode } from "./subscription-policy.ts";

export interface ModemTransportIdentity {
	readonly model: string;
	readonly firmware: string;
	readonly mode: TransportMode;
}
export interface TransportQuirk {
	readonly owner: "network-manager" | "internal-call";
	readonly qmapReadback: boolean;
	readonly rawIpBeforeCall: boolean;
}

/** Exact firmware admission; this table chooses transport, never carrier/APN. */
export function resolveTransportQuirk(
	identity: ModemTransportIdentity,
): TransportQuirk | undefined {
	if (
		identity.model === "RM520N-GL" &&
		identity.firmware === "RM520NGLAAR01A08M4G" &&
		identity.mode === "qmi"
	) {
		return {
			owner: "network-manager",
			qmapReadback: true,
			rawIpBeforeCall: true,
		};
	}
	if (
		identity.model === "DW5821e Snapdragon X20 LTE" &&
		identity.firmware === "T77W968.F1.0.0.4.2.GC.010\n026" &&
		identity.mode === "mbim"
	) {
		return {
			owner: "network-manager",
			qmapReadback: false,
			rawIpBeforeCall: false,
		};
	}
	if (
		identity.model === "FM350-GL" &&
		identity.firmware === "81600.0000.00.29.18.01" &&
		identity.mode === "rndis"
	) {
		return {
			owner: "internal-call",
			qmapReadback: false,
			rawIpBeforeCall: false,
		};
	}
	return undefined;
}

export interface SerialEndpoint {
	readonly port: string;
	readonly usbDevice: string;
	readonly usbInterface: string;
	readonly generation: string;
}

/** Rediscover by USB interface, even when the kernel assigns a different tty. */
export function selectSerialEndpoint(
	endpoints: readonly SerialEndpoint[],
	expected: Omit<SerialEndpoint, "port">,
): SerialEndpoint | undefined {
	const matches = endpoints.filter(
		(endpoint) =>
			endpoint.usbDevice === expected.usbDevice &&
			endpoint.usbInterface === expected.usbInterface &&
			endpoint.generation === expected.generation,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

/** Whole CSV fields only: a 16-octet dotted IPv6 representation is not IPv4. */
export function parseInternalIpv4Grant(
	reply: string,
	contextId: number,
): string | undefined {
	if (!Number.isSafeInteger(contextId) || contextId < 1) return undefined;
	const addresses = new Set<string>();
	for (const line of reply.split(/\r?\n/)) {
		const match = /^\+CGPADDR:\s*(\d+)\s*,(.*)$/.exec(line.trim());
		if (!match || Number(match[1]) !== contextId) continue;
		// CGPADDR fields are unquoted or quoted addresses; reject malformed CSV.
		const fields = match[2]?.split(",") ?? [];
		for (const field of fields) {
			const trimmed = field.trim();
			if (!/^(?:"[^"\r\n]*"|[^",\r\n]*)$/.test(trimmed)) return undefined;
			const value =
				trimmed.startsWith('"') && trimmed.endsWith('"')
					? trimmed.slice(1, -1)
					: trimmed;
			if (isIPv4(value) && value !== "0.0.0.0") addresses.add(value);
		}
	}
	return addresses.size === 1 ? [...addresses][0] : undefined;
}

export function parseQmapAutoConnect(reply: string): number | undefined {
	const matches = [
		...reply.matchAll(/^\+QMAP:\s*"auto_connect",0,(\d+)\s*$/gm),
	];
	if (matches.length !== 1) return undefined;
	const value = Number(matches[0]?.[1]);
	return Number.isSafeInteger(value) ? value : undefined;
}

export interface InitialEpsSettings {
	readonly apn: string;
	readonly family: RequestedFamily;
}
export type InitialEpsDecision = "aligned" | "baseline-and-attempt" | "blocked";

/** The owner must persist baseline AND attempted before any setter, including failed setters. */
export function decideInitialEps(
	current: InitialEpsSettings | undefined,
	desired: InitialEpsSettings,
	attempted: boolean,
	allowIpv6Grant: boolean,
): InitialEpsDecision {
	if (
		current?.apn === desired.apn &&
		(current.family === desired.family ||
			(allowIpv6Grant &&
				desired.family === "ipv4v6" &&
				current.family === "ipv6"))
	)
		return "aligned";
	return attempted ? "blocked" : "baseline-and-attempt";
}
