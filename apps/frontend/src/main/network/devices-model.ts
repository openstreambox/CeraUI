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

/**
 * Read-only grouping for Network › Devices.
 *
 * A socket whose controller never started a host bus is `presence:
 * "nothing-detected"`. That row is empty. Its kind stays "other" on the
 * wire, and rendering the kind would call an empty USB-C port an unknown
 * device.
 */
import type { UsbDevicesWire, UsbDeviceWireNode } from "@ceraui/rpc/schemas";

export type DeviceHint = "rm520-usb2" | "capture-usb2";
export type DeviceRowState = "on" | "unused" | "empty" | "checking";

export type DeviceRow = {
	readonly key: string;
	readonly depth: number;
	readonly state: DeviceRowState;
	readonly kind: UsbDeviceWireNode["kind"] | null;
	readonly product: string | null;
	readonly hint: DeviceHint | null;
	readonly speedClass: UsbDeviceWireNode["speedClass"];
	readonly controller: string | null;
	readonly portPath: string | null;
	readonly vendorId: string | null;
	readonly productId: string | null;
	readonly linkId: string | null;
	readonly slot: string | null;
};

export type DevicePortGroup = {
	readonly id: string;
	readonly name: string;
	readonly label: string | null;
	readonly portClass: UsbDeviceWireNode["portClass"];
	readonly builtIn: boolean;
	readonly rows: readonly DeviceRow[];
};

export type DevicesPageModel =
	| { readonly status: "checking" }
	| {
			readonly status: "ok";
			readonly board: UsbDevicesWire["board"];
			readonly groups: readonly DevicePortGroup[];
	  };

const ROCK_LABEL_ORDER = [
	"A3-top",
	"A3-bot",
	"A2-top",
	"A2-bot",
	"C",
	"M2B",
	"BT",
] as const;

export function devicesPageModel(
	wire: UsbDevicesWire | undefined,
): DevicesPageModel {
	if (wire === undefined || wire.status !== "ok") return { status: "checking" };
	const byKey = new Map(wire.nodes.map((node) => [node.key, node]));
	const groups = new Map<string, UsbDeviceWireNode[]>();
	for (const node of wire.nodes) {
		const id = groupId(node, byKey);
		const list = groups.get(id) ?? [];
		list.push(node);
		groups.set(id, list);
	}
	const built: DevicePortGroup[] = [];
	for (const [id, nodes] of groups) {
		const anchor = nodes.find((node) => node.socketKey === id) ?? nodes[0];
		if (anchor === undefined) continue;
		const builtIn = anchor.scope === "built-in" || id === "built-in";
		built.push({
			id,
			name: builtIn ? "" : anchor.name,
			label: builtIn ? null : socketLabel(anchor),
			portClass: anchor.portClass,
			builtIn,
			rows: nodes
				.slice()
				.sort((a, b) => compareNodes(a, b, byKey))
				.map((node) => toRow(node, byKey)),
		});
	}
	built.sort(
		(a, b) => groupRank(a) - groupRank(b) || a.id.localeCompare(b.id, "en"),
	);
	return { status: "ok", board: wire.board, groups: built };
}

/** A board socket such as A2-top or M2B. A hub port and a generic port are not. */
function isMappedPhysicalSocket(node: UsbDeviceWireNode): boolean {
	return (
		node.scope === "socket" &&
		node.label !== null &&
		!node.label.startsWith(">")
	);
}

function groupId(
	node: UsbDeviceWireNode,
	byKey: Map<string, UsbDeviceWireNode>,
): string {
	let current = node;
	const seen = new Set<string>();
	// A mapped socket is its own heading. Climbing through it put A2-top and
	// M2B under the onboard hub. Generic hubs have no such label, so their
	// children still walk up to the root port.
	while (!isMappedPhysicalSocket(current)) {
		if (current.parentKey === null || seen.has(current.parentKey)) break;
		const parent = byKey.get(current.parentKey);
		if (parent === undefined) break;
		seen.add(current.parentKey);
		if (parent.scope === "root" || parent.portPath === null) break;
		current = parent;
	}
	if (current.scope === "built-in") return "built-in";
	const cut = current.socketKey.indexOf(">");
	return cut === -1 ? current.socketKey : current.socketKey.slice(0, cut);
}

function socketLabel(node: UsbDeviceWireNode): string | null {
	if (node.label === null || node.label.startsWith(">hub.")) return null;
	return node.label;
}

function groupRank(group: DevicePortGroup): number {
	if (group.builtIn) return 1000;
	const label = group.label ?? group.id;
	const index = ROCK_LABEL_ORDER.indexOf(
		label as (typeof ROCK_LABEL_ORDER)[number],
	);
	return index === -1 ? 500 : index;
}

function compareNodes(
	a: UsbDeviceWireNode,
	b: UsbDeviceWireNode,
	byKey: Map<string, UsbDeviceWireNode>,
): number {
	const depth = depthOf(a, byKey) - depthOf(b, byKey);
	if (depth !== 0) return depth;
	return (a.portPath ?? "").localeCompare(b.portPath ?? "", "en");
}

function depthOf(
	node: UsbDeviceWireNode,
	byKey: Map<string, UsbDeviceWireNode>,
): number {
	let depth = 0;
	const seen = new Set<string>();
	let parentKey = node.parentKey;
	while (parentKey !== null && !seen.has(parentKey)) {
		seen.add(parentKey);
		depth += 1;
		parentKey = byKey.get(parentKey)?.parentKey ?? null;
	}
	return depth;
}

function toRow(
	node: UsbDeviceWireNode,
	byKey: Map<string, UsbDeviceWireNode>,
): DeviceRow {
	const empty = node.presence === "nothing-detected";
	return {
		key: node.key,
		depth: depthOf(node, byKey),
		state: empty ? "empty" : node.kind === "other" ? "unused" : "on",
		kind: empty ? null : node.kind,
		product: empty ? null : node.product,
		hint: empty ? null : hintFor(node),
		speedClass: node.speedClass,
		controller: node.controller,
		portPath: node.portPath,
		vendorId: node.vendorId,
		productId: node.productId,
		linkId: node.linkId,
		slot: node.scope === "hub-port" ? node.name : null,
	};
}

function hintFor(node: UsbDeviceWireNode): DeviceHint | null {
	if (
		node.product !== null &&
		/RM520/i.test(node.product) &&
		node.speedClass === "usb2" &&
		node.portClass === "usb3"
	) {
		return "rm520-usb2";
	}
	if (
		node.kind === "capture" &&
		node.speedClass === "usb2" &&
		node.superspeedCapable
	) {
		return "capture-usb2";
	}
	return null;
}
