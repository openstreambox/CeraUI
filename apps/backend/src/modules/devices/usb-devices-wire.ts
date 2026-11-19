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

import {
	type DeviceCalm,
	deviceCalmSchema,
	type UsbDevicesWire,
	type UsbEventWire,
	type UsbHelperWire,
	usbDevicesWireSchema,
	usbEventsWireSchema,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { getUsbEvents, observeUsbDevices } from "./usb-events.ts";
import { mockUsbHelper, readUsbHelper } from "./usb-helper.ts";
import { captureHelperSeen } from "./usb-helper-actions.ts";

import {
	readUsbTree,
	sanitizeUsbProduct,
	type UsbTree,
	type UsbTreeBoard,
	type UsbTreeNode,
} from "./usb-tree.ts";

const LINK_ID = /^[A-Za-z0-9:._-]{1,80}$/;
const MINTED_LINK_ID = /^lnk_[0-9a-f]{16}$/;
const HEX_RUN = /[0-9a-f]{12}/i;
const LONG_DIGITS = /\d{14,}/;

export type XhciControllerMap = Readonly<Record<string, string>>;

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

/** Set only while the development fixture is what the page should show. */
let mockStory: { events: UsbEventWire[]; calm: DeviceCalm } | null = null;

/** Null until the first helper read. Local replay and status keep it. */
let cachedHelper: UsbHelperWire | null = null;

export function getUsbHelper(): UsbHelperWire | null {
	return cachedHelper;
}

export function getUsbDevicesWire(): UsbDevicesWire {
	return cached;
}

/**
 * The tree a browser receives when it authenticates. Polls that find the
 * same tree do not broadcast, so this replay is the only way a later login
 * sees a walk that already finished. It is not part of `status.getStatus`.
 */
export function replayAuthenticatedUsbDevices<
	T extends Record<string, unknown>,
>(
	status: T,
): T & {
	usb_devices: UsbDevicesWire;
	device_calm?: DeviceCalm;
	usb_helper?: UsbHelperWire;
} {
	const withTree = mockStory
		? {
				...status,
				usb_devices: cached,
				usb_events: mockStory.events,
				device_calm: mockStory.calm,
			}
		: { ...status, usb_devices: cached, usb_events: getUsbEvents() };
	return cachedHelper === null
		? withTree
		: { ...withTree, usb_helper: cachedHelper };
}

/** `platform-fc800000.usb-usb-0:1.2:1.0` → controller fc800000.usb, port 1.2. */
export function usbLinkRefFromIdPath(
	idPath: string | undefined,
	linkId: string | undefined,
	xhciControllers: XhciControllerMap = {},
): UsbLinkRef | null {
	if (!idPath || !linkId || !isPublishableLinkId(linkId)) return null;
	const controller = controllerFromIdPath(idPath, xhciControllers);
	const portPath = portPathFromIdPath(idPath);
	if (controller === null || portPath === null) return null;
	return { controller, portPath, linkId };
}

export async function resolveXhciController(
	name: string,
	sysfsRoot = "/",
): Promise<string | null> {
	try {
		const { realpath } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const real = await realpath(
			join(sysfsRoot, "sys/bus/platform/devices", name),
		);
		return real.toLowerCase().match(/[0-9a-f]+\.usb/)?.[0] ?? null;
	} catch {
		return null;
	}
}

export async function usbLinkRefFromIdPathResolved(
	idPath: string | undefined,
	linkId: string | undefined,
	xhciControllers: XhciControllerMap = {},
	sysfsRoot = "/",
): Promise<UsbLinkRef | null> {
	const direct = usbLinkRefFromIdPath(idPath, linkId, xhciControllers);
	if (direct !== null || idPath === undefined) return direct;
	const xhci = idPath.toLowerCase().match(/xhci-hcd\.\d+\.auto/)?.[0];
	if (xhci === undefined) return null;
	const controller = await resolveXhciController(xhci, sysfsRoot);
	if (controller === null) return null;
	return usbLinkRefFromIdPath(idPath, linkId, {
		...xhciControllers,
		[xhci]: controller,
	});
}

export function projectUsbDevices(
	tree: UsbTree,
	links: readonly UsbLinkRef[],
): UsbDevicesWire {
	try {
		return usbDevicesWireSchema.parse({
			status: tree.status,
			board: tree.board,
			nodes: flatten(tree.roots).map((node) => toWireNode(node, links)),
		});
	} catch (err) {
		logger.warn("usb device tree was not published", { err });
		return { status: "unavailable", board: tree.board, nodes: [] };
	}
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
	const wire = projectUsbDevices(tree, input?.links ?? []);
	cached = wire;
	return wire;
}

/**
 * The tree screenshots and the dev UI read. It does not walk the machine
 * that happens to be running the mock backend.
 *
 * displayState, reasonKey, linkSlot, generation, clock, since and drops are
 * not produced by the sysfs reader. They exist so this fixture can show the
 * design until those records exist.
 */
export function mockUsbDevicesWire(): UsbDevicesWire {
	const hub = "fc400000.usb:usb2:1";
	return usbDevicesWireSchema.parse({
		status: "ok",
		board: "rock-5b-plus",
		nodes: [
			mockNode({
				key: "fcd00000.usb:usb3:1",
				controller: "fcd00000.usb",
				portPath: "1",
				socketKey: "A3-top",
				speedClass: "usb3",
				portClass: "usb3",
				colour: "blue",
				label: "A3-top",
				name: "Upper blue port",
				kind: "capture",
				product: "USB capture",
				vendorId: "345f",
				productId: "2130",
				superspeedCapable: true,
				displayState: "on",
				reasonKey: "video-source",
				sourceName: "cam-0",
				speedNote: "capture-needs-usb3",
			}),
			mockNode({
				key: hub,
				controller: "fc400000.usb",
				portPath: "1",
				socketKey: "A3-bot",
				speedClass: "usb2",
				portClass: "usb3",
				colour: "blue",
				label: "A3-bot",
				name: "Lower blue port",
				kind: "hub",
				reasonKey: "hub-own-power",
				hubPorts: 4,
			}),
			mockNode({
				key: "fc400000.usb:usb2:1.1",
				parentKey: hub,
				controller: "fc400000.usb",
				portPath: "1.1",
				socketKey: "A3-bot>hub.1",
				speedClass: "usb2",
				portClass: "usb3",
				colour: "blue",
				scope: "hub-port",
				label: ">hub.1",
				name: "Hub port 1",
				kind: "modem",
				product: "RM520N-GL",
				vendorId: "2c7c",
				productId: "0801",
				linkId: "lnk_0123456789abcdef",
				generation: "5g",
				linkSlot: 3,
				reasonKey: "in-bond",
				since: "12:31",
				drops: 0,
				speedNote: "rm520-held-usb2",
				exampleDetails: true,
			}),
			mockNode({
				key: "fc400000.usb:usb2:1.2",
				parentKey: hub,
				controller: "fc400000.usb",
				portPath: "1.2",
				socketKey: "A3-bot>hub.2",
				speedClass: "usb2",
				portClass: "usb3",
				colour: "blue",
				scope: "hub-port",
				label: ">hub.2",
				name: "Hub port 2",
				kind: "modem",
				product: "RM520N-GL",
				vendorId: "2c7c",
				productId: "0801",
				generation: "5g",
				linkSlot: 4,
				displayState: "not-responding",
				reasonKey: "dropped",
				clock: "14:06",
				retry: 2,
				retryMax: 3,
			}),
			mockNode({
				key: "fc400000.usb:usb2:1.3",
				parentKey: hub,
				controller: "fc400000.usb",
				portPath: "1.3",
				socketKey: "A3-bot>hub.3",
				speedClass: "usb2",
				portClass: "usb3",
				colour: "blue",
				scope: "hub-port",
				label: ">hub.3",
				name: "Hub port 3",
				kind: "wifi",
				product: "Archer T3U",
				displayState: "resting",
				reasonKey: "resting-warm",
			}),
			mockNode({
				key: "fc400000.usb:usb2:1.4",
				parentKey: hub,
				controller: "fc400000.usb",
				portPath: "1.4",
				socketKey: "A3-bot>hub.4",
				speedClass: "usb2",
				portClass: "usb3",
				colour: "blue",
				scope: "hub-port",
				label: ">hub.4",
				name: "Hub port 4",
				kind: "other",
				reasonKey: "unused-heat",
			}),
			mockNode({
				key: "fc800000.usb:usb2:1.2",
				controller: "fc800000.usb",
				portPath: "1.2",
				socketKey: "A2-top",
				speedClass: "usb2",
				portClass: "usb2",
				colour: "black",
				label: "A2-top",
				name: "Upper black port",
				kind: "wifi",
				product: "Archer T2U Nano",
				linkSlot: 2,
				reasonKey: "bond-hotspot",
			}),
			mockNode({
				key: "fc800000.usb:unplugged:1.4",
				controller: "fc800000.usb",
				portPath: "1.4",
				socketKey: "A2-bot",
				speedClass: "unknown",
				portClass: "usb2",
				colour: "black",
				label: "A2-bot",
				name: "Lower black port",
				kind: "wifi",
				presence: "nothing-detected",
				displayState: "unplugged",
				reasonKey: "unplugged-wifi",
				minutesAgo: 13,
			}),
			mockNode({
				key: "fc000000.usb:nothing-detected:1",
				controller: "fc000000.usb",
				portPath: "1",
				socketKey: "C",
				speedClass: "unknown",
				portClass: "usb3",
				label: "C",
				name: "USB-C data port",
				kind: "other",
				presence: "nothing-detected",
			}),
			mockNode({
				key: "fc800000.usb:m2:1.4",
				controller: "fc800000.usb",
				portPath: "1.4",
				socketKey: "M2B",
				speedClass: "usb2",
				portClass: "usb2",
				colour: "black",
				label: "M2B",
				name: "Modem slot inside",
				kind: "modem",
				product: "DW5821e",
				generation: "4g",
				displayState: "off",
				reasonKey: "turned-off",
				clock: "12:40",
			}),
			mockNode({
				key: "builtin:wifi",
				socketKey: "builtin-wifi",
				scope: "built-in",
				name: "Wi-Fi",
				kind: "wifi",
				linkSlot: 1,
				reasonKey: "bond-venue",
				speedClass: "unknown",
			}),
			mockNode({
				key: "builtin:bt",
				socketKey: "BT",
				scope: "built-in",
				label: "BT",
				name: "Bluetooth",
				kind: "other",
				displayState: "on",
				reasonKey: "not-used",
				speedClass: "unknown",
			}),
		],
	});
}

/** The design's helper list. The real ring only records plugged and unplugged. */
export function mockUsbEvents(): UsbEventWire[] {
	return usbEventsWireSchema.parse([
		{
			seq: 1,
			at: 0,
			clock: "14:12",
			reason: "resting",
			kind: "wifi",
			socketName: "Hub port 3",
			tempC: 71,
		},
		{
			seq: 2,
			at: 0,
			clock: "14:08",
			reason: "retry",
			kind: "modem",
			socketName: "Hub port 2",
			linkSlot: 4,
			retry: 2,
		},
		{
			seq: 3,
			at: 0,
			clock: "14:06",
			reason: "dropped",
			kind: "modem",
			socketName: "Hub port 2",
			linkSlot: 4,
		},
		{
			seq: 4,
			at: 0,
			clock: "14:01",
			reason: "left",
			kind: "wifi",
			socketName: "Lower black port",
		},
		{
			seq: 5,
			at: 0,
			clock: "12:40",
			reason: "turned-off",
			kind: "modem",
			socketName: "Modem slot inside",
			generation: "4g",
		},
		{
			seq: 6,
			at: 0,
			clock: "12:31",
			reason: "usb2",
			kind: "modem",
			socketName: "Hub port 1",
			linkSlot: 3,
		},
	]);
}

export function mockDeviceCalm(): DeviceCalm {
	return deviceCalmSchema.parse({
		resting: 1,
		off: 1,
		restingKind: "wifi",
		offKind: "modem",
		offAt: "12:40",
		unresponsive: 1,
	});
}

function mockNode(
	overrides: Partial<UsbDevicesWire["nodes"][number]> &
		Pick<
			UsbDevicesWire["nodes"][number],
			"key" | "socketKey" | "name" | "kind"
		>,
): UsbDevicesWire["nodes"][number] {
	return {
		parentKey: null,
		controller: null,
		portPath: null,
		speedClass: "unknown",
		portClass: null,
		colour: null,
		scope: "socket",
		label: null,
		product: null,
		vendorId: null,
		productId: null,
		presence: "present",
		superspeedCapable: false,
		linkId: null,
		...overrides,
	};
}

/** Read the host tree, join published links, and push one status field when it changed. */
export async function publishUsbDevices(): Promise<void> {
	const { shouldUseMocks } = await import("../../mocks/mock-service.ts");
	if (shouldUseMocks()) {
		const { broadcastMsg } = await import("../../rpc/compat.ts");
		mockStory = { events: mockUsbEvents(), calm: mockDeviceCalm() };
		const helper = mockUsbHelper();
		deliverUsbDevicesWire(
			mockUsbDevicesWire(),
			(next) => {
				broadcastMsg("status", {
					usb_devices: next,
					usb_events: mockUsbEvents(),
					device_calm: mockDeviceCalm(),
					usb_helper: helper,
				});
			},
			helper,
		);
		return;
	}
	try {
		const { publishedLinkPaths } = await import(
			"../streaming/link-registry.ts"
		);
		const tree = await readUsbTree({ sysfsRoot: "/" });
		await captureHelperSeen(tree.roots, "/");
		const map = tree.xhciControllers ?? {};
		const links: UsbLinkRef[] = [];
		for (const item of publishedLinkPaths()) {
			const ref = await usbLinkRefFromIdPathResolved(
				item.idPath,
				item.linkId,
				map,
			);
			if (ref !== null) links.push(ref);
		}
		const wire = projectUsbDevices(tree, links);
		const helper = await readUsbHelper({
			root: "/",
			board: tree.board,
		});
		const { broadcastMsg } = await import("../../rpc/compat.ts");
		deliverUsbDevicesWire(
			wire,
			(next) => {
				broadcastMsg("status", {
					usb_devices: next,
					usb_events: getUsbEvents(),
					usb_helper: helper,
				});
			},
			helper,
		);
	} catch (err) {
		logger.warn("usb device tree was not published", { err });
		const helper = await readUsbHelper({ root: "/" });
		const { broadcastMsg } = await import("../../rpc/compat.ts");
		deliverUsbDevicesWire(
			{
				status: "unavailable",
				board: cached.board,
				nodes: [],
			},
			(next) => {
				broadcastMsg("status", {
					usb_devices: next,
					usb_events: getUsbEvents(),
					usb_helper: helper,
				});
			},
			helper,
		);
	}
}

/** Broadcast only when the snapshot changed. */
export function deliverUsbDevicesWire(
	next: UsbDevicesWire,
	broadcast: (wire: UsbDevicesWire) => void,
	helper?: UsbHelperWire,
): boolean {
	const sameWire = JSON.stringify(next) === JSON.stringify(cached);
	const sameHelper =
		helper === undefined ||
		JSON.stringify(helper) === JSON.stringify(cachedHelper);
	if (sameWire && sameHelper) return false;
	if (!sameWire) {
		observeUsbDevices(next);
		cached = next;
	}
	if (helper !== undefined) cachedHelper = helper;
	broadcast(next);
	return true;
}

function deviceCanUseSuperSpeed(version: string | null): boolean {
	if (version === null) return false;
	const major = Number(version.split(".")[0]);
	return Number.isInteger(major) && major >= 3;
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
		superspeedCapable: deviceCanUseSuperSpeed(node.usbVersion),
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
	if (MINTED_LINK_ID.test(linkId)) return true;
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

function portPathFromIdPath(idPath: string): string | null {
	return idPath.match(/-usb-\d+:(\d+(?:\.\d+)*)(?::\d+\.\d+)*$/)?.[1] ?? null;
}

function controllerFromIdPath(
	idPath: string,
	xhciControllers: XhciControllerMap,
): string | null {
	const lower = idPath.toLowerCase();
	const platform = lower.match(/[0-9a-f]+\.usb/)?.[0];
	if (platform !== undefined) return platform;
	const pci = lower.match(
		/pci-([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])/,
	);
	if (pci?.[1] !== undefined) return pci[1];
	const xhci = lower.match(/xhci-hcd\.\d+\.auto/)?.[0];
	if (xhci !== undefined) return xhciControllers[xhci] ?? null;
	return null;
}

function flatten(nodes: readonly UsbTreeNode[]): UsbTreeNode[] {
	const out: UsbTreeNode[] = [];
	for (const node of nodes) {
		out.push(node);
		out.push(...flatten(node.children));
	}
	return out;
}
