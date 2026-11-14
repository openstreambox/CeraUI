import { isIPv4, isIPv6 } from "node:net";
import { parseIpv6 } from "../network/nat64.ts";
import type {
	ObservedGrant,
	RequestedFamily,
	TransportMode,
} from "./subscription-policy.ts";

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

export type InternalRegistration =
	| "home"
	| "roaming"
	| "not-registered"
	| "unknown";
export function parseInternalRegistration(reply: string): InternalRegistration {
	const lines = reply
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("+CEREG:"));
	if (lines.length !== 1) return "unknown";
	const match = /^\+CEREG:\s*([0-5]),\s*(\d{1,2})(?:,[^\r\n]*)?$/.exec(
		lines[0] ?? "",
	);
	if (!match) return "unknown";
	const state = Number(match[2]);
	return state === 1
		? "home"
		: state === 5
			? "roaming"
			: state <= 10
				? "not-registered"
				: "unknown";
}
export interface InternalGrant {
	readonly family: ObservedGrant;
	readonly ipv4?: string;
	readonly ipv6?: string;
}
function contextFields(
	reply: string,
	prefix: string,
	cid: number,
): string[] | undefined {
	if (!Number.isInteger(cid) || cid < 1 || cid > 16) return undefined;
	const rows = reply
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith(`${prefix}:`));
	const matches: string[][] = [];
	for (const row of rows) {
		const raw = row
			.slice(prefix.length + 1)
			.trim()
			.split(",");
		const token = raw[0]?.trim();
		if (!token || !/^\d+$/.test(token)) return undefined;
		if (Number(token) !== cid) continue;
		const fields: string[] = [];
		for (const field of raw) {
			const value = field.trim();
			if (!/^(?:"[^"\r\n]*"|[^",\r\n]*)$/.test(value)) return undefined;
			fields.push(value.startsWith('"') ? value.slice(1, -1) : value);
		}
		matches.push(fields);
	}
	return matches.length === 1 ? matches[0] : undefined;
}
function unspecifiedInternalAddress(field: string): boolean {
	if (field === "0.0.0.0" || /^(?:0\.){15}0$/.test(field)) return true;
	const bytes =
		!field.includes("%") && isIPv6(field) ? parseIpv6(field) : undefined;
	return bytes?.every((byte) => byte === 0) ?? false;
}
/** Match whole address fields. Sixteen dotted octets denote IPv6, never IPv4. */
export function parseInternalAddress(
	field: string,
): { family: 4 | 6; address: string } | undefined {
	if (field.includes("%") || unspecifiedInternalAddress(field))
		return undefined;
	if (isIPv4(field)) return { family: 4, address: field };
	if (isIPv6(field)) return { family: 6, address: field };
	const octets = field.split(".");
	if (
		octets.length !== 16 ||
		octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
	)
		return undefined;
	const groups: string[] = [];
	for (let index = 0; index < 16; index += 2)
		groups.push(
			((Number(octets[index]) << 8) | Number(octets[index + 1])).toString(16),
		);
	const address = groups.join(":");
	return address !== "0:0:0:0:0:0:0:0" && isIPv6(address)
		? { family: 6, address }
		: undefined;
}
export function parseInternalGrant(
	reply: string,
	cid: number,
): InternalGrant | undefined {
	const fields = contextFields(reply, "+CGPADDR", cid);
	if (!fields || fields.length < 2 || fields.length > 3) return undefined;
	const v4 = new Set<string>(),
		v6 = new Set<string>();
	for (const field of fields.slice(1)) {
		if (!field || unspecifiedInternalAddress(field)) continue;
		const parsed = parseInternalAddress(field);
		if (!parsed) return undefined;
		if (parsed.family === 4) {
			const first = Number(parsed.address.split(".")[0]);
			if (
				first === 0 ||
				first === 127 ||
				first >= 224 ||
				parsed.address.startsWith("169.254.")
			)
				return undefined;
			v4.add(parsed.address);
		} else v6.add(parsed.address);
	}
	if (v4.size > 1 || v6.size > 1) return undefined;
	const ipv4 = [...v4][0],
		ipv6 = [...v6][0];
	return {
		family: ipv4 ? (ipv6 ? "ipv4v6" : "ipv4") : ipv6 ? "ipv6" : "none",
		...(ipv4 ? { ipv4 } : {}),
		...(ipv6 ? { ipv6 } : {}),
	};
}
export function parseInternalContextDns(
	reply: string,
	cid: number,
): readonly string[] | undefined {
	const fields = contextFields(reply, "+CGCONTRDP", cid);
	if (!fields || fields.length < 7) return undefined;
	const addresses: string[] = [];
	for (const field of fields.slice(5, 7)) {
		if (!field || unspecifiedInternalAddress(field)) continue;
		const address = parseInternalAddress(field);
		if (!address) return undefined;
		addresses.push(address.address);
	}
	return [...new Set(addresses)];
}
export function parseInternalContextActive(
	reply: string,
	cid: number,
): boolean | undefined {
	const fields = contextFields(reply, "+CGACT", cid);
	return fields?.length === 2 && (fields[1] === "0" || fields[1] === "1")
		? fields[1] === "1"
		: undefined;
}

export interface InternalContext {
	readonly apn: string;
	readonly family: RequestedFamily;
	readonly settings?: readonly string[];
}
function contextSettings(settings: readonly string[]): boolean {
	return (
		settings.length <= 16 &&
		settings.every((field, index) =>
			index === 0
				? field === "" ||
					!!parseInternalAddress(field) ||
					field === "0.0.0.0" ||
					field === "::"
				: /^\d{1,5}$/.test(field) && Number(field) <= 65535,
		)
	);
}
export function internalContextCommand(
	cid: number,
	apn: string,
	family: RequestedFamily,
	settings: readonly string[] = [],
): string {
	if (
		!Number.isInteger(cid) ||
		cid < 1 ||
		cid > 16 ||
		!/^[a-zA-Z0-9._-]{0,100}$/.test(apn) ||
		!["ipv4", "ipv6", "ipv4v6"].includes(family) ||
		!contextSettings(settings)
	)
		throw new Error("Invalid context definition");
	const pdp = family === "ipv4" ? "IP" : family === "ipv6" ? "IPV6" : "IPV4V6";
	return `AT+CGDCONT=${cid},"${pdp}","${apn}"${settings.map((field, index) => `,${index === 0 ? `"${field}"` : field}`).join("")}`;
}
/** A definition is reversible only when its entire APN/family is understood. */
export function parseInternalContext(
	reply: string,
	cid: number,
): InternalContext | undefined {
	const fields = contextFields(reply, "+CGDCONT", cid);
	if (
		!fields ||
		fields.length < 3 ||
		!/^[a-zA-Z0-9._-]{0,100}$/.test(fields[2] ?? "") ||
		!contextSettings(fields.slice(3))
	)
		return undefined;
	const family =
		fields[1] === "IP"
			? "ipv4"
			: fields[1] === "IPV6"
				? "ipv6"
				: fields[1] === "IPV4V6"
					? "ipv4v6"
					: undefined;
	return family && fields[2] !== undefined
		? {
				apn: fields[2],
				family,
				...(fields.length > 3 ? { settings: fields.slice(3) } : {}),
			}
		: undefined;
}
