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
import type {
	DeviceCalm,
	UsbDevicesWire,
	UsbDeviceWireNode,
	UsbHelperHold,
	UsbHelperReprobe,
	UsbHelperTypec,
	UsbHelperWire,
} from "@ceraui/rpc/schemas";

export type DeviceHint =
	| "rm520-usb2"
	| "rm520-usb3"
	| "capture-usb2"
	| "capture-usb3";
export type DeviceRowState =
	| "on"
	| "resting"
	| "off"
	| "unresponsive"
	| "unplugged"
	| "unused"
	| "empty"
	| "checking";

export type DeviceRow = {
	readonly key: string;
	readonly depth: number;
	readonly lastChild: boolean;
	readonly state: DeviceRowState;
	readonly kind: UsbDeviceWireNode["kind"] | null;
	readonly product: string | null;
	readonly hint: DeviceHint | null;
	readonly speedClass: UsbDeviceWireNode["speedClass"];
	readonly portClass: UsbDeviceWireNode["portClass"];
	readonly controller: string | null;
	readonly portPath: string | null;
	readonly place: string | null;
	readonly vendorId: string | null;
	readonly productId: string | null;
	readonly linkId: string | null;
	readonly slot: string | null;
	readonly scope: UsbDeviceWireNode["scope"];
	readonly exampleDetails: boolean;
	readonly title: string | null;
	readonly reasonKey: UsbDeviceWireNode["reasonKey"] | null;
	readonly linkSlot: number | null;
	readonly generation: NonNullable<UsbDeviceWireNode["generation"]> | null;
	readonly sourceName: string | null;
	readonly clock: string | null;
	readonly minutesAgo: number | null;
	readonly retry: number | null;
	readonly retryMax: number | null;
	readonly hubPorts: number | null;
	readonly since: string | null;
	readonly drops: number | null;
	readonly helper: DeviceRowHelper | null;
};

/** J11, the port-fix marker, and USB 2 holds. Only inside helper details. */
export type DeviceRowHelper = {
	readonly typec: UsbHelperTypec | null;
	readonly reprobe: UsbHelperReprobe | null;
	readonly holds: readonly UsbHelperHold[];
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
			readonly summary: DevicesSummary;
	  };

export type DevicesSummary = {
	readonly devices: number;
	readonly hubs: number;
	readonly ports: number;
	readonly resting: number;
	readonly off: number;
	readonly unresponsive: number;
	readonly restingWifi: boolean;
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
	helper?: UsbHelperWire,
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
		const ordered = nodes.slice().sort((a, b) => compareNodes(a, b, byKey));
		const rows = ordered.map((node, index) =>
			toRow(
				node,
				byKey,
				anchor.key,
				builtIn ? null : socketLabel(anchor),
				index === ordered.length - 1,
			),
		);
		built.push({
			id,
			name: builtIn ? "" : anchor.name,
			label: builtIn ? null : socketLabel(anchor),
			portClass: anchor.portClass,
			builtIn,
			rows,
		});
	}
	built.sort(
		(a, b) => groupRank(a) - groupRank(b) || a.id.localeCompare(b.id, "en"),
	);
	const grouped = helper === undefined ? built : attachHelper(built, helper);
	return {
		status: "ok",
		board: wire.board,
		groups: grouped,
		summary: summarize(built, undefined),
	};
}

/** Counts for the page summary and the Network card. Calm fills a count the rows cannot see yet. */
export function devicesSummary(
	wire: UsbDevicesWire | undefined,
	calm?: DeviceCalm,
): DevicesSummary | null {
	const page = devicesPageModel(wire);
	if (page.status !== "ok") return null;
	return summarize(page.groups, calm);
}

function summarize(
	groups: readonly DevicePortGroup[],
	calm: DeviceCalm | undefined,
): DevicesSummary {
	const rows = groups.flatMap((group) =>
		group.builtIn ? [] : group.rows.map((row) => row),
	);
	const counted = (row: DeviceRow) =>
		row.scope !== "root" && row.state !== "empty" && row.state !== "unplugged";
	const devices = rows.filter(
		(row) => row.kind !== "hub" && row.kind !== null && counted(row),
	).length;
	const hubs = rows.filter(
		(row) => row.kind === "hub" && row.scope !== "root",
	).length;
	const ports = groups.filter(
		(group) => !group.builtIn && group.rows.some(counted),
	).length;
	const restingRows = rows.filter((row) => row.state === "resting");
	return {
		devices,
		hubs,
		ports,
		resting: Math.max(restingRows.length, calm?.resting ?? 0),
		off: Math.max(
			rows.filter((row) => row.state === "off").length,
			calm?.off ?? 0,
		),
		unresponsive: Math.max(
			rows.filter((row) => row.state === "unresponsive").length,
			calm?.unresponsive ?? 0,
		),
		restingWifi:
			restingRows.length === 1
				? restingRows[0]?.kind === "wifi"
				: calm?.restingKind === "wifi" && (calm.resting ?? 0) === 1,
	};
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
	anchorKey: string,
	groupLabel: string | null,
	last: boolean,
): DeviceRow {
	const unplugged = node.displayState === "unplugged";
	const empty = node.presence === "nothing-detected" && !unplugged;
	const hubLabel = node.label?.startsWith(">") ? node.label.slice(1) : null;
	const place =
		hubLabel !== null && groupLabel !== null
			? `${groupLabel} › ${hubLabel}`
			: groupLabel;
	return {
		key: node.key,
		depth: depthInGroup(node, anchorKey, byKey),
		lastChild: last && node.key !== anchorKey,
		state: rowState(node, empty),
		kind: empty ? null : node.kind,
		product: empty ? null : node.product,
		hint: empty ? null : hintFor(node),
		speedClass: node.speedClass,
		portClass: node.portClass,
		controller: node.controller,
		portPath: node.portPath,
		place,
		vendorId: node.vendorId,
		productId: node.productId,
		linkId: node.linkId,
		slot: node.scope === "hub-port" ? node.name : null,
		scope: node.scope,
		exampleDetails: node.exampleDetails === true,
		title: node.scope === "built-in" ? node.name : null,
		reasonKey: node.reasonKey ?? null,
		linkSlot: node.linkSlot ?? null,
		generation: node.generation ?? null,
		sourceName: node.sourceName ?? null,
		clock: node.clock ?? null,
		minutesAgo: node.minutesAgo ?? null,
		retry: node.retry ?? null,
		retryMax: node.retryMax ?? null,
		hubPorts: node.hubPorts ?? null,
		since: node.since ?? null,
		drops: node.drops ?? null,
		helper: null,
	};
}

function attachHelper(
	groups: DevicePortGroup[],
	helper: UsbHelperWire,
): DevicePortGroup[] {
	const used = new Set<UsbHelperHold>();
	const next = groups.map((group) => ({
		...group,
		rows: group.rows.map((row) => {
			const holds = helper.holds.filter(
				(hold) => hold.key !== null && hold.key === row.key,
			);
			for (const hold of holds) used.add(hold);
			if (holds.length === 0) return row;
			return {
				...row,
				helper: { typec: null, reprobe: null, holds },
			};
		}),
	}));
	const spare = helper.holds.filter((hold) => !used.has(hold));
	const port = next.find((group) => group.id === "C" || group.label === "C");
	const head = port?.rows[0];
	if (port === undefined || head === undefined) return next;
	if (helper.typec === null && helper.reprobe === null && spare.length === 0) {
		return next;
	}
	const rows = port.rows.slice();
	rows[0] = {
		...head,
		helper: {
			typec: helper.typec,
			reprobe: helper.reprobe,
			holds: [...(head.helper?.holds ?? []), ...spare],
		},
	};
	return next.map((group) => (group === port ? { ...group, rows } : group));
}

function rowState(node: UsbDeviceWireNode, empty: boolean): DeviceRowState {
	if (empty) return "empty";
	if (node.displayState === "not-responding") return "unresponsive";
	if (node.displayState !== undefined) return node.displayState;
	if (node.kind === "other") return "unused";
	return "on";
}

function depthInGroup(
	node: UsbDeviceWireNode,
	anchorKey: string,
	byKey: Map<string, UsbDeviceWireNode>,
): number {
	if (node.key === anchorKey) return 0;
	let depth = 0;
	const seen = new Set<string>();
	let parentKey = node.parentKey;
	while (parentKey !== null && !seen.has(parentKey)) {
		seen.add(parentKey);
		depth += 1;
		if (parentKey === anchorKey) return depth;
		parentKey = byKey.get(parentKey)?.parentKey ?? null;
	}
	return depth;
}

function hintFor(node: UsbDeviceWireNode): DeviceHint | null {
	// The 14 dB line, the promised USB 2 switch and the 1080p60 claim are
	// records, not guesses from the product name and the link class.
	if (node.speedNote === "rm520-held-usb2") return "rm520-usb2";
	if (node.speedNote === "rm520-pending-usb2") return "rm520-usb3";
	if (node.speedNote === "capture-needs-usb3") return "capture-usb3";
	if (
		node.kind === "capture" &&
		node.speedClass === "usb2" &&
		node.superspeedCapable
	) {
		return "capture-usb2";
	}
	return null;
}
