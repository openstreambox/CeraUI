import { changeLinkByIndex } from "./netlink-link.ts";

/** The kernel target is an index. Caller records the baseline and guards USB
 * identity around the IFF_UP-only write; another name cannot redirect it.
 */
export function setLinkUpByIndex(index: number, up: boolean): Promise<boolean> {
	return changeLinkByIndex(index, { kind: "up", up });
}
