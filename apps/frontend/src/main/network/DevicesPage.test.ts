// @vitest-environment jsdom
import type { UsbDevicesWire } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import DevicesPage from "./DevicesPage.svelte";

const WIRE: UsbDevicesWire = {
	status: "ok",
	board: "rock-5b-plus",
	nodes: [
		{
			key: "c",
			parentKey: null,
			controller: "fc000000.usb",
			portPath: "1",
			socketKey: "C",
			speedClass: "unknown",
			portClass: "usb3",
			colour: null,
			scope: "socket",
			label: "C",
			name: "USB-C data port",
			kind: "other",
			product: null,
			vendorId: null,
			productId: null,
			presence: "nothing-detected",
			superspeedCapable: false,
			linkId: null,
		},
		{
			key: "modem",
			parentKey: null,
			controller: "fc400000.usb",
			portPath: "1.1",
			socketKey: "A3-bot",
			speedClass: "usb2",
			portClass: "usb3",
			colour: "blue",
			scope: "socket",
			label: "A3-bot",
			name: "Lower blue port",
			kind: "modem",
			product: "RM520N-GL",
			vendorId: "2c7c",
			productId: "0801",
			presence: "present",
			superspeedCapable: false,
			linkId: null,
		},
	],
};

describe("Devices page", () => {
	it("shows an empty USB-C port and the USB 2 hint, and not an unknown device", () => {
		const view = render(DevicesPage, {
			props: { wire: WIRE, onBack: () => undefined },
		});
		const empty = view.getByTestId("device-empty");
		expect(empty.textContent).toContain("Empty.");
		expect(empty.textContent).not.toContain("Unknown device");
		expect(view.getAllByText("Lower blue port").length).toBeGreaterThan(0);
		expect(view.getByTestId("device-hint").textContent).toContain(
			"Kept at USB 2 on purpose",
		);
		expect(view.getByText("No serial numbers or addresses.")).toBeTruthy();
		view.rerender({
			wire: WIRE,
			events: [
				{
					at: Date.UTC(2026, 10, 19, 12, 40),
					reason: "left",
					kind: "wifi",
					socketName: "Upper black port",
				},
			],
			onBack: () => undefined,
		});
		const event = view.getByTestId("device-event");
		expect(event.textContent).toContain("Upper black port");
		expect(event.textContent).toContain("Unplugged");
		expect(event.textContent).not.toContain("SECRET");
	});

	it("says the tree is still being read", () => {
		const view = render(DevicesPage, {
			props: { wire: undefined, onBack: () => undefined },
		});
		expect(view.getByTestId("devices-checking").textContent).toContain(
			"Checking",
		);
	});
});
