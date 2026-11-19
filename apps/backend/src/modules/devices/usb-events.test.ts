import { describe, expect, it } from "bun:test";
import type { UsbDevicesWire } from "@ceraui/rpc/schemas";
import {
	getUsbEvents,
	observeUsbDevices,
	resetUsbEvents,
	USB_EVENT_LIMIT,
} from "./usb-events.ts";

function tree(names: string[]): UsbDevicesWire {
	const portPath: Record<string, string> = { "A2-top": "1.2", M2B: "1.4" };
	return {
		status: "ok",
		board: "rock-5b-plus",
		nodes: names.map((name) => ({
			key: name,
			parentKey: null,
			controller: "fc800000.usb",
			portPath: portPath[name] ?? "1",
			socketKey: name,
			speedClass: "usb2" as const,
			portClass: "usb2" as const,
			colour: "black" as const,
			scope: "socket" as const,
			label: name,
			name: name === "A2-top" ? "Upper black port" : "Modem slot inside",
			kind: "modem" as const,
			product: "SECRET-SERIAL-9f3a",
			vendorId: "2c7c",
			productId: "0801",
			presence: "present" as const,
			superspeedCapable: false,
			linkId: null,
		})),
	};
}

describe("usb event ring", () => {
	it("records a later unplug by plain name and drops the oldest past the cap", () => {
		resetUsbEvents();
		expect(observeUsbDevices(tree(["A2-top", "M2B"]), 1_000)).toBe(false);
		expect(getUsbEvents()).toEqual([]);
		expect(observeUsbDevices(tree(["M2B"]), 2_000)).toBe(true);
		expect(getUsbEvents()).toEqual([
			{
				at: 2_000,
				reason: "left",
				kind: "modem",
				socketName: "Upper black port",
			},
		]);
		expect(JSON.stringify(getUsbEvents())).not.toContain("SECRET");
		expect(JSON.stringify(getUsbEvents())).not.toContain("fc800000");
		resetUsbEvents();
		observeUsbDevices(tree(["A2-top"]), 1);
		for (let index = 0; index < USB_EVENT_LIMIT + 5; index += 1) {
			const present = index % 2 === 0 ? [] : ["A2-top"];
			observeUsbDevices(tree(present), 10 + index);
		}
		expect(getUsbEvents()).toHaveLength(USB_EVENT_LIMIT);
		expect(getUsbEvents()[0]?.at).toBe(10 + USB_EVENT_LIMIT + 4);
	});
});
