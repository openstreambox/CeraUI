import { describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
			const ifaceName = `${device.name}:${iface.suffix}`;
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

function physicalDir(root: string, device: FixtureDevice): string {
	const bus = device.name.startsWith("usb")
		? device.name.slice(3)
		: device.name.split("-")[0];
	const parts = [root, "sys/devices/platform"];
	if (device.platformPrefix) parts.push(device.platformPrefix);
	parts.push(device.controller, "xhci-hcd.0.auto", `usb${bus}`);
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
			},
		]);
		expect(byLabel("A2-top")[0]?.portPath).toBe("1.2");
		expect(byLabel("A2-bot")[0]?.portPath).toBe("1.1");
		expect(byLabel("M2B")[0]?.name).toBe("Modem slot inside");
		expect(byLabel("BT")[0]?.name).toBe("Built in");
	});

	it("uses generic names when the board is not a ROCK 5B+", () => {
		expect(describeUsbPort("generic", "fc000000.usb", "1")).toEqual({
			label: null,
			name: "USB port 1",
			scope: "generic",
			socketLabel: null,
			socketName: null,
			hubPort: null,
		});
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
		});
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
			name: "Built in",
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
			name: "USB port 1",
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
			name: "USB port 1",
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
							net: [{ name: "wlan0", phy80211: true }],
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
			expect(empty).toEqual({ board: "generic", roots: [] });
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
				},
			],
			"generic",
		);
		const root = nodeNamed(tree, "usb1");
		expect(root.speedMbps).toBeNull();
		expect(root.speedClass).toBe("unknown");
		expect(root.port.scope).toBe("root");
		expect(root.product).toBeNull();
	});
});
