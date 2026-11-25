import type { UsbDevicesWire, UsbDeviceWireNode } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { devicesPageModel, isBoardInternal } from "./devices-model";

function node(
	overrides: Partial<UsbDeviceWireNode> &
		Pick<UsbDeviceWireNode, "key" | "socketKey" | "name" | "kind">,
): UsbDeviceWireNode {
	return {
		parentKey: null,
		controller: "fc400000.usb",
		portPath: "1",
		speedClass: "usb2",
		portClass: "usb3",
		colour: "blue",
		scope: "socket",
		label: "A3-bot",
		product: null,
		vendorId: null,
		productId: null,
		presence: "present",
		superspeedCapable: false,
		linkId: null,
		...overrides,
	};
}

function wire(nodes: UsbDeviceWireNode[]): UsbDevicesWire {
	return { status: "ok", board: "rock-5b-plus", nodes };
}

describe("devices page model", () => {
	it("reads an empty socket from presence, not from kind other", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "c",
					socketKey: "C",
					name: "USB-C data port",
					label: "C",
					kind: "other",
					presence: "nothing-detected",
					controller: "fc000000.usb",
					speedClass: "unknown",
				}),
			]),
		);
		expect(page.status).toBe("ok");
		if (page.status !== "ok") return;
		expect(page.groups[0]?.rows[0]).toMatchObject({
			state: "empty",
			kind: null,
			product: null,
		});
	});

	it("calls a present unknown device unused", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "disk",
					socketKey: "A2-bot",
					name: "Lower black port",
					label: "A2-bot",
					kind: "other",
					portClass: "usb2",
					colour: "black",
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		expect(page.groups[0]?.rows[0]?.state).toBe("unused");
		expect(page.groups[0]?.rows[0]?.kind).toBe("other");
	});

	it("does not invent an RM520 speed claim from the product and the link class", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "modem",
					socketKey: "A3-bot",
					name: "Lower blue port",
					kind: "modem",
					product: "RM520N-GL",
					speedClass: "usb2",
					portClass: "usb3",
				}),
				node({
					key: "fast",
					socketKey: "A3-top",
					name: "Upper blue port",
					label: "A3-top",
					kind: "capture",
					speedClass: "usb3",
					portClass: "usb3",
					superspeedCapable: true,
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		const rows = page.groups.flatMap((group) => group.rows);
		expect(rows.find((row) => row.key === "modem")?.hint).toBeNull();
		expect(rows.find((row) => row.key === "fast")?.hint).toBeNull();
	});

	it("hints when an RM520 is kept at USB 2, and when a capture card is at USB 2", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "modem",
					socketKey: "A3-bot>hub.1",
					name: "Hub port 1",
					scope: "hub-port",
					label: ">hub.1",
					kind: "modem",
					product: "RM520N-GL",
					speedClass: "usb2",
					portClass: "usb3",
					speedNote: "rm520-held-usb2",
				}),
				node({
					key: "slot",
					socketKey: "M2B",
					name: "Modem slot inside",
					label: "M2B",
					kind: "modem",
					product: "RM520N-GL",
					speedClass: "usb2",
					portClass: "usb2",
					colour: "black",
				}),
				node({
					key: "cam",
					socketKey: "A3-top",
					name: "Upper blue port",
					label: "A3-top",
					kind: "capture",
					product: "USB capture",
					speedClass: "usb2",
					portClass: "usb3",
					superspeedCapable: true,
				}),
				node({
					key: "usb2cam",
					socketKey: "A2-top",
					name: "Upper black port",
					label: "A2-top",
					kind: "capture",
					product: "USB2 camera",
					speedClass: "usb2",
					portClass: "usb2",
					colour: "black",
					superspeedCapable: false,
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		const rows = page.groups.flatMap((group) => group.rows);
		expect(rows.find((row) => row.key === "modem")?.hint).toBe("rm520-usb2");
		expect(rows.find((row) => row.key === "slot")?.hint).toBeNull();
		expect(rows.find((row) => row.key === "cam")?.hint).toBe("capture-usb2");
		expect(rows.find((row) => row.key === "usb2cam")?.hint).toBeNull();
	});

	it("keeps a mapped socket behind the onboard hub out of Built in", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "hub",
					socketKey: "fc800000.usb:1",
					name: "Onboard hub",
					label: null,
					scope: "built-in",
					portPath: "1",
					kind: "hub",
					controller: "fc800000.usb",
				}),
				node({
					key: "a2",
					parentKey: "hub",
					socketKey: "A2-top",
					name: "Upper black port",
					label: "A2-top",
					scope: "socket",
					portPath: "1.2",
					kind: "modem",
					controller: "fc800000.usb",
				}),
				node({
					key: "m2",
					parentKey: "hub",
					socketKey: "M2B",
					name: "Modem slot inside",
					label: "M2B",
					scope: "socket",
					portPath: "1.4",
					kind: "modem",
					controller: "fc800000.usb",
				}),
				node({
					key: "bt",
					parentKey: "hub",
					socketKey: "BT",
					name: "Bluetooth",
					label: "BT",
					scope: "built-in",
					portPath: "1.3",
					kind: "other",
					controller: "fc800000.usb",
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		expect(page.groups.find((group) => group.id === "A2-top")).toMatchObject({
			builtIn: false,
			name: "Upper black port",
		});
		expect(page.groups.find((group) => group.id === "M2B")).toMatchObject({
			builtIn: false,
			name: "Modem slot inside",
		});
		const builtIn = page.groups.find((group) => group.builtIn);
		expect(builtIn?.rows.map((row) => row.key)).toEqual(["bt"]);
		expect(builtIn?.internals.map((row) => row.key)).toEqual(["hub"]);
		expect(builtIn?.portClass).toBeNull();
	});

	it("folds root hubs into Built in and leaves a port hub where it is plugged in", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "root-usb3",
					socketKey: "fc000000.usb:root",
					name: "USB root hub",
					label: null,
					scope: "root",
					kind: "hub",
					portPath: null,
					product: "xHCI Host Controller",
					controller: "fc000000.usb",
				}),
				node({
					key: "root-usb2",
					socketKey: "fc000000.usb:root",
					name: "USB root hub",
					label: null,
					scope: "root",
					kind: "hub",
					portPath: null,
					product: "xHCI Host Controller",
					controller: "fc000000.usb",
					speedClass: "usb2",
				}),
				node({
					key: "ehci",
					socketKey: "fc880000.usb:root",
					name: "USB root hub",
					label: null,
					scope: "root",
					kind: "hub",
					portPath: null,
					product: "EHCI Host Controller",
					controller: "fc880000.usb",
					portClass: "usb2",
					colour: null,
				}),
				node({
					key: "ohci",
					socketKey: "fc840000.usb:root",
					name: "USB root hub",
					label: null,
					scope: "root",
					kind: "hub",
					portPath: null,
					product: "Generic Platform OHCI controller",
					controller: "fc840000.usb",
					speedClass: "full",
					portClass: null,
					colour: null,
				}),
				node({
					key: "onboard",
					socketKey: "fc800000.usb:1",
					name: "Onboard hub",
					label: null,
					scope: "built-in",
					kind: "hub",
					portPath: "1",
					product: "USB 2.0 Hub",
					controller: "fc800000.usb",
					portClass: "usb2",
					colour: null,
				}),
				node({
					key: "bt",
					parentKey: "onboard",
					socketKey: "BT",
					name: "Bluetooth",
					label: "BT",
					scope: "built-in",
					kind: "other",
					portPath: "1.3",
					product: "Bluetooth Radio",
					controller: "fc800000.usb",
					portClass: "usb2",
					colour: null,
				}),
				node({
					key: "ext",
					socketKey: "A3-bot",
					name: "Lower blue port",
					label: "A3-bot",
					kind: "hub",
					product: "USB2.0 HUB",
				}),
				node({
					key: "stick",
					parentKey: "ext",
					socketKey: "A3-bot>hub.2",
					name: "Hub port 2",
					label: ">hub.2",
					scope: "hub-port",
					kind: "wifi",
					portPath: "1.2",
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		expect(page.groups.map((group) => group.name)).toEqual([
			"Lower blue port",
			"",
		]);
		expect(page.groups.some((group) => group.name === "USB root hub")).toBe(
			false,
		);
		const builtIn = page.groups.find((group) => group.builtIn);
		expect(builtIn?.rows.map((row) => row.key)).toEqual(["bt"]);
		expect(builtIn?.internals.map((row) => row.key)).toEqual([
			"root-usb2",
			"root-usb3",
			"onboard",
			"ohci",
			"ehci",
		]);
		const blue = page.groups.find((group) => group.id === "A3-bot");
		expect(blue?.rows.map((row) => row.key)).toEqual(["ext", "stick"]);
		expect(page.summary).toMatchObject({ devices: 1, hubs: 1, ports: 1 });
	});

	it("counts a root hub and the onboard hub as internal, and a port device as not", () => {
		expect(isBoardInternal({ scope: "root", kind: "hub" })).toBe(true);
		expect(isBoardInternal({ scope: "built-in", kind: "hub" })).toBe(true);
		expect(isBoardInternal({ scope: "built-in", kind: "other" })).toBe(false);
		expect(isBoardInternal({ scope: "built-in", kind: "wifi" })).toBe(false);
		expect(isBoardInternal({ scope: "socket", kind: "hub" })).toBe(false);
		expect(isBoardInternal({ scope: "socket", kind: "modem" })).toBe(false);
		expect(isBoardInternal({ scope: "hub-port", kind: "wifi" })).toBe(false);
		expect(isBoardInternal({ scope: "generic", kind: "hub" })).toBe(false);
	});

	it("keeps a generic hub and its child on one socket", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "hub",
					socketKey: "0000:00:14.0:1",
					name: "USB port 1",
					label: null,
					controller: "0000:00:14.0",
					portPath: "1",
					kind: "hub",
					scope: "generic",
					colour: null,
				}),
				node({
					key: "child",
					parentKey: "hub",
					socketKey: "0000:00:14.0:1.2",
					name: "USB port 1.2",
					label: null,
					controller: "0000:00:14.0",
					portPath: "1.2",
					kind: "wifi",
					scope: "generic",
					colour: null,
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		expect(page.groups).toHaveLength(1);
		expect(page.groups[0]?.id).toBe("0000:00:14.0:1");
		expect(page.groups[0]?.name).toBe("USB port 1");
		expect(page.groups[0]?.rows.map((row) => row.key)).toEqual([
			"hub",
			"child",
		]);
	});

	it("lists a hub's children under it in tree order, with their tree lines", () => {
		const generic = (
			key: string,
			portPath: string,
			parentKey: string | null,
			kind: UsbDeviceWireNode["kind"],
		) =>
			node({
				key,
				parentKey,
				socketKey: `0000:00:14.0:${portPath}`,
				name: `USB port ${portPath}`,
				label: null,
				controller: "0000:00:14.0",
				portPath,
				kind,
				scope: "generic",
				colour: null,
			});
		const page = devicesPageModel(
			wire([
				// Deliberately out of order: the inner hub's child before its siblings.
				generic("inner-child", "1.1.2", "inner", "modem"),
				generic("hub", "1", null, "hub"),
				generic("second", "1.2", "hub", "wifi"),
				generic("inner", "1.1", "hub", "hub"),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		const rows = page.groups[0]?.rows ?? [];
		expect(
			rows.map((row) => [row.key, row.depth, row.lastChild, row.hasChildren]),
		).toEqual([
			["hub", 0, false, true],
			["inner", 1, false, true],
			["inner-child", 2, true, false],
			["second", 1, true, false],
		]);
		// The hub's line passes the inner hub's child on its way to "second".
		expect(rows.map((row) => row.guides)).toEqual([[], [], [true], []]);
	});

	it("starts the USB 2 and USB 3 views of one socket each at depth 0", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "root2",
					socketKey: "fc400000.usb:root",
					name: "USB root hub",
					label: null,
					portPath: null,
					kind: "hub",
					scope: "root",
				}),
				node({
					key: "root3",
					socketKey: "fcd00000.usb:root",
					name: "USB root hub",
					label: null,
					controller: "fcd00000.usb",
					portPath: null,
					speedClass: "usb3",
					kind: "hub",
					scope: "root",
				}),
				node({
					key: "hub2",
					parentKey: "root2",
					socketKey: "A3-bot",
					name: "Lower blue port",
					kind: "hub",
				}),
				node({
					key: "hub3",
					parentKey: "root3",
					socketKey: "A3-bot",
					name: "Lower blue port",
					controller: "fcd00000.usb",
					speedClass: "usb3",
					kind: "hub",
				}),
				node({
					key: "modem",
					parentKey: "hub2",
					socketKey: "A3-bot>hub.1",
					name: "Hub port 1",
					label: ">hub.1",
					scope: "hub-port",
					portPath: "1.1",
					kind: "modem",
				}),
				node({
					key: "capture",
					parentKey: "hub3",
					socketKey: "A3-bot>hub.2",
					name: "Hub port 2",
					label: ">hub.2",
					scope: "hub-port",
					controller: "fcd00000.usb",
					portPath: "1.2",
					speedClass: "usb3",
					kind: "capture",
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		const port = page.groups.find((group) => group.id === "A3-bot");
		expect(
			port?.rows.map((row) => [row.key, row.depth, row.lastChild, row.guides]),
		).toEqual([
			["hub2", 0, false, []],
			["modem", 1, true, []],
			["hub3", 0, false, []],
			["capture", 1, true, []],
		]);
	});

	it("counts the design story without treating an empty port as a device", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "hub",
					socketKey: "A3-bot",
					name: "Lower blue port",
					label: "A3-bot",
					kind: "hub",
					hubPorts: 4,
				}),
				node({
					key: "bad",
					parentKey: "hub",
					socketKey: "A3-bot>hub.2",
					name: "Hub port 2",
					label: ">hub.2",
					scope: "hub-port",
					kind: "modem",
					displayState: "not-responding",
				}),
				node({
					key: "gone",
					socketKey: "A2-bot",
					name: "Lower black port",
					label: "A2-bot",
					kind: "wifi",
					presence: "nothing-detected",
					displayState: "unplugged",
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		expect(page.summary).toMatchObject({
			devices: 1,
			hubs: 1,
			ports: 1,
			unresponsive: 1,
		});
		const rooted = devicesPageModel(
			wire([
				node({
					key: "root",
					socketKey: "fc400000.usb:1",
					name: "USB root",
					label: null,
					scope: "root",
					kind: "hub",
					portPath: null,
				}),
			]),
		);
		if (rooted.status !== "ok") throw new Error("expected a tree");
		expect(rooted.summary).toMatchObject({ devices: 0, hubs: 0, ports: 0 });
		expect(rooted.groups.map((group) => group.id)).toEqual(["built-in"]);
		expect(rooted.groups[0]?.internals.map((row) => row.key)).toEqual(["root"]);
		expect(rooted.groups[0]?.rows).toEqual([]);
		expect(
			page.groups.find((group) => group.label === "A2-bot")?.rows[0]?.state,
		).toBe("unplugged");
	});

	it("keeps helper facts on the USB-C row and the matching modem", () => {
		const page = devicesPageModel(
			wire([
				node({
					key: "c",
					socketKey: "C",
					label: "C",
					name: "USB-C data port",
					kind: "other",
					presence: "nothing-detected",
				}),
				node({
					key: "modem",
					socketKey: "A3-bot>hub.1",
					label: ">hub.1",
					name: "Hub port 1",
					kind: "modem",
					scope: "hub-port",
					product: "RM520N-GL",
				}),
			]),
			{
				typec: {
					powerRole: "source",
					dataRole: "host",
					partner: true,
					vbus: "on",
				},
				reprobe: { outcome: "recovered", rearm: 2 },
				holds: [
					{ key: "modem", stored: "20", outcome: "verified" },
					{ key: null, stored: "20", outcome: "reset-sent" },
				],
			},
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		expect(
			page.groups.find((group) => group.id === "C")?.rows[0]?.helper,
		).toEqual({
			typec: {
				powerRole: "source",
				dataRole: "host",
				partner: true,
				vbus: "on",
			},
			reprobe: { outcome: "recovered", rearm: 2 },
			holds: [],
		});
		expect(page.unassignedHolds).toEqual([
			{ key: null, stored: "20", outcome: "reset-sent" },
		]);
		const modem = page.groups
			.flatMap((group) => group.rows)
			.find((row) => row.key === "modem");
		expect(modem?.helper?.holds).toEqual([
			{ key: "modem", stored: "20", outcome: "verified" },
		]);
		expect(modem?.helper?.typec).toBeNull();
	});

	it("says checking when the reader has not answered", () => {
		expect(devicesPageModel(undefined).status).toBe("checking");
		expect(
			devicesPageModel({ status: "unavailable", board: "generic", nodes: [] })
				.status,
		).toBe("checking");
	});
});
