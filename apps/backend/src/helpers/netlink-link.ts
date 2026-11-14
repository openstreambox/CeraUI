import { acknowledgeRouteRequest } from "./netlink-route-request.ts";

/** Kernel-indexed link changes; caller durably records authority and baseline. */
export type IndexedLinkChange =
	| { readonly kind: "up"; readonly up: boolean }
	| { readonly kind: "alias"; readonly alias: string }
	| { readonly kind: "mtu"; readonly mtu: number }
	| { readonly kind: "delete" };
export async function changeLinkByIndex(
	index: number,
	change: IndexedLinkChange,
	writable: () => boolean = () => true,
): Promise<boolean> {
	if (!Number.isInteger(index) || index < 1 || index > 0x7fffffff)
		throw new Error("Invalid link index");
	if (
		change.kind === "alias" &&
		!/^cellular-[a-f0-9]{64}-[a-f0-9]{64}$/.test(change.alias)
	)
		throw new Error("Invalid cellular link alias");
	if (
		change.kind === "mtu" &&
		(!Number.isInteger(change.mtu) || change.mtu < 1260 || change.mtu > 9000)
	)
		throw new Error("Invalid cellular MTU");
	const attr =
		change.kind === "alias"
			? Buffer.from(`${change.alias}\0`)
			: change.kind === "mtu"
				? new Uint8Array(4)
				: undefined;
	if (attr && change.kind === "mtu")
		new DataView(attr.buffer).setUint32(0, change.mtu, true);
	const size = attr ? 4 + attr.length : 0,
		body = new Uint8Array(16 + ((size + 3) & ~3)),
		view = new DataView(body.buffer);
	view.setInt32(4, index, true);
	view.setUint32(8, change.kind === "up" && change.up ? 1 : 0, true);
	view.setUint32(12, change.kind === "up" ? 1 : 0, true);
	if (attr) {
		view.setUint16(16, size, true);
		view.setUint16(18, change.kind === "alias" ? 20 : 4, true);
		body.set(attr, 20);
	}
	return acknowledgeRouteRequest(
		change.kind === "delete" ? 17 : 16,
		body,
		0,
		writable,
	);
}
