import { describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import {
	boardFromIdentityText,
	describeUsbPort,
	ROCK_5B_PLUS_PORTS,
	readUsbTree,
	sanitizeUsbProduct,
	USB_DEVICE_ATTRIBUTE_ALLOWLIST,
	type UsbTree,
	type UsbTreeBoard,
	type UsbTreeNode,
} from "./usb-tree.ts";

const SERIAL = "SECRET-SERIAL-9f3a";
const MAC = "aa:bb:cc:dd:ee:ff";
const IMEI = "490154203237518";
const ICCID = "89014103211118510720";

type FixtureNet = { name: string; phy80211?: boolean };
type FixtureInterface = {
	suffix: string;
	driver?: string;
	net?: FixtureNet[];
	video?: string[];
};
type FixtureDevice = {
	name: string;
	controller: string;
	platformPrefix?: string;
	/**
	 * ehci: controller/usbN (ROCK onboard and USB 2 host).
	 * xhci: controller/xhci-hcd.N.auto/usbN.
	 * pci: pciDDDD:BB/DDDD:BB:DD.F/usbN.
	 */
	busDriver?: "ehci" | "xhci" | "pci";
	xhciIndex?: string;
	speed?: string;
	version?: string;
	deviceClass?: string;
	configurations?: string;
	vendor?: string;
	productId?: string;
	product?: string;
	maxchild?: string;
	planted?: Record<string, string>;
	interfaces?: FixtureInterface[];
};

function flatten(nodes: readonly UsbTreeNode[]): UsbTreeNode[] {
	const out: UsbTreeNode[] = [];
	for (const node of nodes) {
		out.push(node);
		out.push(...flatten(node.children));
	}
	return out;
}

function nodeNamed(tree: UsbTree, kernelName: string): UsbTreeNode {
	const found = flatten(tree.roots).find(
		(node) => node.kernelName === kernelName,
	);
	if (found === undefined) {
		throw new Error(`missing ${kernelName}`);
	}
	return found;
}

async function withTree(
	devices: FixtureDevice[],
	board: UsbTreeBoard | "detect",
	extra?: (root: string) => Promise<void>,
	readText?: (path: string) => Promise<string>,
): Promise<UsbTree> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-usb-tree-"));
	try {
		await writeFixture(root, devices);
		if (extra) await extra(root);
		return await readUsbTree({
			sysfsRoot: root,
			...(board === "detect" ? {} : { board }),
			...(readText === undefined ? {} : { readText }),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeFixture(
	root: string,
	devices: FixtureDevice[],
): Promise<void> {
	const flat = join(root, "sys/bus/usb/devices");
	await mkdir(flat, { recursive: true });
	for (const device of devices) {
		const physical = physicalDir(root, device);
		await mkdir(physical, { recursive: true });
		await writeAttrs(physical, device);
		for (const [name, value] of Object.entries(device.planted ?? {})) {
			await writeFile(join(physical, name), value);
		}
		for (const iface of device.interfaces ?? []) {
			const ifaceName = interfaceDirName(device.name, iface.suffix);
			const ifaceDir = join(physical, ifaceName);
			await mkdir(ifaceDir, { recursive: true });
			await writeFile(join(ifaceDir, "serial"), SERIAL);
			if (iface.driver) {
				const driverDir = join(root, "sys/bus/usb/drivers", iface.driver);
				await mkdir(driverDir, { recursive: true });
				await symlink(driverDir, join(ifaceDir, "driver"));
			}
			for (const net of iface.net ?? []) {
				const netDir = join(ifaceDir, "net", net.name);
				await mkdir(netDir, { recursive: true });
				if (net.phy80211) {
					const phy = join(root, "sys/class/ieee80211/phy0");
					await mkdir(phy, { recursive: true });
					await writeFile(join(phy, "macaddress"), `${MAC}\n`);
					await symlink(phy, join(netDir, "phy80211"));
				}
			}
			for (const video of iface.video ?? []) {
				await mkdir(join(ifaceDir, "video4linux", video), {
					recursive: true,
				});
			}
			await symlink(ifaceDir, join(flat, ifaceName));
		}
		await symlink(physical, join(flat, device.name));
	}
}

function interfaceDirName(deviceName: string, suffix: string): string {
	if (deviceName.startsWith("usb")) {
		return `${deviceName.slice(3)}-0:${suffix}`;
	}
	return `${deviceName}:${suffix}`;
}

function busOf(deviceName: string): string {
	return deviceName.startsWith("usb")
		? deviceName.slice(3)
		: (deviceName.split("-")[0] ?? "");
}

function physicalDir(root: string, device: FixtureDevice): string {
	const bus = busOf(device.name);
	const driver = device.busDriver ?? "xhci";
	const parts = [root, "sys/devices"];
	if (driver === "pci") {
		const [segment, busId] = device.controller.split(":");
		parts.push(`pci${segment}:${busId}`, device.controller);
	} else {
		parts.push("platform");
		if (device.platformPrefix) parts.push(device.platformPrefix);
		parts.push(device.controller);
		if (driver === "xhci") {
			parts.push(`xhci-hcd.${device.xhciIndex ?? "0"}.auto`);
		}
	}
	parts.push(`usb${bus}`);
	if (!device.name.startsWith("usb")) {
		const path = device.name.slice(bus.length + 1);
		const segments = path.split(".");
		for (let index = 0; index < segments.length; index++) {
			parts.push(`${bus}-${segments.slice(0, index + 1).join(".")}`);
		}
	}
	return join(...parts);
}

async function writeAttrs(dir: string, device: FixtureDevice): Promise<void> {
	const pairs: [string, string | undefined][] = [
		["speed", device.speed],
		["version", device.version],
		["bDeviceClass", device.deviceClass],
		["bNumConfigurations", device.configurations],
		["idVendor", device.vendor],
		["idProduct", device.productId],
		["product", device.product],
		["maxchild", device.maxchild],
	];
	for (const [name, value] of pairs) {
		if (value === undefined) continue;
		await writeFile(join(dir, name), `${value}\n`);
	}
}

function rootHub(
	name: string,
	controller: string,
	speed: string,
	prefix?: string,
): FixtureDevice {
	return {
		name,
		controller,
		...(prefix === undefined ? {} : { platformPrefix: prefix }),
		speed,
		version: speed === "5000" ? " 3.10" : " 2.00",
		deviceClass: "09",
		configurations: "01",
		maxchild: "1",
		interfaces: [{ suffix: "1.0", driver: "hub" }],
	};
}

describe("ROCK 5B+ port map", () => {
	it("names J11, the USB 3 A ports and the onboard hub ports", () => {
		const byLabel = (label: string) =>
			ROCK_5B_PLUS_PORTS.filter((port) => port.label === label);

		expect(byLabel("C").map((port) => port.controller)).toEqual([
			"fc000000.usb",
		]);
		expect(byLabel("C")[0]?.name).toBe("USB-C data port");
		expect(
			byLabel("A3-top")
				.map((port) => port.controller)
				.sort(),
		).toEqual(["fc880000.usb", "fc8c0000.usb", "fcd00000.usb"].sort());
		expect(byLabel("A3-bot")).toEqual([
			{
				controller: "fc400000.usb",
				portPath: "1",
				label: "A3-bot",
				name: "Lower blue port",
				scope: "socket",
				portClass: "usb3",
				colour: "blue",
			},
		]);
		expect(byLabel("A2-top")[0]?.portPath).toBe("1.2");
		expect(byLabel("A2-bot")[0]?.portPath).toBe("1.1");
		expect(byLabel("M2B")[0]?.name).toBe("Modem slot inside");
		expect(byLabel("BT")[0]?.name).toBe("Bluetooth");
		expect(byLabel("A3-top")[0]?.portClass).toBe("usb3");
		expect(byLabel("A3-top")[0]?.colour).toBe("blue");
		expect(byLabel("A2-top")[0]?.portClass).toBe("usb2");
		expect(byLabel("A2-top")[0]?.colour).toBe("black");
		expect(byLabel("M2B")[0]?.portClass).toBe("usb2");
		expect(byLabel("M2B")[0]?.scope).toBe("socket");
		expect(byLabel("C")[0]?.portClass).toBe("usb3");
		expect(describeUsbPort("rock-5b-plus", "fc400000.usb", "1.2.3").label).toBe(
			">hub.2>hub.3",
		);
		expect(describeUsbPort("rock-5b-plus", "fc400000.usb", "1.3.3").label).toBe(
			">hub.3>hub.3",
		);
	});

	it("uses generic names when the board is not a ROCK 5B+", () => {
		expect(describeUsbPort("generic", "fc000000.usb", "1")).toEqual({
			label: null,
			name: "USB 1 port 1",
			scope: "generic",
			socketLabel: null,
			socketName: null,
			hubPort: null,
			portClass: null,
			colour: null,
		});
		expect(sanitizeUsbProduct("RM520N-GL")).toBe("RM520N-GL");
		expect(sanitizeUsbProduct("802.11ac NIC")).toBe("802.11ac NIC");
		expect(sanitizeUsbProduct("TL-WN823N")).toBe("TL-WN823N");
		expect(sanitizeUsbProduct("DW5821e Snapdragon X20 LTE")).toBe(
			"DW5821e Snapdragon X20 LTE",
		);
		expect(sanitizeUsbProduct("USB 10/100/1000 LAN 001122334455")).toBeNull();
		expect(sanitizeUsbProduct("Cam Link 4K 0005D4F2A1B3")).toBeNull();
		expect(sanitizeUsbProduct("Modem SN 8612345678901")).toBeNull();
		expect(sanitizeUsbProduct("USB Serial Converter")).toBe(
			"USB Serial Converter",
		);
		for (const kept of [
			"RTL8812BU",
			"RTL8188EUS",
			"MT7921AUN",
			"USB3.0-CRW",
			"RM520N-GL",
			"C920",
			"Archer T3U Plus",
		]) {
			expect(sanitizeUsbProduct(kept)).toBe(kept);
		}
		expect(sanitizeUsbProduct("Cam Link 4K 2C1MX4A01234")).toBeNull();
		expect(sanitizeUsbProduct("Capture A1B2C3D4E5F6G7H8")).toBeNull();
		expect(sanitizeUsbProduct("A1B2C3D4E5F6G7H8")).toBeNull();
		expect(boardFromIdentityText("Orange Pi 5 Plus")).toBe("generic");
		expect(boardFromIdentityText("Radxa ROCK 5B+")).toBe("rock-5b-plus");
		expect(boardFromIdentityText("radxa,rock-5b-plus")).toBe("rock-5b-plus");
	});
});

describe("sysfs fixtures", () => {
	it("labels the USB-C port on J11 (fc000000.usb) as a capture device", async () => {
		const tree = await withTree(
			[
				rootHub("usb9", "fc000000.usb", "480", "usbdrd3_0"),
				{
					name: "9-1",
					controller: "fc000000.usb",
					platformPrefix: "usbdrd3_0",
					speed: "480",
					version: " 2.00",
					deviceClass: "ef",
					configurations: "01",
					vendor: "0fd9",
					productId: "0067",
					product: "HD Webcam",
					interfaces: [
						{
							suffix: "1.0",
							driver: "uvcvideo",
							video: ["video0"],
						},
					],
				},
			],
			"rock-5b-plus",
		);
		const device = nodeNamed(tree, "9-1");
		expect(device.controller).toBe("fc000000.usb");
		expect(device.portPath).toBe("1");
		expect(device.port).toMatchObject({
			label: "C",
			name: "USB-C data port",
			scope: "socket",
		});
		expect(device.kind).toBe("capture");
		expect(device.speedMbps).toBe(480);
		expect(device.speedClass).toBe("usb2");
		expect(device.usbVersion).toBe("2.00");
		expect(device.videoNames).toEqual(["video0"]);
		expect(device.product).toBe("HD Webcam");
		expect(device.key).toBe("fc000000.usb:usb2:1");
		expect(device.key).not.toContain("9-1");
		expect(device.parentKey).toBe(nodeNamed(tree, "usb9").key);
		expect(
			flatten(tree.roots).every((node) => !node.kernelName.includes(":")),
		).toBe(true);
	});

	it("names both USB 3 A ports and the USB 2 side of the upper blue port", async () => {
		const tree = await withTree(
			[
				rootHub("usb8", "fcd00000.usb", "5000"),
				{
					name: "8-1",
					controller: "fcd00000.usb",
					speed: "5000",
					version: " 3.20",
					deviceClass: "00",
					vendor: "2357",
					productId: "012d",
					product: "802.11ac NIC",
					interfaces: [
						{
							suffix: "1.0",
							driver: "rtl88x2bu",
							net: [{ name: "wlan0", phy80211: true }],
						},
					],
				},
				rootHub("usb4", "fc400000.usb", "5000"),
				{
					name: "4-1",
					controller: "fc400000.usb",
					speed: "5000",
					version: " 3.20",
					deviceClass: "09",
					vendor: "0bda",
					productId: "0411",
					product: "USB3.0 Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				rootHub("usb5", "fc880000.usb", "480"),
				{
					name: "5-1",
					controller: "fc880000.usb",
					speed: "480",
					version: " 2.00",
					deviceClass: "00",
					vendor: "2357",
					productId: "0109",
					product: "802.11n NIC",
					interfaces: [
						{
							suffix: "1.0",
							net: [{ name: "wlan1", phy80211: true }],
						},
					],
				},
				rootHub("usb6", "fc8c0000.usb", "12"),
				{
					name: "6-1",
					controller: "fc8c0000.usb",
					speed: "12",
					version: " 1.10",
					deviceClass: "00",
					product: "USB Keyboard",
				},
			],
			"rock-5b-plus",
		);

		const upperUsb3 = nodeNamed(tree, "8-1");
		expect(upperUsb3.kind).toBe("wifi");
		expect(upperUsb3.speedClass).toBe("usb3");
		expect(upperUsb3.netNames).toEqual(["wlan0"]);
		expect(upperUsb3.port).toMatchObject({
			label: "A3-top",
			name: "Upper blue port",
		});

		const lowerUsb3 = nodeNamed(tree, "4-1");
		expect(lowerUsb3.kind).toBe("hub");
		expect(lowerUsb3.speedClass).toBe("usb3");
		expect(lowerUsb3.maxPorts).toBe(4);
		expect(lowerUsb3.port).toMatchObject({
			label: "A3-bot",
			name: "Lower blue port",
		});

		const upperUsb2 = nodeNamed(tree, "5-1");
		expect(upperUsb2.kind).toBe("wifi");
		expect(upperUsb2.speedClass).toBe("usb2");
		expect(upperUsb2.port.label).toBe("A3-top");
		expect(upperUsb2.controller).not.toBe(upperUsb3.controller);

		const slow = nodeNamed(tree, "6-1");
		expect(slow.speedClass).toBe("full");
		expect(slow.port).toMatchObject({
			label: "A3-top",
			name: "Upper blue port",
		});
	});

	it("keeps the USB 2 and USB 3 views of one socket as two nodes", async () => {
		const tree = await withTree(
			[
				rootHub("usb1", "fc400000.usb", "480"),
				{
					name: "1-1",
					controller: "fc400000.usb",
					speed: "480",
					version: " 2.10",
					deviceClass: "09",
					maxchild: "4",
					product: "USB2.0 Hub",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				rootHub("usb4", "fc400000.usb", "5000"),
				{
					name: "4-1",
					controller: "fc400000.usb",
					speed: "5000",
					version: " 3.10",
					deviceClass: "09",
					maxchild: "4",
					product: "USB3.0 Hub",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
			],
			"rock-5b-plus",
		);
		const usb2 = nodeNamed(tree, "1-1");
		const usb3 = nodeNamed(tree, "4-1");
		expect(usb2.key).toBe("fc400000.usb:usb2:1");
		expect(usb3.key).toBe("fc400000.usb:usb3:1");
		expect(usb2.port.label).toBe("A3-bot");
		expect(usb3.port.label).toBe("A3-bot");
		expect(usb2.parentKey).toBe("fc400000.usb:usb2:root");
		expect(usb3.parentKey).toBe("fc400000.usb:usb3:root");
	});

	it("places an external hub's children on the lower blue port", async () => {
		const tree = await withTree(
			[
				rootHub("usb1", "fc400000.usb", "480"),
				{
					name: "1-1",
					controller: "fc400000.usb",
					speed: "480",
					version: " 2.00",
					deviceClass: "09",
					vendor: "214b",
					productId: "7250",
					product: "USB2.0 Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				{
					name: "1-1.2",
					controller: "fc400000.usb",
					speed: "480",
					version: " 2.00",
					deviceClass: "00",
					vendor: "2c7c",
					productId: "0801",
					product: "RM520N-GL",
					interfaces: [
						{ suffix: "1.0", driver: "option" },
						{ suffix: "1.2", driver: "qmi_wwan", net: [{ name: "wwan0" }] },
					],
				},
			],
			"rock-5b-plus",
		);
		const hub = nodeNamed(tree, "1-1");
		const modem = nodeNamed(tree, "1-1.2");
		expect(hub.kind).toBe("hub");
		expect(hub.port.label).toBe("A3-bot");
		expect(hub.children.map((child) => child.kernelName)).toEqual(["1-1.2"]);
		expect(modem.kind).toBe("modem");
		expect(modem.drivers).toEqual(["option", "qmi_wwan"]);
		expect(modem.netNames).toEqual(["wwan0"]);
		expect(modem.product).toBe("RM520N-GL");
		expect(modem.port).toEqual({
			label: ">hub.2",
			name: "Hub port 2",
			scope: "hub-port",
			socketLabel: "A3-bot",
			socketName: "Lower blue port",
			hubPort: 2,
			portClass: "usb3",
			colour: "blue",
		});
		expect(modem.socketKey).toBe("A3-bot>hub.2");
		expect(modem.parentKey).toBe(hub.key);
	});

	it("names the black ports, the modem slot and a hub plugged into one", async () => {
		const tree = await withTree(
			[
				rootHub("usb3", "fc800000.usb", "480"),
				{
					name: "3-1",
					controller: "fc800000.usb",
					speed: "480",
					deviceClass: "09",
					vendor: "1a40",
					productId: "0101",
					product: "USB 2.0 Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				{
					name: "3-1.1",
					controller: "fc800000.usb",
					speed: "480",
					deviceClass: "09",
					product: "USB2.0 Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				{
					name: "3-1.1.1",
					controller: "fc800000.usb",
					speed: "480",
					deviceClass: "00",
					product: "Mass Storage",
					interfaces: [{ suffix: "1.0", driver: "usb-storage" }],
				},
				{
					name: "3-1.2",
					controller: "fc800000.usb",
					speed: "480",
					deviceClass: "00",
					product: "Archer T2U Nano",
					interfaces: [
						{
							suffix: "1.0",
							net: [{ name: "wlan2", phy80211: true }],
						},
					],
				},
				{
					name: "3-1.3",
					controller: "fc800000.usb",
					speed: "12",
					deviceClass: "e0",
					product: "Bluetooth Radio",
					interfaces: [{ suffix: "1.0", driver: "btusb" }],
				},
				{
					name: "3-1.4",
					controller: "fc800000.usb",
					speed: "480",
					deviceClass: "00",
					vendor: "413c",
					productId: "81d7",
					product: "DW5821e",
					interfaces: [
						{ suffix: "1.0", driver: "cdc_mbim", net: [{ name: "wwan1" }] },
					],
				},
			],
			"rock-5b-plus",
		);
		expect(nodeNamed(tree, "3-1").port.name).toBe("Onboard hub");
		expect(nodeNamed(tree, "3-1.2").port).toMatchObject({
			label: "A2-top",
			name: "Upper black port",
		});
		expect(nodeNamed(tree, "3-1.2").kind).toBe("wifi");
		expect(nodeNamed(tree, "3-1.1").kind).toBe("hub");
		expect(nodeNamed(tree, "3-1.1").port).toMatchObject({
			label: "A2-bot",
			name: "Lower black port",
		});
		const nested = nodeNamed(tree, "3-1.1.1");
		expect(nested.kind).toBe("other");
		expect(nested.port).toMatchObject({
			label: ">hub.1",
			name: "Hub port 1",
			socketLabel: "A2-bot",
			socketName: "Lower black port",
			hubPort: 1,
		});
		expect(nodeNamed(tree, "3-1.3").port).toMatchObject({
			label: "BT",
			name: "Bluetooth",
		});
		expect(nodeNamed(tree, "3-1.3").kind).toBe("other");
		const slot = nodeNamed(tree, "3-1.4");
		expect(slot.kind).toBe("modem");
		expect(slot.port).toMatchObject({
			label: "M2B",
			name: "Modem slot inside",
		});
		expect(slot.speedClass).toBe("usb2");
	});

	it("falls back to generic names on another board and an unknown controller", async () => {
		const orange = await withTree(
			[
				rootHub("usb5", "fc400000.usb", "480"),
				{
					name: "5-1",
					controller: "fc400000.usb",
					speed: "480",
					deviceClass: "09",
					product: "USB2.0 Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
			],
			"detect",
			async (root) => {
				const model = join(root, "proc/device-tree");
				await mkdir(model, { recursive: true });
				await writeFile(join(model, "model"), "Orange Pi 5 Plus\0");
			},
		);
		expect(orange.board).toBe("generic");
		expect(nodeNamed(orange, "5-1").port).toMatchObject({
			label: null,
			name: "USB 1 port 1",
			scope: "generic",
		});

		const rock = await withTree(
			[
				rootHub("usb1", "fc000000.usb", "480", "usbdrd3_0"),
				{
					name: "1-1",
					controller: "fc000000.usb",
					platformPrefix: "usbdrd3_0",
					speed: "480",
					product: "HD Webcam",
					interfaces: [{ suffix: "1.0", driver: "uvcvideo" }],
				},
				{
					name: "2-1",
					controller: "aaaa0000.usb",
					speed: "480",
					product: "USB Disk",
					interfaces: [{ suffix: "1.0", driver: "usb-storage" }],
				},
			],
			"detect",
			async (root) => {
				const dir = join(root, "proc/device-tree");
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "compatible"),
					"radxa,rock-5b-plus\0rockchip,rk3588\0",
				);
			},
		);
		expect(rock.board).toBe("rock-5b-plus");
		expect(nodeNamed(rock, "1-1").port.name).toBe("USB-C data port");
		expect(nodeNamed(rock, "2-1").port).toMatchObject({
			label: null,
			name: "USB 1 port 1",
			scope: "generic",
		});
		expect(nodeNamed(rock, "2-1").kind).toBe("other");
	});

	it("never returns a planted serial, MAC, IMEI or ICCID", async () => {
		const opened: string[] = [];
		const tree = await withTree(
			[
				rootHub("usb1", "fc400000.usb", "480"),
				{
					name: "1-1",
					controller: "fc400000.usb",
					speed: "480",
					deviceClass: "00",
					vendor: "2c7c",
					productId: "0801",
					product: `RM520N-GL IMEI ${IMEI}`,
					planted: {
						serial: SERIAL,
						address: MAC,
						iccid: ICCID,
						manufacturer: "Quectel",
					},
					interfaces: [
						{ suffix: "1.0", driver: "option" },
						{
							suffix: "1.2",
							driver: "qmi_wwan",
							net: [{ name: "wwan0" }],
						},
					],
				},
				{
					name: "1-2",
					controller: "fc400000.usb",
					speed: "480",
					product: `ICCID ${ICCID}`,
					planted: { serial: SERIAL },
				},
				{
					name: "1-3",
					controller: "fc400000.usb",
					speed: "480",
					product: "Archer T3U",
					interfaces: [
						{
							suffix: "1.0",
							net: [
								{ name: "wlx001122334455", phy80211: true },
								{ name: "enx001122334466" },
							],
						},
					],
				},
			],
			"rock-5b-plus",
			undefined,
			async (path) => {
				opened.push(basename(path));
				return await readFile(path, "utf8");
			},
		);
		const encoded = JSON.stringify(tree);
		expect(encoded).not.toContain(SERIAL);
		expect(encoded).not.toContain(MAC);
		expect(encoded).not.toContain(IMEI);
		expect(encoded).not.toContain(ICCID);
		expect(encoded.toLowerCase()).not.toContain("imei");
		expect(encoded.toLowerCase()).not.toContain("iccid");
		expect(nodeNamed(tree, "1-1").product).toBeNull();
		expect(nodeNamed(tree, "1-2").product).toBeNull();
		expect(nodeNamed(tree, "1-3").product).toBe("Archer T3U");
		expect(nodeNamed(tree, "1-3").kind).toBe("wifi");
		expect(nodeNamed(tree, "1-3").netNames).toEqual(["net0", "net1"]);
		expect(encoded).not.toContain("wlx001122334455");
		expect(encoded).not.toContain("enx001122334466");
		expect(encoded).not.toContain("001122334455");
		expect(encoded).not.toContain("001122334466");
		const allowed = new Set<string>([
			...USB_DEVICE_ATTRIBUTE_ALLOWLIST,
			"model",
			"compatible",
		]);
		expect(opened.length).toBeGreaterThan(0);
		for (const name of opened) {
			expect(allowed.has(name)).toBe(true);
		}
		expect(opened).not.toContain("serial");
		expect(opened).not.toContain("manufacturer");
		expect(opened).not.toContain("address");
		expect(opened).not.toContain("macaddress");
		expect(opened).not.toContain("iccid");
		expect(sanitizeUsbProduct(SERIAL)).toBeNull();
		expect(sanitizeUsbProduct("USB Serial Converter")).toBe(
			"USB Serial Converter",
		);
		expect(sanitizeUsbProduct("RM520N-GL")).toBe("RM520N-GL");
	});

	it("returns an empty tree when sysfs is missing and ignores a bad speed", async () => {
		const emptyRoot = await mkdtemp(join(tmpdir(), "ceraui-usb-tree-"));
		try {
			const empty = await readUsbTree({
				sysfsRoot: emptyRoot,
				board: "generic",
			});
			expect(empty).toEqual({
				board: "generic",
				status: "unavailable",
				roots: [],
			});
		} finally {
			await rm(emptyRoot, { recursive: true, force: true });
		}

		const tree = await withTree(
			[
				{
					name: "usb1",
					controller: "fc000000.usb",
					speed: "fast",
					product: "",
					configurations: "10",
				},
			],
			"generic",
		);
		const root = nodeNamed(tree, "usb1");
		expect(root.speedMbps).toBeNull();
		expect(root.speedClass).toBe("unknown");
		expect(root.port.scope).toBe("root");
		expect(root.product).toBeNull();
		expect(root.configurationCount).toBe(10);
		expect(tree.status).toBe("ok");
	});

	it("pairs PCI USB 2 and USB 3 halves without using the bus number", async () => {
		const tree = await withTree(
			[
				pciRoot("usb1", "0000:00:0d.0", "480"),
				{
					name: "1-1",
					controller: "0000:00:0d.0",
					busDriver: "pci",
					speed: "480",
					product: "USB disk",
				},
				pciRoot("usb3", "0000:00:14.0", "480"),
				{
					name: "3-1",
					controller: "0000:00:14.0",
					busDriver: "pci",
					speed: "480",
					product: "USB disk",
				},
				pciRoot("usb4", "0000:00:14.0", "5000"),
				{
					name: "4-1",
					controller: "0000:00:14.0",
					busDriver: "pci",
					speed: "5000",
					product: "USB disk",
				},
			],
			"generic",
			async (root) => {
				await linkPortPeers(root, "usb3", "usb4");
			},
		);
		const slow = nodeNamed(tree, "1-1");
		const usb2 = nodeNamed(tree, "3-1");
		const usb3 = nodeNamed(tree, "4-1");
		expect(slow.controller).toBe("0000:00:0d.0");
		expect(slow.key).toBe("0000:00:0d.0:usb2:1");
		expect(slow.key).not.toContain("1-1");
		expect(usb2.key).toBe("0000:00:14.0:usb2:1");
		expect(usb3.key).toBe("0000:00:14.0:usb3:1");
		expect(usb2.key).not.toContain("3-1");
		expect(slow.port.name).toBe("USB 1 port 1");
		expect(usb2.port.name).toBe("USB 2 port 1");
		expect(usb3.port.name).toBe("USB 2 port 1");
		expect(usb2.socketKey).toBe("0000:00:14.0:1");
		expect(usb3.socketKey).toBe(usb2.socketKey);
		expect(slow.socketKey).toBe("0000:00:0d.0:1");
	});

	it("follows the measured ROCK2 7.2 device paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-tree-"));
		try {
			await writeFixture(root, rock2NormalTree());
			const pathOf = async (name: string) =>
				realpath(join(root, "sys/bus/usb/devices", name));
			expect(await pathOf("9-1")).toContain(
				"fc000000.usb/xhci-hcd.10.auto/usb9/9-1",
			);
			expect(await pathOf("9-1:1.4")).toContain("9-1/9-1:1.4");
			expect(await pathOf("1-1.2")).toContain(
				"fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.2",
			);
			expect(await pathOf("2-1.4")).toContain("fc800000.usb/usb2/2-1/2-1.4");
			expect(await pathOf("2-1.4")).not.toContain("xhci-hcd");
			expect(await pathOf("2-1.2:2.6")).toContain("2-1.2/2-1.2:2.6");
			expect(await pathOf("usb3")).toContain("fc840000.usb/usb3");
			expect(await pathOf("usb8")).toContain(
				"fcd00000.usb/xhci-hcd.5.auto/usb8",
			);
			await expect(pathOf("usb9:1.0")).rejects.toThrow();

			const tree = await readUsbTree({
				sysfsRoot: root,
				board: "rock-5b-plus",
			});
			expect(tree.status).toBe("ok");
			const modem = nodeNamed(tree, "9-1");
			expect(modem.kind).toBe("modem");
			expect(modem.speedMbps).toBe(480);
			expect(modem.speedClass).toBe("usb2");
			expect(modem.port).toMatchObject({
				label: "C",
				name: "USB-C data port",
				portClass: "usb3",
			});
			expect(modem.socketKey).toBe("C");
			expect(modem.presence).toBe("present");
			expect(modem.netNames).toEqual(["net0"]);
			const stick = nodeNamed(tree, "1-1.2");
			expect(stick.kind).toBe("wifi");
			expect(stick.port).toMatchObject({
				label: ">hub.2",
				socketLabel: "A3-bot",
				colour: "blue",
				portClass: "usb3",
			});
			expect(stick.netNames).toEqual(["net0"]);
			expect(nodeNamed(tree, "2-1.2").port.label).toBe("A2-top");
			expect(nodeNamed(tree, "2-1.3").port).toMatchObject({
				label: "BT",
				name: "Bluetooth",
			});
			expect(nodeNamed(tree, "2-1.4").port).toMatchObject({
				label: "M2B",
				name: "Modem slot inside",
				portClass: "usb2",
				scope: "socket",
			});
			const encoded = JSON.stringify(tree);
			expect(encoded).not.toContain("001122334455");
			expect(encoded).not.toContain("wlx001122334455");
			expect(encoded).not.toContain("wwx001122334455");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("shows J11 as nothing detected when the USB-C controller has no host bus", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-tree-"));
		try {
			await writeFixture(root, rock2StuckTree());
			const pathOf = async (name: string) =>
				realpath(join(root, "sys/bus/usb/devices", name));
			expect(await pathOf("3-1.4")).toContain("fc800000.usb/usb3/3-1/3-1.4");
			expect(await pathOf("3-1.4")).not.toContain("xhci-hcd");
			expect(await pathOf("usb2")).toContain("fc840000.usb/usb2");
			expect(await pathOf("usb7")).toContain(
				"fcd00000.usb/xhci-hcd.9.auto/usb7",
			);
			await expect(pathOf("9-1")).rejects.toThrow();
			await expect(pathOf("usb9")).rejects.toThrow();

			const tree = await readUsbTree({
				sysfsRoot: root,
				board: "rock-5b-plus",
			});
			expect(tree.status).toBe("ok");
			const j11 = flatten(tree.roots).find((node) => node.socketKey === "C");
			expect(j11).toMatchObject({
				controller: "fc000000.usb",
				presence: "nothing-detected",
				port: { label: "C", name: "USB-C data port" },
				speedClass: "unknown",
				product: null,
			});
			expect(
				flatten(tree.roots).some(
					(node) =>
						node.controller === "fc000000.usb" && node.presence === "present",
				),
			).toBe(false);
			expect(nodeNamed(tree, "3-1.4").port.label).toBe("M2B");
			expect(nodeNamed(tree, "1-1.2").port.socketLabel).toBe("A3-bot");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("follows the ROCK1 5.10 usbdrd path", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-tree-"));
		try {
			await writeFixture(root, [
				shapedRoot("usb7", "fc400000.usb", "480", {
					busDriver: "xhci",
					xhciIndex: "11",
					platformPrefix: "usbdrd3_1",
				}),
				{
					name: "7-1",
					controller: "fc400000.usb",
					platformPrefix: "usbdrd3_1",
					xhciIndex: "11",
					speed: "480",
					deviceClass: "09",
					product: "Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				{
					name: "7-1.1",
					controller: "fc400000.usb",
					platformPrefix: "usbdrd3_1",
					xhciIndex: "11",
					speed: "480",
					product: "Wi-Fi stick",
					interfaces: [
						{
							suffix: "1.0",
							net: [{ name: "wlx001122334455", phy80211: true }],
						},
					],
				},
				shapedRoot("usb1", "fc800000.usb", "480", { busDriver: "ehci" }),
				{
					name: "1-1",
					controller: "fc800000.usb",
					busDriver: "ehci",
					speed: "480",
					deviceClass: "09",
					product: "Hub",
					maxchild: "4",
					interfaces: [{ suffix: "1.0", driver: "hub" }],
				},
				{
					name: "1-1.4",
					controller: "fc800000.usb",
					busDriver: "ehci",
					speed: "480",
					product: "Modem",
					interfaces: [{ suffix: "1.0", driver: "option" }],
				},
			]);
			const pathOf = async (name: string) =>
				realpath(join(root, "sys/bus/usb/devices", name));
			expect(await pathOf("7-1.1")).toContain(
				"usbdrd3_1/fc400000.usb/xhci-hcd.11.auto/usb7/7-1/7-1.1",
			);
			expect(await pathOf("1-1.4")).toContain("fc800000.usb/usb1/1-1/1-1.4");
			expect(await pathOf("1-1.4")).not.toContain("xhci-hcd");
			expect(await pathOf("7-0:1.0")).toContain("7-0:1.0");
			const tree = await readUsbTree({
				sysfsRoot: root,
				board: "rock-5b-plus",
			});
			expect(nodeNamed(tree, "7-1").port.label).toBe("A3-bot");
			expect(nodeNamed(tree, "7-1.1").kind).toBe("wifi");
			expect(nodeNamed(tree, "7-1.1").netNames).toEqual(["net0"]);
			expect(nodeNamed(tree, "1-1.4").kind).toBe("modem");
			expect(nodeNamed(tree, "1-1.4").port.label).toBe("M2B");
			expect(JSON.stringify(tree)).not.toContain("001122334455");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function pciRoot(
	name: string,
	controller: string,
	speed: string,
): FixtureDevice {
	return {
		...rootHub(name, controller, speed),
		busDriver: "pci",
	};
}

function shapedRoot(
	name: string,
	controller: string,
	speed: string,
	shape: {
		busDriver: "ehci" | "xhci";
		xhciIndex?: string;
		platformPrefix?: string;
	},
): FixtureDevice {
	return {
		...rootHub(name, controller, speed, shape.platformPrefix),
		busDriver: shape.busDriver,
		...(shape.xhciIndex === undefined ? {} : { xhciIndex: shape.xhciIndex }),
	};
}

function numberedIfaces(
	config: string,
	count: number,
	driver: string,
): FixtureInterface[] {
	return Array.from({ length: count }, (_, index) => {
		const suffix = `${config}.${index}`;
		if (index === 0) return { suffix, driver };
		return { suffix };
	});
}

function rock2NormalTree(): FixtureDevice[] {
	const xhci = (
		name: string,
		controller: string,
		speed: string,
		index: string,
	): FixtureDevice =>
		shapedRoot(name, controller, speed, {
			busDriver: "xhci",
			xhciIndex: index,
		});
	const ehci = (
		name: string,
		controller: string,
		speed: string,
	): FixtureDevice =>
		shapedRoot(name, controller, speed, { busDriver: "ehci" });
	return [
		xhci("usb1", "fc400000.usb", "480", "0"),
		{
			name: "1-1",
			controller: "fc400000.usb",
			xhciIndex: "0",
			speed: "480",
			deviceClass: "09",
			product: "Hub",
			maxchild: "4",
			interfaces: [{ suffix: "1.0", driver: "hub" }],
		},
		{
			name: "1-1.2",
			controller: "fc400000.usb",
			xhciIndex: "0",
			speed: "480",
			product: "Wi-Fi stick",
			interfaces: [
				{
					suffix: "1.0",
					net: [{ name: "wlx001122334455", phy80211: true }],
				},
			],
		},
		{
			name: "1-1.3",
			controller: "fc400000.usb",
			xhciIndex: "0",
			speed: "480",
			product: "Wi-Fi stick",
			interfaces: [{ suffix: "1.0" }],
		},
		ehci("usb2", "fc800000.usb", "480"),
		{
			name: "2-1",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "480",
			deviceClass: "09",
			product: "Hub",
			maxchild: "4",
			interfaces: [{ suffix: "1.0", driver: "hub" }],
		},
		{
			name: "2-1.2",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "480",
			product: "Modem",
			interfaces: numberedIfaces("2", 7, "option"),
		},
		{
			name: "2-1.3",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "12",
			product: "Bluetooth adapter",
			interfaces: [
				{ suffix: "1.0", driver: "btusb" },
				{ suffix: "1.1", driver: "btusb" },
			],
		},
		{
			name: "2-1.4",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "480",
			product: "Modem",
			interfaces: numberedIfaces("2", 7, "option"),
		},
		ehci("usb3", "fc840000.usb", "12"),
		xhci("usb4", "fc400000.usb", "5000", "0"),
		ehci("usb5", "fc880000.usb", "480"),
		ehci("usb6", "fc8c0000.usb", "12"),
		xhci("usb7", "fcd00000.usb", "480", "5"),
		xhci("usb8", "fcd00000.usb", "5000", "5"),
		xhci("usb9", "fc000000.usb", "480", "10"),
		{
			name: "9-1",
			controller: "fc000000.usb",
			xhciIndex: "10",
			speed: "480",
			version: " 2.00",
			product: "Modem",
			interfaces: [
				{ suffix: "1.0", driver: "option" },
				{ suffix: "1.1", driver: "option" },
				{ suffix: "1.2", driver: "option" },
				{ suffix: "1.3", driver: "option" },
				{
					suffix: "1.4",
					driver: "qmi_wwan",
					net: [{ name: "wwx001122334455" }],
				},
			],
		},
		xhci("usb10", "fc000000.usb", "5000", "10"),
	];
}

function rock2StuckTree(): FixtureDevice[] {
	const xhci = (
		name: string,
		controller: string,
		speed: string,
		index: string,
	): FixtureDevice =>
		shapedRoot(name, controller, speed, {
			busDriver: "xhci",
			xhciIndex: index,
		});
	const ehci = (
		name: string,
		controller: string,
		speed: string,
	): FixtureDevice =>
		shapedRoot(name, controller, speed, { busDriver: "ehci" });
	return [
		xhci("usb1", "fc400000.usb", "480", "0"),
		{
			name: "1-1",
			controller: "fc400000.usb",
			xhciIndex: "0",
			speed: "480",
			deviceClass: "09",
			product: "Hub",
			maxchild: "4",
			interfaces: [{ suffix: "1.0", driver: "hub" }],
		},
		{
			name: "1-1.2",
			controller: "fc400000.usb",
			xhciIndex: "0",
			speed: "480",
			product: "Wi-Fi stick",
			interfaces: [{ suffix: "1.0" }],
		},
		{
			name: "1-1.3",
			controller: "fc400000.usb",
			xhciIndex: "0",
			speed: "480",
			product: "Wi-Fi stick",
			interfaces: [{ suffix: "1.0" }],
		},
		ehci("usb2", "fc840000.usb", "12"),
		ehci("usb3", "fc800000.usb", "480"),
		{
			name: "3-1",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "480",
			deviceClass: "09",
			product: "Hub",
			maxchild: "4",
			interfaces: [{ suffix: "1.0", driver: "hub" }],
		},
		{
			name: "3-1.2",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "480",
			product: "Modem",
			interfaces: numberedIfaces("2", 7, "option"),
		},
		{
			name: "3-1.3",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "12",
			product: "Bluetooth adapter",
			interfaces: [
				{ suffix: "1.0", driver: "btusb" },
				{ suffix: "1.1", driver: "btusb" },
			],
		},
		{
			name: "3-1.4",
			controller: "fc800000.usb",
			busDriver: "ehci",
			speed: "480",
			product: "Modem",
			interfaces: numberedIfaces("2", 7, "option"),
		},
		xhci("usb4", "fc400000.usb", "5000", "0"),
		ehci("usb5", "fc880000.usb", "480"),
		ehci("usb6", "fc8c0000.usb", "12"),
		xhci("usb7", "fcd00000.usb", "480", "9"),
		xhci("usb8", "fcd00000.usb", "5000", "9"),
	];
}

async function linkPortPeers(
	root: string,
	left: string,
	right: string,
	port = "1",
): Promise<void> {
	const dir = (usbName: string) => {
		const bus = usbName.slice(3);
		return join(
			root,
			"sys/bus/usb/devices",
			usbName,
			`${bus}-0:1.0`,
			`usb${bus}-port${port}`,
		);
	};
	const leftDir = dir(left);
	const rightDir = dir(right);
	await mkdir(leftDir, { recursive: true });
	await mkdir(rightDir, { recursive: true });
	await symlink(relative(leftDir, rightDir), join(leftDir, "peer"));
	await symlink(relative(rightDir, leftDir), join(rightDir, "peer"));
}
