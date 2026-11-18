import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { usbDevicesWireSchema } from "../../../../../packages/rpc/src/schemas/usb-devices.schema.ts";
import { serializeRemoteSocketMessage } from "../remote/remote-status.ts";
import {
	deliverUsbDevicesWire,
	projectUsbDevices,
	usbLinkRefFromIdPath,
	usbLinkRefFromIdPathResolved,
} from "./usb-devices-wire.ts";
import type { UsbTree, UsbTreeNode } from "./usb-tree.ts";

const MAC = "aa:bb:cc:dd:ee:ff";
const IMEI = "490154203237518";
const ICCID = "89014103211118510720";
const SERIAL = "SECRET-SERIAL-9f3a";
const WLX = "wlx001122334455";

/** Same derivation as `mintLinkId` in physical-identity.ts. */
function mintLinkId(identityKey: string): string {
	return `lnk_${createHash("sha256").update(identityKey).digest("hex").slice(0, 16)}`;
}

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

	it("accepts a minted link id and the real port paths", () => {
		const linkId = mintLinkId("j11");
		expect(linkId).toMatch(/^lnk_[0-9a-f]{16}$/);
		const map = {
			"xhci-hcd.10.auto": "fc000000.usb",
			"xhci-hcd.0.auto": "fc400000.usb",
			"xhci-hcd.5.auto": "fcd00000.usb",
		};
		expect(
			usbLinkRefFromIdPath(
				"platform-xhci-hcd.10.auto-usb-0:1:1.0",
				linkId,
				map,
			),
		).toEqual({ controller: "fc000000.usb", portPath: "1", linkId });
		expect(
			usbLinkRefFromIdPath(
				"platform-xhci-hcd.0.auto-usb-0:1.2:1.0",
				linkId,
				map,
			),
		).toEqual({ controller: "fc400000.usb", portPath: "1.2", linkId });
		expect(
			usbLinkRefFromIdPath("platform-xhci-hcd.5.auto-usb-0:1:1.0", linkId, map)
				?.controller,
		).toBe("fcd00000.usb");
		expect(
			usbLinkRefFromIdPath("platform-xhci-hcd.0.auto-usb-0:1.4.1", linkId, map)
				?.portPath,
		).toBe("1.4.1");
		expect(
			usbLinkRefFromIdPath("platform-xhci-hcd.9.auto-usb-0:1.4.4:1.3", linkId, {
				"xhci-hcd.9.auto": "fcd00000.usb",
			})?.portPath,
		).toBe("1.4.4");
		expect(
			usbLinkRefFromIdPath("pci-0000:00:14.0-usb-0:3:1.0", linkId),
		).toEqual({ controller: "0000:00:14.0", portPath: "3", linkId });
		expect(
			usbLinkRefFromIdPath("platform-fc880000.usb-usb-0:1:1.0", linkId)
				?.controller,
		).toBe("fc880000.usb");
	});

	it("resolves an xhci name through the platform device", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-xhci-"));
		try {
			const target = join(
				root,
				"sys/devices/platform/fc400000.usb/xhci-hcd.0.auto",
			);
			const link = join(root, "sys/bus/platform/devices/xhci-hcd.0.auto");
			await mkdir(target, { recursive: true });
			await mkdir(join(root, "sys/bus/platform/devices"), {
				recursive: true,
			});
			await symlink(target, link);
			expect(
				await usbLinkRefFromIdPathResolved(
					"platform-xhci-hcd.0.auto-usb-0:1:1.0",
					mintLinkId("a3-bot"),
					{},
					root,
				),
			).toMatchObject({ controller: "fc400000.usb", portPath: "1" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("broadcasts only when the tree changes and drops an oversized tree", () => {
		const calls: unknown[] = [];
		const wire = projectUsbDevices(
			{ status: "ok", board: "generic", roots: [node({ product: "C920" })] },
			[],
		);
		expect(deliverUsbDevicesWire(wire, (next) => calls.push(next))).toBe(true);
		expect(deliverUsbDevicesWire(wire, (next) => calls.push(next))).toBe(false);
		expect(calls).toHaveLength(1);

		const many = Array.from({ length: 65 }, (_, index) =>
			node({
				key: `fc400000.usb:usb2:${index + 1}`,
				portPath: String(index + 1),
				product: "C920",
			}),
		);
		const overflow = projectUsbDevices(
			{ status: "ok", board: "rock-5b-plus", roots: many },
			[],
		);
		expect(overflow).toEqual({
			status: "unavailable",
			board: "rock-5b-plus",
			nodes: [],
		});
	});

	it("keeps the usb tree off both remote frames", () => {
		const local = {
			usb_devices: {
				status: "ok",
				board: "rock-5b-plus",
				nodes: [
					{
						controller: "fc000000.usb",
						product: "Modem",
						portPath: "1",
					},
				],
			},
			is_streaming: true,
		};
		const socket = serializeRemoteSocketMessage(
			JSON.stringify({ status: local, wifi: { ready: true } }),
		);
		expect(socket).not.toContain("usb_devices");
		expect(socket).not.toContain("fc000000");
		expect(socket).toContain("is_streaming");
		expect(socket).toContain("ready");
	});
});
