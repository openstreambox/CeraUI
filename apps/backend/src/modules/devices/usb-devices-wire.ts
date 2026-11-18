/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * The USB tree as it goes out on the status feed.
 *
 * net0 and net1 are per-device placeholders for a MAC-derived interface
 * name. They are not sent. A node is joined to a published link by
 * controller and port path, and only that link id is sent.
 */

import type { UsbDevicesWire } from "../../../../../packages/rpc/src/schemas/usb-devices.schema.ts";
import { usbDevicesWireSchema } from "../../../../../packages/rpc/src/schemas/usb-devices.schema.ts";

import {
	readUsbTree,
	sanitizeUsbProduct,
	type UsbTree,
	type UsbTreeBoard,
	type UsbTreeNode,
} from "./usb-tree.ts";

const LINK_ID = /^[A-Za-z0-9:._-]{1,80}$/;
const HEX_RUN = /[0-9a-f]{12}/i;
const LONG_DIGITS = /\d{14,}/;

export const USB_DEVICE_POLL_INTERVAL_MS = 30_000;

export type UsbLinkRef = {
	readonly controller: string;
	readonly portPath: string;
	readonly linkId: string;
};

let cached: UsbDevicesWire = {
	status: "unavailable",
	board: "generic",
	nodes: [],
};

export function getUsbDevicesWire(): UsbDevicesWire {
	return cached;
}

/** `platform-fc800000.usb-usb-0:1.2:1.0` → controller fc800000.usb, port 1.2. */
export function usbLinkRefFromIdPath(
	idPath: string | undefined,
	linkId: string | undefined,
): UsbLinkRef | null {
	if (!idPath || !linkId || !isPublishableLinkId(linkId)) return null;
	const controller = idPath.toLowerCase().match(/[0-9a-f]+\.usb/)?.[0] ?? null;
	const portPath = idPath.match(/-usb-\d+:(\d+(?:\.\d+)*)/)?.[1] ?? null;
	if (controller === null || portPath === undefined || portPath === null) {
		return null;
	}
	return { controller, portPath, linkId };
}

export function projectUsbDevices(
	tree: UsbTree,
	links: readonly UsbLinkRef[],
): UsbDevicesWire {
	const nodes = flatten(tree.roots).map((node) => toWireNode(node, links));
	const wire = usbDevicesWireSchema.parse({
		status: tree.status,
		board: tree.board,
		nodes,
	});
	cached = wire;
	return wire;
}

export async function refreshUsbDevices(input?: {
	readonly sysfsRoot?: string;
	readonly board?: UsbTreeBoard;
	readonly links?: readonly UsbLinkRef[];
}): Promise<UsbDevicesWire> {
	const tree = await readUsbTree({
		sysfsRoot: input?.sysfsRoot ?? "/",
		...(input?.board === undefined ? {} : { board: input.board }),
	});
	return projectUsbDevices(tree, input?.links ?? []);
}

/** Read the host tree, join published links, and push one status field. */
export async function publishUsbDevices(): Promise<void> {
	try {
		const { publishedLinkPaths } = await import(
			"../streaming/link-registry.ts"
		);
		const { broadcastMsg } = await import("../../rpc/compat.ts");
		const links = publishedLinkPaths().flatMap((item) => {
			const ref = usbLinkRefFromIdPath(item.idPath, item.linkId);
			return ref === null ? [] : [ref];
		});
		const wire = await refreshUsbDevices({ links });
		broadcastMsg("status", { usb_devices: wire });
	} catch {
		// A failed probe stays at the last good snapshot, or unavailable.
	}
}

function toWireNode(node: UsbTreeNode, links: readonly UsbLinkRef[]) {
	const linkId = chooseLinkId(node, links);
	return {
		key: node.key,
		parentKey: node.parentKey,
		controller: node.controller,
		portPath: node.portPath,
		socketKey: node.socketKey,
		speedClass: node.speedClass,
		portClass: node.port.portClass,
		colour: node.port.colour,
		scope: node.port.scope,
		label: node.port.label,
		name: node.port.name,
		kind: node.kind,
		product: sanitizeUsbProduct(node.product),
		vendorId: node.vendorId,
		productId: node.productId,
		presence: node.presence,
		linkId,
	};
}

function chooseLinkId(
	node: UsbTreeNode,
	links: readonly UsbLinkRef[],
): string | null {
	if (node.controller === null || node.portPath === null) return null;
	const matches = links
		.filter(
			(link) =>
				link.controller === node.controller &&
				link.portPath === node.portPath &&
				isPublishableLinkId(link.linkId),
		)
		.map((link) => link.linkId)
		.sort((a, b) => a.localeCompare(b, "en"));
	return matches[0] ?? null;
}

function isPublishableLinkId(linkId: string): boolean {
	if (!LINK_ID.test(linkId)) return false;
	if (HEX_RUN.test(linkId) || LONG_DIGITS.test(linkId)) return false;
	if (/serial/i.test(linkId) && /\d/.test(linkId)) return false;
	const alnum = linkId.match(/[A-Za-z0-9]/g) ?? [];
	if (alnum.length < 12) return true;
	let digits = 0;
	for (const char of alnum) {
		if (char >= "0" && char <= "9") digits += 1;
	}
	return !(digits >= 4 && alnum.length - digits >= 2);
}

function flatten(nodes: readonly UsbTreeNode[]): UsbTreeNode[] {
	const out: UsbTreeNode[] = [];
	for (const node of nodes) {
		out.push(node);
		out.push(...flatten(node.children));
	}
	return out;
}
