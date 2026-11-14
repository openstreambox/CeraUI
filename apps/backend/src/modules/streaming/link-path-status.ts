import type { LinkPathStatus, LinkPaths } from "@ceraui/rpc/schemas";
import { broadcastMsg } from "../ui/websocket-server.ts";
import type { LinkPath, ReceiverFamilies } from "./link-family.ts";

export function describeLinkPath(
	source: { ip?: string; ipv6?: string },
	receiver: ReceiverFamilies | undefined,
	path: LinkPath | undefined,
	clat?: LinkPath | undefined,
): LinkPathStatus {
	if (!receiver) return "unknown";
	if (path) return path.mode;
	if (!source.ip && !source.ipv6) return "no-source";
	if (source.ipv6 && receiver.ipv4 && clat) return "waiting";
	if (!source.ip && source.ipv6 && receiver.ipv4 && !receiver.ipv6)
		return "receiver-ipv4-only";
	if (!(source.ip && receiver.ipv4) && !(source.ipv6 && receiver.ipv6))
		return "incompatible";
	return "waiting";
}

let paths: LinkPaths = {};
export function getLinkPaths(): LinkPaths {
	return { ...paths };
}
/** Replace the complete map: removal, session reset and withdrawal cannot latch. */
export function setLinkPaths(next: LinkPaths): void {
	if (JSON.stringify(next) === JSON.stringify(paths)) return;
	paths = { ...next };
	broadcastMsg("status", { link_paths: getLinkPaths() });
}
