import { acknowledgeRouteRequest } from "../../helpers/netlink-route-request.ts";
import { parseIpv4, parseIpv6 } from "./nat64.ts";

export type CellularIndexedIpEffect =
	| {
			readonly kind: "address";
			readonly family: 4 | 6;
			readonly address: string;
			readonly prefix: number;
	  }
	| {
			readonly kind: "proxy";
			readonly family: 6;
			readonly address: string;
	  };

function attribute(type: number, value: Uint8Array): Uint8Array {
	const result = new Uint8Array((value.length + 7) & ~3),
		view = new DataView(result.buffer);
	view.setUint16(0, value.length + 4, true);
	view.setUint16(2, type, true);
	result.set(value, 4);
	return result;
}

/** Index selectors survive name reuse. This is not adoption authority: the
 * caller must own the durable inverse and positively identify the instance.
 * Address add is CREATE|EXCL, never replace. Linux proxy adds can acknowledge
 * duplicates even with EXCL, so their caller must prove absence separately.
 * Owned TUN addresses suppress prefix routes
 * and DAD; a mapped IPv6 address is a proxy neighbour, not a local address.
 */
export async function changeCellularIndexedIp(
	index: number,
	effect: CellularIndexedIpEffect,
	operation: "add" | "del",
	writable: () => boolean = () => true,
): Promise<boolean> {
	if (!Number.isInteger(index) || index < 1 || index > 0x7fffffff)
		throw new Error("Invalid cellular link index");
	const bytes =
		effect.family === 4
			? parseIpv4(effect.address)
			: !effect.address.includes("%") && parseIpv6(effect.address);
	if (
		!bytes ||
		bytes.every((byte) => byte === 0) ||
		(effect.family === 4
			? (bytes[0] ?? 255) >= 224 || bytes[0] === 127
			: bytes[0] === 0xff)
	)
		throw new Error("Invalid indexed cellular address");
	if (
		effect.kind === "address" &&
		(!Number.isInteger(effect.prefix) ||
			effect.prefix !== (effect.family === 4 ? 32 : 128))
	)
		throw new Error("Owned cellular addresses require a host prefix");
	const header = new Uint8Array(effect.kind === "address" ? 8 : 12),
		view = new DataView(header.buffer);
	header[0] = effect.family === 4 ? 2 : 10;
	view.setInt32(4, index, true);
	const attributes: Uint8Array[] = [attribute(1, bytes)];
	if (effect.kind === "address") {
		header[1] = effect.prefix;
		if (effect.family === 4) attributes.push(attribute(2, bytes));
		const flags = new Uint8Array(4);
		new DataView(flags.buffer).setUint32(
			0,
			0x200 | (effect.family === 6 ? 2 : 0),
			true,
		);
		attributes.push(attribute(8, flags));
	} else header[10] = 8;
	const body = new Uint8Array(
		header.length + attributes.reduce((n, a) => n + a.length, 0),
	);
	body.set(header);
	let offset = header.length;
	for (const attr of attributes) {
		body.set(attr, offset);
		offset += attr.length;
	}
	return acknowledgeRouteRequest(
		effect.kind === "address"
			? operation === "add"
				? 20
				: 21
			: operation === "add"
				? 28
				: 29,
		body,
		operation === "add" ? 0x600 : 0,
		writable,
	);
}
