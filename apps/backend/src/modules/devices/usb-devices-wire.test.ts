import { describe, expect, it } from "bun:test";

import { usbDevicesWireSchema } from "../../../../../packages/rpc/src/schemas/usb-devices.schema.ts";

import { projectUsbDevices, usbLinkRefFromIdPath } from "./usb-devices-wire.ts";
import type { UsbTree, UsbTreeNode } from "./usb-tree.ts";

const MAC = "aa:bb:cc:dd:ee:ff";
const IMEI = "490154203237518";
const ICCID = "89014103211118510720";
const SERIAL = "SECRET-SERIAL-9f3a";
const WLX = "wlx001122334455";

function node(overrides: Partial<UsbTreeNode> = {}): UsbTreeNode {
	return {
		key: "fc400000.usb:usb2:1",
		parentKey: null,
		kernelName: "1-1",
		controller: "fc400000.usb",
		portPath: "1",
		rootSpeedClass: "usb2",
		speedMbps: 480,
		speedClass: "usb2",
		usbVersion: "2.00",
		vendorId: "1111",
		productId: "2222",
		product: `Cam Link 4K 2C1MX4A01234 ${IMEI}`,
		deviceClass: 0,
		configurationCount: 1,
		maxPorts: null,
		kind: "wifi",
		drivers: ["rtl88x2bu"],
		netNames: ["net0", WLX],
		videoNames: [],
		port: {
			label: "A3-bot",
			name: "Lower blue port",
			scope: "socket",
			socketLabel: "A3-bot",
			socketName: "Lower blue port",
			hubPort: null,
			portClass: "usb3",
			colour: "blue",
		},
		socketKey: "A3-bot",
		presence: "present",
		children: [],
		...overrides,
	};
}

describe("usb device status payload", () => {
	it("sends the link id and never a planted identifier or a net placeholder", () => {
		const tree: UsbTree = {
			status: "ok",
			board: "rock-5b-plus",
			roots: [node()],
		};
		const wire = projectUsbDevices(tree, [
			{
				controller: "fc400000.usb",
				portPath: "1",
				linkId: "link-3",
			},
			{
				controller: "fc400000.usb",
				portPath: "1",
				linkId: "001122334455",
			},
		]);
		const encoded = JSON.stringify(usbDevicesWireSchema.parse(wire));
		expect(encoded).not.toContain(MAC);
		expect(encoded).not.toContain(IMEI);
		expect(encoded).not.toContain(ICCID);
		expect(encoded).not.toContain(SERIAL);
		expect(encoded).not.toContain(WLX);
		expect(encoded).not.toContain("net0");
		expect(encoded).not.toContain("2C1MX4A01234");
		expect(encoded).not.toContain("001122334455");
		expect(wire.nodes[0]?.product).toBeNull();
		expect(wire.nodes[0]?.linkId).toBe("link-3");
		expect(Object.keys(wire.nodes[0] ?? {})).not.toContain("netNames");
	});

	it("joins a published path to the controller and port", () => {
		expect(
			usbLinkRefFromIdPath("platform-fc800000.usb-usb-0:1.2:1.0", "link-4"),
		).toEqual({
			controller: "fc800000.usb",
			portPath: "1.2",
			linkId: "link-4",
		});
		expect(
			usbLinkRefFromIdPath("platform-fc800000.usb-usb-0:1.2:1.0", SERIAL),
		).toBeNull();
	});

	it("rejects a payload that tries to add an interface name", () => {
		const wire = projectUsbDevices(
			{ status: "ok", board: "generic", roots: [node({ product: "C920" })] },
			[],
		);
		expect(
			usbDevicesWireSchema.safeParse({
				...wire,
				nodes: [{ ...wire.nodes[0], netNames: [WLX] }],
			}).success,
		).toBe(false);
		expect(wire.nodes[0]?.product).toBe("C920");
	});
});
