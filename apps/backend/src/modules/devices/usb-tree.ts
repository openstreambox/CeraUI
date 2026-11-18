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

/** What the socket can do, not the speed the device negotiated. */
export type UsbPortClass = "usb2" | "usb3";

export type UsbPortColour = "blue" | "black";

export type UsbPortPlacement = {
	/** Board label (`A3-bot`, `C`, `>hub.2>hub.3`), or null when the board has no map. */
	readonly label: string | null;
	/** Printed name ("Lower blue port", "Hub port 2", "USB 2 port 1"). */
	readonly name: string;
	readonly scope: UsbPortScope;
	/** Physical socket this hub port hangs from, when there is one. */
	readonly socketLabel: string | null;
	readonly socketName: string | null;
	/** Downstream port on the parent hub. Null on the socket itself. */
	readonly hubPort: number | null;
	/** USB 2 or USB 3 wires of this socket. Null when the board has no map. */
	readonly portClass: UsbPortClass | null;
	/** Blue USB 3 A port or black USB 2 A port. Null for USB-C and internal slots. */
	readonly colour: UsbPortColour | null;
};

export type RockPortSpec = {
	readonly controller: string;
	readonly portPath: string;
	readonly label: string | null;
	readonly name: string;
	readonly scope: "socket" | "built-in";
	readonly portClass: UsbPortClass;
	readonly colour: UsbPortColour | null;
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
		portClass: "usb3",
		colour: "blue",
	},
	{
		controller: "fc8c0000.usb",
		portPath: "1",
		label: "A3-top",
		name: "Upper blue port",
		scope: "socket",
		portClass: "usb3",
		colour: "blue",
	},
	{
		controller: "fcd00000.usb",
		portPath: "1",
		label: "A3-top",
		name: "Upper blue port",
		scope: "socket",
		portClass: "usb3",
		colour: "blue",
	},
	{
		controller: "fc400000.usb",
		portPath: "1",
		label: "A3-bot",
		name: "Lower blue port",
		scope: "socket",
		portClass: "usb3",
		colour: "blue",
	},
	{
		controller: "fc000000.usb",
		portPath: "1",
		label: "C",
		name: "USB-C data port",
		scope: "socket",
		portClass: "usb3",
		colour: null,
	},
	{
		controller: "fc800000.usb",
		portPath: "1",
		label: null,
		name: "Onboard hub",
		scope: "built-in",
		portClass: "usb2",
		colour: null,
	},
	{
		controller: "fc800000.usb",
		portPath: "1.1",
		label: "A2-bot",
		name: "Lower black port",
		scope: "socket",
		portClass: "usb2",
		colour: "black",
	},
	{
		controller: "fc800000.usb",
		portPath: "1.2",
		label: "A2-top",
		name: "Upper black port",
		scope: "socket",
		portClass: "usb2",
		colour: "black",
	},
	{
		controller: "fc800000.usb",
		portPath: "1.3",
		label: "BT",
		name: "Bluetooth",
		scope: "built-in",
		portClass: "usb2",
		colour: null,
	},
	{
		controller: "fc800000.usb",
		portPath: "1.4",
		label: "M2B",
		name: "Modem slot inside",
		scope: "socket",
		portClass: "usb2",
		colour: null,
	},
];

const MODEM_DRIVERS: ReadonlySet<string> = new Set([
	"qmi_wwan",
	"cdc_mbim",
	"option",
]);

const MAC_ADDRESS = /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
const MAC_IFACE = /^(?:en|wl|ww)x[0-9a-f]{12}$/i;
const HEX_RUN = /[0-9a-f]{12}/i;
const PRIVATE_WORD = /\b(?:imei|iccid|imeisv)\b/i;
const INTERFACE_NAME = /:\d+\.\d+$/;
const DEVICE_NAME = /^usb\d+$|^\d+-\d+(?:\.\d+)*$/;
const ENDPOINT_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/;
const DRIVER_NAME = /^[a-z0-9_]+$/;
const PCI_CONTROLLER =
	/([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])(?=\/usb\d+(?:\/|$))/;

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
	/**
	 * Shared by the USB 2 and USB 3 halves of one socket.
	 * On a ROCK 5B+ this is the board label (`A3-bot`, `A3-bot>hub.2`).
	 * Elsewhere it comes from the kernel `usbN-portM/peer` link.
	 */
	readonly socketKey: string;
	/**
	 * `present` for a device the kernel enumerated.
	 * `nothing-detected` for a mapped socket whose controller brought up
	 * no host bus. That is not a failed read.
	 */
	readonly presence: "present" | "nothing-detected";
	readonly children: readonly UsbTreeNode[];
};

export type UsbTreeStatus = "ok" | "unavailable";

export type UsbTree = {
	readonly board: UsbTreeBoard;
	/** `unavailable` when `/sys/bus/usb/devices` could not be read. */
	readonly status: UsbTreeStatus;
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
	const text = raw
		.replaceAll("\0", "")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	if (text.length === 0 || text.length > 80) return null;
	if (PRIVATE_WORD.test(text)) return null;
	if (text.split(/\s+/).some((token) => tokenLooksSecret(token))) return null;
	return text;
}

/** A whitespace token that is a MAC, a long digit run, or a hex serial. */
function tokenLooksSecret(token: string): boolean {
	if (MAC_ADDRESS.test(token)) return true;
	if (/\d{10,}/.test(token)) return true;
	if (/^[0-9a-f]{10,}$/i.test(token)) {
		return (token.match(/\d/g)?.length ?? 0) >= 4;
	}
	return /serial/i.test(token) && /\d/.test(token);
}

export type DescribeUsbPortOptions = {
	/** 1-based index of this controller among the board's controllers, sorted by address. */
	readonly ordinal?: number;
	/** Used for a generic port when the root hub's speed is known. */
	readonly portClass?: UsbPortClass | null;
};

export function describeUsbPort(
	board: UsbTreeBoard,
	controller: string | null,
	portPath: string | null,
	options?: DescribeUsbPortOptions,
): UsbPortPlacement {
	const ordinal = options?.ordinal ?? 1;
	const hinted = options?.portClass ?? null;
	if (portPath === null) {
		return {
			label: null,
			name:
				board === "rock-5b-plus" ? "USB root hub" : `USB ${ordinal} root hub`,
			scope: "root",
			socketLabel: null,
			socketName: null,
			hubPort: null,
			portClass: null,
			colour: null,
		};
	}
	if (board !== "rock-5b-plus" || controller === null) {
		return genericPort(portPath, ordinal, hinted);
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
			portClass: exact.portClass,
			colour: exact.colour,
		};
	}
	let best: RockPortSpec | null = null;
	for (const spec of onController) {
		if (!portPath.startsWith(`${spec.portPath}.`)) continue;
		if (best === null || spec.portPath.length > best.portPath.length) {
			best = spec;
		}
	}
	if (best === null) return genericPort(portPath, ordinal, hinted);
	const rest = portPath.slice(best.portPath.length + 1);
	const parts = rest.split(".").filter((part) => /^\d+$/.test(part));
	const last = parts[parts.length - 1];
	const hubPort = last === undefined ? null : Number(last);
	const chain = parts.map((part) => `>hub.${part}`).join("");
	return {
		label: chain.length === 0 ? null : chain,
		name:
			parts.length === 0
				? genericPort(portPath, ordinal, hinted).name
				: parts.map((part) => `Hub port ${part}`).join(", "),
		scope: "hub-port",
		socketLabel: best.label,
		socketName: best.name,
		hubPort,
		portClass: best.portClass,
		colour: best.colour,
	};
}

function genericPort(
	portPath: string,
	ordinal: number,
	portClass: UsbPortClass | null,
): UsbPortPlacement {
	return {
		label: null,
		name: `USB ${ordinal} port ${portPath}`,
		scope: "generic",
		socketLabel: null,
		socketName: null,
		hubPort: null,
		portClass,
		colour: null,
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
		return { board, status: "unavailable", roots: [] };
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
	const ordinals = controllerOrdinals(drafts.map((draft) => draft.controller));

	const nodes = new Map<string, MutableNode>();
	for (const item of preferred) {
		const key = keyByKernel.get(item.draft.kernelName);
		if (key === undefined) continue;
		const parentKernel = parentKernelName(item.draft.kernelName);
		const parentKey =
			parentKernel === null ? null : (keyByKernel.get(parentKernel) ?? null);
		const hinted =
			item.rootSpeedClass === "usb2" || item.rootSpeedClass === "usb3"
				? item.rootSpeedClass
				: null;
		const ordinal =
			item.draft.controller === null
				? 1
				: (ordinals.get(item.draft.controller) ?? 1);
		const port = describeUsbPort(
			board,
			item.draft.controller,
			item.draft.portPath,
			hinted === null ? { ordinal } : { ordinal, portClass: hinted },
		);
		const socketKey =
			board === "rock-5b-plus" && port.scope !== "generic"
				? rockSocketKey(port, item.draft.controller, item.draft.portPath)
				: await genericSocketKey(devicesDir, item.draft, byName);
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
			port,
			socketKey,
			presence: "present",
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
	if (board === "rock-5b-plus" && drafts.length > 0) {
		const seen = new Set(
			drafts.flatMap((draft) =>
				draft.controller === null ? [] : [draft.controller],
			),
		);
		for (const extra of undetectedSockets(seen)) roots.push(extra);
	}
	sortNodes(roots);
	return { board, status: "ok", roots };
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
		configurationCount: parseDecimal(attrs.bNumConfigurations),
		maxPorts,
		kind: classify({
			deviceClass,
			maxPorts,
			drivers,
			hasPhy80211: endpoints.hasPhy80211,
			hasVideo: endpoints.videos.size > 0,
		}),
		drivers,
		netNames: neutralNetNames(endpoints.nets),
		videoNames: [...endpoints.videos]
			.filter((name) => !nameLooksSecret(name))
			.sort((a, b) => a.localeCompare(b, "en")),
	};
}

function nameLooksSecret(name: string): boolean {
	return MAC_IFACE.test(name) || HEX_RUN.test(name);
}

/**
 * systemd names USB netdevs `wlx<MAC>` and `enx<MAC>`. Those names are
 * replaced with `net0`, `net1` so the MAC never leaves this module.
 */
function neutralNetNames(names: Iterable<string>): string[] {
	const kept: string[] = [];
	const hidden: string[] = [];
	for (const name of names) {
		if (nameLooksSecret(name)) hidden.push(name);
		else if (ENDPOINT_NAME.test(name)) kept.push(name);
	}
	hidden.sort((a, b) => a.localeCompare(b, "en"));
	const replaced = hidden.map((_, index) => `net${index}`);
	return [...kept, ...replaced].sort((a, b) => a.localeCompare(b, "en"));
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
	const lower = devicePath.toLowerCase();
	const platform = lower.match(/(?:^|\/)([0-9a-f]+\.usb)(?=\/|$)/);
	if (platform?.[1]) return platform[1];
	return lower.match(PCI_CONTROLLER)?.[1] ?? null;
}

function controllerOrdinals(
	controllers: readonly (string | null)[],
): Map<string, number> {
	const unique = [
		...new Set(controllers.filter((item): item is string => item !== null)),
	].sort((a, b) => a.localeCompare(b, "en"));
	return new Map(unique.map((controller, index) => [controller, index + 1]));
}

function rockSocketKey(
	port: UsbPortPlacement,
	controller: string | null,
	portPath: string | null,
): string {
	if (port.scope === "root") return `${controller ?? "unknown"}:root`;
	if (port.label !== null && !port.label.startsWith(">hub.")) return port.label;
	if (port.socketLabel !== null && port.label !== null) {
		return `${port.socketLabel}${port.label}`;
	}
	if (port.socketLabel !== null) return port.socketLabel;
	return `${controller ?? "unknown"}:${portPath ?? "root"}`;
}

/**
 * A mapped socket whose controllers never enumerated a host bus.
 * On the ROCK USB-C port this is the usual no-partner state: no xhci
 * child under fc000000.usb. The tree read itself succeeded.
 */
function undetectedSockets(seen: ReadonlySet<string>): UsbTreeNode[] {
	const byLabel = new Map<string, RockPortSpec[]>();
	for (const spec of ROCK_5B_PLUS_PORTS) {
		if (spec.label === null) continue;
		const group = byLabel.get(spec.label) ?? [];
		group.push(spec);
		byLabel.set(spec.label, group);
	}
	const found: UsbTreeNode[] = [];
	for (const [label, specs] of byLabel) {
		if (specs.some((spec) => seen.has(spec.controller))) continue;
		const spec = specs[0];
		if (spec === undefined) continue;
		const port = describeUsbPort(
			"rock-5b-plus",
			spec.controller,
			spec.portPath,
		);
		found.push({
			key: `${spec.controller}:nothing-detected:${spec.portPath}`,
			parentKey: null,
			kernelName: spec.controller,
			controller: spec.controller,
			portPath: spec.portPath,
			rootSpeedClass: "unknown",
			speedMbps: null,
			speedClass: "unknown",
			usbVersion: null,
			vendorId: null,
			productId: null,
			product: null,
			deviceClass: null,
			configurationCount: null,
			maxPorts: null,
			kind: "other",
			drivers: [],
			netNames: [],
			videoNames: [],
			port,
			socketKey: label,
			presence: "nothing-detected",
			children: [],
		});
	}
	return found;
}

async function genericSocketKey(
	devicesDir: string,
	draft: Draft,
	byName: Map<string, Draft>,
): Promise<string> {
	const controller = draft.controller ?? "unknown";
	if (draft.portPath === null) return `${controller}:root`;
	const rootPort = draft.portPath.split(".")[0] ?? draft.portPath;
	const rest = draft.portPath.slice(rootPort.length);
	const rootName = rootKernelName(draft.kernelName);
	const mine = `${controller}:${rootPort}`;
	const peer =
		rootName === null
			? null
			: await readRootPeer(devicesDir, rootName, rootPort);
	if (peer === null) return `${mine}${rest}`;
	const peerController =
		byName.get(`usb${peer.bus}`)?.controller ?? `bus${peer.bus}`;
	const other = `${peerController}:${peer.port}`;
	const base =
		mine === other
			? mine
			: [mine, other].sort((a, b) => a.localeCompare(b, "en")).join("+");
	return `${base}${rest}`;
}

/** `usbN-portM/peer` names the companion port. The link target is not file content. */
async function readRootPeer(
	devicesDir: string,
	rootKernel: string,
	rootPort: string,
): Promise<{ bus: string; port: string } | null> {
	const bus = rootKernel.slice(3);
	const peerPath = join(
		devicesDir,
		rootKernel,
		`${bus}-0:1.0`,
		`usb${bus}-port${rootPort}`,
		"peer",
	);
	try {
		const target = await readlink(peerPath);
		const match = /usb(\d+)-port(\d+)/.exec(target);
		if (match?.[1] === undefined || match[2] === undefined) return null;
		return { bus: match[1], port: match[2] };
	} catch {
		return null;
	}
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
