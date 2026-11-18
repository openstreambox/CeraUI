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
 * Read-only USB tree.
 *
 * Walks /sys/bus/usb/devices and reports hubs, link speed and a plain port
 * name. The identity of a port is the controller address plus the port path
 * (and which root-hub speed that path sits on). Bus numbers and xhci-hcd.N
 * change across kernels and reboots, so they are never the key.
 *
 * The same controller address means different sockets on different boards
 * (the ROCK 5B+ and the Orange Pi 5 Plus both have fc400000.usb). The ROCK
 * map is used only when the board identity says ROCK 5B+. Every other board
 * gets generic port names.
 *
 * Attributes opened on a device node are USB_DEVICE_ATTRIBUTE_ALLOWLIST and
 * nothing else. The serial attribute is not in that list. Product text that
 * contains a MAC, an IMEI, an ICCID, or a serial-shaped token is dropped.
 * This module never writes sysfs and never changes port power or speed.
 */

import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

/** Filenames this reader may open on a USB device node. */
export const USB_DEVICE_ATTRIBUTE_ALLOWLIST = [
	"speed",
	"version",
	"bDeviceClass",
	"bNumConfigurations",
	"idVendor",
	"idProduct",
	"product",
	"maxchild",
] as const;

type DeviceAttr = (typeof USB_DEVICE_ATTRIBUTE_ALLOWLIST)[number];

export type UsbTreeBoard = "rock-5b-plus" | "generic";

/** What the device is, from drivers and class. Bluetooth stays "other". */
export type UsbDeviceKind = "modem" | "wifi" | "capture" | "hub" | "other";

/**
 * Link rate class from the sysfs `speed` value (Mb/s).
 * usb2 is 480. usb3 is 5000 and faster. full is 12. low is 1.5.
 */
export type UsbLinkClass = "usb3" | "usb2" | "full" | "low" | "unknown";

export type UsbPortScope =
	| "socket"
	| "hub-port"
	| "built-in"
	| "root"
	| "generic";

export type UsbPortPlacement = {
	/** Board label (`A3-bot`, `C`, `>hub.2`), or null when the board has no map. */
	readonly label: string | null;
	/** Printed name ("Lower blue port", "Hub port 2", "USB port 1"). */
	readonly name: string;
	readonly scope: UsbPortScope;
	/** Physical socket this hub port hangs from, when there is one. */
	readonly socketLabel: string | null;
	readonly socketName: string | null;
	/** Downstream port on the parent hub. Null on the socket itself. */
	readonly hubPort: number | null;
};

export type RockPortSpec = {
	readonly controller: string;
	readonly portPath: string;
	readonly label: string | null;
	readonly name: string;
	readonly scope: "socket" | "built-in";
};

/**
 * ROCK 5B+ sockets, keyed by controller address and port path.
 * A3-top is one socket with three controllers: USB 2 (fc880000), its
 * 12 Mb/s companion (fc8c0000), and USB 3 (fcd00000). A3-bot and the
 * USB-C data port (schematic J11, fc000000) carry both speeds on one
 * controller. The black ports, Bluetooth and the modem slot are downstream
 * of the onboard hub on fc800000.
 */
export const ROCK_5B_PLUS_PORTS: readonly RockPortSpec[] = [
	{
		controller: "fc880000.usb",
		portPath: "1",
		label: "A3-top",
		name: "Upper blue port",
		scope: "socket",
	},
	{
		controller: "fc8c0000.usb",
		portPath: "1",
		label: "A3-top",
		name: "Upper blue port",
		scope: "socket",
	},
	{
		controller: "fcd00000.usb",
		portPath: "1",
		label: "A3-top",
		name: "Upper blue port",
		scope: "socket",
	},
	{
		controller: "fc400000.usb",
		portPath: "1",
		label: "A3-bot",
		name: "Lower blue port",
		scope: "socket",
	},
	{
		controller: "fc000000.usb",
		portPath: "1",
		label: "C",
		name: "USB-C data port",
		scope: "socket",
	},
	{
		controller: "fc800000.usb",
		portPath: "1",
		label: null,
		name: "Onboard hub",
		scope: "built-in",
	},
	{
		controller: "fc800000.usb",
		portPath: "1.1",
		label: "A2-bot",
		name: "Lower black port",
		scope: "socket",
	},
	{
		controller: "fc800000.usb",
		portPath: "1.2",
		label: "A2-top",
		name: "Upper black port",
		scope: "socket",
	},
	{
		controller: "fc800000.usb",
		portPath: "1.3",
		label: "BT",
		name: "Built in",
		scope: "built-in",
	},
	{
		controller: "fc800000.usb",
		portPath: "1.4",
		label: "M2B",
		name: "Modem slot inside",
		scope: "built-in",
	},
];

const MODEM_DRIVERS: ReadonlySet<string> = new Set([
	"qmi_wwan",
	"cdc_mbim",
	"option",
]);

const MAC_ADDRESS = /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
const LONG_DIGIT_RUN = /\d{14,}/;
const PRIVATE_WORD = /\b(?:imei|iccid|imeisv)\b/i;
const INTERFACE_NAME = /:\d+\.\d+$/;
const DEVICE_NAME = /^usb\d+$|^\d+-\d+(?:\.\d+)*$/;
const ENDPOINT_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/;
const DRIVER_NAME = /^[a-z0-9_]+$/;

export type UsbTreeNode = {
	/**
	 * controller + root-hub speed class + port path.
	 * A USB 2 device and a USB 3 device on one xHCI controller share the
	 * port path but not the root-hub speed, so both stay in the tree.
	 */
	readonly key: string;
	readonly parentKey: string | null;
	/** Kernel device name (`1-1.2`, `usb1`). Not stable across reboots. */
	readonly kernelName: string;
	readonly controller: string | null;
	readonly portPath: string | null;
	readonly rootSpeedClass: UsbLinkClass;
	readonly speedMbps: number | null;
	readonly speedClass: UsbLinkClass;
	/** bcdUSB text, for example "2.00" or "3.20". */
	readonly usbVersion: string | null;
	readonly vendorId: string | null;
	readonly productId: string | null;
	readonly product: string | null;
	readonly deviceClass: number | null;
	readonly configurationCount: number | null;
	readonly maxPorts: number | null;
	readonly kind: UsbDeviceKind;
	readonly drivers: readonly string[];
	readonly netNames: readonly string[];
	readonly videoNames: readonly string[];
	readonly port: UsbPortPlacement;
	readonly children: readonly UsbTreeNode[];
};

export type UsbTree = {
	readonly board: UsbTreeBoard;
	readonly roots: readonly UsbTreeNode[];
};

export type ReadUsbTreeOptions = {
	/** Directory that contains `sys/bus/usb/devices`. `/` on a device. */
	readonly sysfsRoot: string;
	/** Skip the device-tree read and use this board. */
	readonly board?: UsbTreeBoard;
	/**
	 * File read used for allowlisted attributes and the board identity.
	 * Tests pass a recorder. Production uses the real filesystem.
	 */
	readonly readText?: (path: string) => Promise<string>;
};

export function boardFromIdentityText(raw: string | null): UsbTreeBoard {
	if (raw === null) return "generic";
	const text = raw.toLowerCase();
	if (text.includes("rock-5b-plus") || text.includes("rock 5b+")) {
		return "rock-5b-plus";
	}
	return "generic";
}

export function sanitizeUsbProduct(raw: string | null): string | null {
	if (raw === null) return null;
	const text = raw.replaceAll("\0", "").trim();
	if (text.length === 0 || text.length > 80) return null;
	if (MAC_ADDRESS.test(text) || LONG_DIGIT_RUN.test(text)) return null;
	if (PRIVATE_WORD.test(text)) return null;
	if (/^[0-9a-f]{12,}$/i.test(text)) return null;
	// One long token that contains a digit is a serial-shaped name, not a model.
	// "USB Serial Converter" has spaces and stays. "RM520N-GL" is short and stays.
	if (!/\s/.test(text) && text.length >= 16 && /\d/.test(text)) return null;
	return text;
}

export function describeUsbPort(
	board: UsbTreeBoard,
	controller: string | null,
	portPath: string | null,
): UsbPortPlacement {
	if (portPath === null) {
		return {
			label: null,
			name: "USB root hub",
			scope: "root",
			socketLabel: null,
			socketName: null,
			hubPort: null,
		};
	}
	if (board !== "rock-5b-plus" || controller === null) {
		return genericPort(portPath);
	}
	const onController = ROCK_5B_PLUS_PORTS.filter(
		(spec) => spec.controller === controller,
	);
	const exact = onController.find((spec) => spec.portPath === portPath);
	if (exact) {
		return {
			label: exact.label,
			name: exact.name,
			scope: exact.scope,
			socketLabel: exact.label,
			socketName: exact.label === null ? null : exact.name,
			hubPort: null,
		};
	}
	let best: RockPortSpec | null = null;
	for (const spec of onController) {
		if (!portPath.startsWith(`${spec.portPath}.`)) continue;
		if (best === null || spec.portPath.length > best.portPath.length) {
			best = spec;
		}
	}
	if (best === null) return genericPort(portPath);
	const last = portPath.slice(portPath.lastIndexOf(".") + 1);
	const hubPort = /^\d+$/.test(last) ? Number(last) : null;
	return {
		label: hubPort === null ? null : `>hub.${hubPort}`,
		name: hubPort === null ? genericPort(portPath).name : `Hub port ${hubPort}`,
		scope: "hub-port",
		socketLabel: best.label,
		socketName: best.name,
		hubPort,
	};
}

function genericPort(portPath: string): UsbPortPlacement {
	return {
		label: null,
		name: `USB port ${portPath}`,
		scope: "generic",
		socketLabel: null,
		socketName: null,
		hubPort: null,
	};
}

export async function readUsbTree(
	options: ReadUsbTreeOptions,
): Promise<UsbTree> {
	const readText = options.readText ?? defaultReadText;
	const board =
		options.board ?? (await detectBoard(options.sysfsRoot, readText));
	const devicesDir = join(options.sysfsRoot, "sys/bus/usb/devices");
	let names: string[];
	try {
		names = await readdir(devicesDir);
	} catch {
		return { board, roots: [] };
	}
	names.sort((a, b) => a.localeCompare(b, "en"));

	const drafts: Draft[] = [];
	for (const name of names) {
		if (!DEVICE_NAME.test(name)) continue;
		const draft = await readDevice(devicesDir, name, readText);
		if (draft !== null) drafts.push(draft);
	}

	const byName = new Map(drafts.map((draft) => [draft.kernelName, draft]));
	const withSpeed = drafts.map((draft) => ({
		draft,
		rootSpeedClass: rootSpeedClass(draft, byName),
	}));
	const preferred = withSpeed.map((item) => ({
		...item,
		key: nodeKey(
			item.draft.controller,
			item.rootSpeedClass,
			item.draft.portPath,
		),
	}));
	const seen = new Map<string, number>();
	for (const item of preferred) {
		seen.set(item.key, (seen.get(item.key) ?? 0) + 1);
	}
	const keyByKernel = new Map<string, string>();
	for (const item of preferred) {
		const unique = (seen.get(item.key) ?? 0) === 1;
		const key = unique ? item.key : `${item.key}:${item.draft.kernelName}`;
		keyByKernel.set(item.draft.kernelName, key);
	}

	const nodes = new Map<string, MutableNode>();
	for (const item of preferred) {
		const key = keyByKernel.get(item.draft.kernelName);
		if (key === undefined) continue;
		const parentKernel = parentKernelName(item.draft.kernelName);
		const parentKey =
			parentKernel === null ? null : (keyByKernel.get(parentKernel) ?? null);
		nodes.set(key, {
			key,
			parentKey,
			kernelName: item.draft.kernelName,
			controller: item.draft.controller,
			portPath: item.draft.portPath,
			rootSpeedClass: item.rootSpeedClass,
			speedMbps: item.draft.speedMbps,
			speedClass: item.draft.speedClass,
			usbVersion: item.draft.usbVersion,
			vendorId: item.draft.vendorId,
			productId: item.draft.productId,
			product: item.draft.product,
			deviceClass: item.draft.deviceClass,
			configurationCount: item.draft.configurationCount,
			maxPorts: item.draft.maxPorts,
			kind: item.draft.kind,
			drivers: item.draft.drivers,
			netNames: item.draft.netNames,
			videoNames: item.draft.videoNames,
			port: describeUsbPort(board, item.draft.controller, item.draft.portPath),
			children: [],
		});
	}

	const roots: MutableNode[] = [];
	for (const node of nodes.values()) {
		const parent =
			node.parentKey === null ? undefined : nodes.get(node.parentKey);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	sortNodes(roots);
	return { board, roots };
}

type Draft = {
	kernelName: string;
	controller: string | null;
	portPath: string | null;
	speedMbps: number | null;
	speedClass: UsbLinkClass;
	usbVersion: string | null;
	vendorId: string | null;
	productId: string | null;
	product: string | null;
	deviceClass: number | null;
	configurationCount: number | null;
	maxPorts: number | null;
	kind: UsbDeviceKind;
	drivers: string[];
	netNames: string[];
	videoNames: string[];
};

type MutableNode = Omit<UsbTreeNode, "children"> & {
	children: UsbTreeNode[];
};

async function defaultReadText(path: string): Promise<string> {
	return await readFile(path, "utf8");
}

async function detectBoard(
	sysfsRoot: string,
	readText: (path: string) => Promise<string>,
): Promise<UsbTreeBoard> {
	const model = boardFromIdentityText(
		await readMaybe(join(sysfsRoot, "proc/device-tree/model"), readText),
	);
	if (model !== "generic") return model;
	return boardFromIdentityText(
		await readMaybe(join(sysfsRoot, "proc/device-tree/compatible"), readText),
	);
}

async function readDevice(
	devicesDir: string,
	kernelName: string,
	readText: (path: string) => Promise<string>,
): Promise<Draft | null> {
	let devicePath: string;
	try {
		devicePath = await realpath(join(devicesDir, kernelName));
	} catch {
		return null;
	}
	const attrs = await readAllowlisted(devicePath, readText);
	const endpoints = await readEndpoints(devicePath);
	const speedMbps = parseSpeed(attrs.speed);
	const deviceClass = parseHexByte(attrs.bDeviceClass);
	const maxPorts = parseDecimal(attrs.maxchild);
	const drivers = [...endpoints.drivers].sort((a, b) =>
		a.localeCompare(b, "en"),
	);
	return {
		kernelName,
		controller: controllerOf(devicePath),
		portPath: portPathOf(kernelName),
		speedMbps,
		speedClass: linkClass(speedMbps),
		usbVersion: parseVersion(attrs.version),
		vendorId: parseHexId(attrs.idVendor),
		productId: parseHexId(attrs.idProduct),
		product: sanitizeUsbProduct(attrs.product),
		deviceClass,
		configurationCount: parseHexByte(attrs.bNumConfigurations),
		maxPorts,
		kind: classify({
			deviceClass,
			maxPorts,
			drivers,
			hasPhy80211: endpoints.hasPhy80211,
			hasVideo: endpoints.videos.size > 0,
		}),
		drivers,
		netNames: [...endpoints.nets].sort((a, b) => a.localeCompare(b, "en")),
		videoNames: [...endpoints.videos].sort((a, b) => a.localeCompare(b, "en")),
	};
}

function classify(args: {
	deviceClass: number | null;
	maxPorts: number | null;
	drivers: readonly string[];
	hasPhy80211: boolean;
	hasVideo: boolean;
}): UsbDeviceKind {
	if (args.drivers.some((driver) => MODEM_DRIVERS.has(driver))) return "modem";
	if (args.hasPhy80211) return "wifi";
	if (args.hasVideo || args.drivers.includes("uvcvideo")) return "capture";
	if (args.deviceClass === 0x09 || args.drivers.includes("hub")) return "hub";
	if (args.maxPorts !== null && args.maxPorts > 0) return "hub";
	return "other";
}

async function readAllowlisted(
	devicePath: string,
	readText: (path: string) => Promise<string>,
): Promise<Record<DeviceAttr, string | null>> {
	const entries = await Promise.all(
		USB_DEVICE_ATTRIBUTE_ALLOWLIST.map(async (name) => [
			name,
			await readMaybe(join(devicePath, name), readText),
		]),
	);
	return Object.fromEntries(entries) as Record<DeviceAttr, string | null>;
}

async function readEndpoints(devicePath: string): Promise<{
	drivers: Set<string>;
	nets: Set<string>;
	videos: Set<string>;
	hasPhy80211: boolean;
}> {
	const drivers = new Set<string>();
	const nets = new Set<string>();
	const videos = new Set<string>();
	let hasPhy80211 = false;
	const absorb = async (dir: string) => {
		const found = await readNetAndVideo(dir);
		for (const name of found.nets) nets.add(name);
		for (const name of found.videos) videos.add(name);
		if (found.hasPhy80211) hasPhy80211 = true;
	};
	await absorb(devicePath);
	let entries: string[] = [];
	try {
		entries = await readdir(devicePath);
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		if (!INTERFACE_NAME.test(entry)) continue;
		const iface = join(devicePath, entry);
		const driver = await readDriverName(join(iface, "driver"));
		if (driver !== null) drivers.add(driver);
		await absorb(iface);
	}
	return { drivers, nets, videos, hasPhy80211 };
}

async function readNetAndVideo(dir: string): Promise<{
	nets: string[];
	videos: string[];
	hasPhy80211: boolean;
}> {
	const nets = await listEndpointNames(join(dir, "net"));
	let hasPhy80211 = false;
	for (const name of nets) {
		if (await linkExists(join(dir, "net", name, "phy80211"))) {
			hasPhy80211 = true;
		}
	}
	const videos = await listEndpointNames(join(dir, "video4linux"));
	return { nets, videos, hasPhy80211 };
}

async function listEndpointNames(dir: string): Promise<string[]> {
	try {
		const names = await readdir(dir);
		return names.filter((name) => ENDPOINT_NAME.test(name));
	} catch {
		return [];
	}
}

async function readDriverName(path: string): Promise<string | null> {
	try {
		const name = basename(await readlink(path));
		return DRIVER_NAME.test(name) ? name : null;
	} catch {
		return null;
	}
}

async function linkExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function readMaybe(
	path: string,
	readText: (path: string) => Promise<string>,
): Promise<string | null> {
	try {
		const text = await readText(path);
		const trimmed = text.replaceAll("\0", "").trim();
		return trimmed.length === 0 ? null : trimmed;
	} catch {
		return null;
	}
}

function controllerOf(devicePath: string): string | null {
	const match = devicePath
		.toLowerCase()
		.match(/(?:^|\/)([0-9a-f]+\.usb)(?=\/|$)/);
	return match?.[1] ?? null;
}

function portPathOf(kernelName: string): string | null {
	const bus = busNumber(kernelName);
	if (bus === null || kernelName.startsWith("usb")) return null;
	return kernelName.slice(bus.length + 1);
}

function parentKernelName(kernelName: string): string | null {
	const bus = busNumber(kernelName);
	if (bus === null || kernelName.startsWith("usb")) return null;
	const path = kernelName.slice(bus.length + 1);
	const dot = path.lastIndexOf(".");
	if (dot === -1) return `usb${bus}`;
	return `${bus}-${path.slice(0, dot)}`;
}

function busNumber(kernelName: string): string | null {
	const root = /^usb(\d+)$/.exec(kernelName);
	if (root?.[1]) return root[1];
	const device = /^(\d+)-\d+(?:\.\d+)*$/.exec(kernelName);
	return device?.[1] ?? null;
}

function rootKernelName(kernelName: string): string | null {
	const bus = busNumber(kernelName);
	return bus === null ? null : `usb${bus}`;
}

function rootSpeedClass(
	draft: Draft,
	byName: Map<string, Draft>,
): UsbLinkClass {
	const rootName = rootKernelName(draft.kernelName);
	if (rootName === null) return draft.speedClass;
	return byName.get(rootName)?.speedClass ?? draft.speedClass;
}

function nodeKey(
	controller: string | null,
	rootSpeed: UsbLinkClass,
	portPath: string | null,
): string {
	return `${controller ?? "unknown"}:${rootSpeed}:${portPath ?? "root"}`;
}

function parseSpeed(raw: string | null): number | null {
	if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0 || value > 40000) return null;
	return value;
}

function linkClass(mbps: number | null): UsbLinkClass {
	if (mbps === null) return "unknown";
	if (mbps >= 5000) return "usb3";
	if (mbps >= 480) return "usb2";
	if (mbps >= 12) return "full";
	if (mbps >= 1.5) return "low";
	return "unknown";
}

function parseVersion(raw: string | null): string | null {
	if (raw === null || !/^\d+\.\d{2}$/.test(raw)) return null;
	return raw;
}

function parseHexId(raw: string | null): string | null {
	if (raw === null) return null;
	const match = /^(?:0x)?([0-9a-f]{4})$/i.exec(raw);
	return match?.[1]?.toLowerCase() ?? null;
}

function parseHexByte(raw: string | null): number | null {
	if (raw === null) return null;
	const match = /^(?:0x)?([0-9a-f]{1,2})$/i.exec(raw);
	if (match?.[1] === undefined) return null;
	return Number.parseInt(match[1], 16);
}

function parseDecimal(raw: string | null): number | null {
	if (raw === null || !/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value > 32) return null;
	return value;
}

function sortNodes(nodes: UsbTreeNode[]): void {
	nodes.sort((a, b) => {
		const byPort = comparePortPath(a.portPath, b.portPath);
		if (byPort !== 0) return byPort;
		return a.kernelName.localeCompare(b.kernelName, "en");
	});
	for (const node of nodes) {
		if (node.children.length > 0) {
			sortNodes(node.children as UsbTreeNode[]);
		}
	}
}

function comparePortPath(a: string | null, b: string | null): number {
	const left = portRank(a);
	const right = portRank(b);
	const count = Math.max(left.length, right.length);
	for (let index = 0; index < count; index++) {
		const av = left[index] ?? -1;
		const bv = right[index] ?? -1;
		if (av !== bv) return av - bv;
	}
	return 0;
}

function portRank(path: string | null): number[] {
	if (path === null || path.length === 0) return [];
	return path.split(".").map((part) => {
		const value = Number(part);
		return Number.isInteger(value) ? value : 0;
	});
}
