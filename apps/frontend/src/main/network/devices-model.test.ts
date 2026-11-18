import type { UsbDevicesWire, UsbDeviceWireNode } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { devicesPageModel } from "./devices-model";

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
				}),
			]),
		);
		if (page.status !== "ok") throw new Error("expected a tree");
		const rows = page.groups.flatMap((group) => group.rows);
		expect(rows.find((row) => row.key === "modem")?.hint).toBe("rm520-usb2");
		expect(rows.find((row) => row.key === "slot")?.hint).toBeNull();
		expect(rows.find((row) => row.key === "cam")?.hint).toBe("capture-usb2");
	});

	it("says checking when the reader has not answered", () => {
		expect(devicesPageModel(undefined).status).toBe("checking");
		expect(
			devicesPageModel({ status: "unavailable", board: "generic", nodes: [] })
				.status,
		).toBe("checking");
	});
});
