// @vitest-environment jsdom
import type { UsbDevicesWire } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
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
		expect(view.queryByText("Kept at USB 2 on purpose")).toBeNull();
		expect(view.queryByText(/14 dB/)).toBeNull();
		expect(view.queryByText(/set by the box/)).toBeNull();
		const claimed = {
			...WIRE,
			nodes: WIRE.nodes.map((node) =>
				node.key === "modem"
					? {
							...node,
							speedNote: "rm520-held-usb2" as const,
							exampleDetails: true,
						}
					: node,
			),
		};
		view.rerender({ wire: claimed, onBack: () => undefined });
		expect(view.getByTestId("device-hint").textContent).toContain(
			"Kept at USB 2 on purpose",
		);
		expect(view.getByText(/14 dB/)).toBeTruthy();
		expect(view.getByText("No serial numbers or addresses.")).toBeTruthy();
		view.rerender({
			wire: WIRE,
			events: [
				{
					seq: 1,
					at: Date.UTC(2026, 10, 19, 12, 40),
					reason: "left",
					kind: "wifi",
					socketName: "USB port 1",
				},
				{
					seq: 2,
					at: Date.UTC(2026, 10, 19, 12, 40),
					reason: "left",
					kind: "wifi",
					socketName: "USB port 1",
				},
			],
			onBack: () => undefined,
		});
		const rows = view.getAllByTestId("device-event");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("USB port 1");
		expect(rows[1]?.textContent).toContain("unplugged");
		expect(rows[0]?.textContent).not.toContain("0000:");
	});

	it("names a fixture state the reader does not produce yet", () => {
		const view = render(DevicesPage, {
			props: {
				wire: {
					...WIRE,
					nodes: [
						...WIRE.nodes,
						{
							...WIRE.nodes[1],
							key: "bad",
							socketKey: "A3-bot>hub.2",
							parentKey: "modem",
							scope: "hub-port",
							label: ">hub.2",
							name: "Hub port 2",
							displayState: "not-responding",
							reasonKey: "dropped",
							clock: "14:06",
							retry: 2,
							retryMax: 3,
							generation: "5g",
							linkSlot: 4,
						},
					],
				},
				onBack: () => undefined,
			},
		});
		expect(view.getByText("Not responding")).toBeTruthy();
		expect(view.getByText("5G modem")).toBeTruthy();
		expect(view.getByText("L4")).toBeTruthy();
		expect(view.getByTestId("devices-where")).toBeTruthy();
		expect(view.getByTestId("devices-summary").textContent).toContain(
			"isn't responding",
		);
	});

	it("hides helper actions unless the image unit is offered, and keeps them in the disclosure", async () => {
		const helper = {
			typec: {
				powerRole: "source" as const,
				dataRole: "host" as const,
				partner: true,
				vbus: "on" as const,
			},
			reprobe: null,
			holds: [],
		};
		const absent = render(DevicesPage, {
			props: {
				wire: WIRE,
				helper,
				offer: { retryPort: false, rearmExhausted: false, usb2: false },
				onBack: () => undefined,
			},
		});
		expect(absent.queryByTestId("helper-retry")).toBeNull();
		expect(absent.queryByTestId("helper-usb2")).toBeNull();
		expect(absent.queryByTestId("helper-rearm-exhausted")).toBeNull();
		absent.unmount();

		const view = render(DevicesPage, {
			props: {
				wire: WIRE,
				helper,
				offer: { retryPort: true, rearmExhausted: false, usb2: true },
				onBack: () => undefined,
			},
		});
		const retry = view.getByTestId("helper-retry");
		const usb2 = view.getByTestId("helper-usb2");
		expect(retry.closest('[data-testid="device-details"]')).not.toBeNull();
		expect(usb2.closest('[data-testid="device-details"]')).not.toBeNull();
		await fireEvent.click(retry);
		expect(view.getByTestId("helper-retry-confirm")).toBeTruthy();
		expect(view.getByText("Retry this port? The link can drop.")).toBeTruthy();

		view.rerender({
			wire: WIRE,
			helper,
			offer: { retryPort: false, rearmExhausted: true, usb2: false },
			onBack: () => undefined,
		});
		expect(view.queryByTestId("helper-retry")).toBeNull();
		expect(view.getByTestId("helper-rearm-exhausted").textContent).toContain(
			"3/3",
		);
	});

	it("keeps host controllers behind the Built in disclosure", () => {
		const view = render(DevicesPage, {
			props: {
				wire: {
					status: "ok",
					board: "rock-5b-plus",
					nodes: [
						...WIRE.nodes,
						{
							key: "root",
							parentKey: null,
							controller: "fc880000.usb",
							portPath: null,
							socketKey: "fc880000.usb:root",
							speedClass: "usb2",
							portClass: null,
							colour: null,
							scope: "root",
							label: null,
							name: "USB root hub",
							kind: "hub",
							product: "EHCI Host Controller",
							vendorId: "1d6b",
							productId: "0002",
							presence: "present",
							superspeedCapable: false,
							linkId: null,
						},
						{
							key: "bt",
							parentKey: null,
							controller: "fc800000.usb",
							portPath: "1.3",
							socketKey: "BT",
							speedClass: "full",
							portClass: "usb2",
							colour: null,
							scope: "built-in",
							label: "BT",
							name: "Bluetooth",
							kind: "other",
							product: "Bluetooth Radio",
							vendorId: "13d3",
							productId: "3572",
							presence: "present",
							superspeedCapable: false,
							linkId: null,
						},
					],
				},
				onBack: () => undefined,
			},
		});
		expect(view.queryByRole("heading", { name: "USB root hub" })).toBeNull();
		expect(view.getByRole("heading", { name: "Built in" })).toBeTruthy();
		expect(view.getByText("Bluetooth Radio")).toBeTruthy();
		const internals = view.getByTestId("device-internals");
		expect(internals.hasAttribute("open")).toBe(false);
		const controllerCaption = internals.querySelector("summary")?.textContent;
		expect(controllerCaption).toContain("USB controllers in the box");
		expect(controllerCaption).not.toContain("Details");
		expect(
			view.getAllByRole("button", { name: "Details" }).length,
		).toBeGreaterThan(0);
		expect(view.container.textContent).not.toMatch(/helper/i);
		expect(internals.textContent).toContain("EHCI Host Controller");
		expect(internals.textContent).toContain("fc880000.usb");
		expect(view.getByText("Lower blue port")).toBeTruthy();
	});

	it("names each Details toggle and exposes whether its row is open", async () => {
		const view = render(DevicesPage, {
			props: { wire: WIRE, onBack: () => undefined },
		});
		const toggles = view.getAllByRole("button", { name: "Details" });
		// The empty USB-C row has no details here; the modem row has one.
		expect(toggles).toHaveLength(1);
		const toggle = toggles[0] as HTMLButtonElement;
		// Icon only: the name comes from the label, not from visible text.
		expect(toggle.textContent?.trim()).toBe("");
		expect(toggle.getAttribute("aria-label")).toBe("Details");
		expect(toggle.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		// A phone-sized target and the shared button's visible focus ring.
		expect(toggle.className).toContain("size-11");
		expect(toggle.className).toContain("focus-visible:ring-3");
		const panel = document.getElementById(
			toggle.getAttribute("aria-controls") ?? "",
		);
		expect(panel).not.toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(panel?.hidden).toBe(true);
		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(panel?.hidden).toBe(false);
		expect(panel?.textContent).toContain("fc400000.usb");
		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(panel?.hidden).toBe(true);
	});

	it("indents one step per level and keeps follow-on lines in the text column", () => {
		const hubWire: UsbDevicesWire = {
			status: "ok",
			board: "rock-5b-plus",
			nodes: [
				{
					...(WIRE.nodes[1] as UsbDevicesWire["nodes"][number]),
					key: "hub",
					kind: "hub",
					product: null,
					portPath: "1",
					hubPorts: 4,
				},
				{
					...(WIRE.nodes[1] as UsbDevicesWire["nodes"][number]),
					key: "child",
					parentKey: "hub",
					portPath: "1.1",
					socketKey: "A3-bot>hub.1",
					scope: "hub-port",
					label: ">hub.1",
					name: "Hub port 1",
				},
			],
		};
		const view = render(DevicesPage, {
			props: { wire: hubWire, onBack: () => undefined },
		});
		const rows = view.getAllByTestId("device-row");
		expect(rows.map((row) => row.dataset.depth)).toEqual(["0", "1"]);
		expect(rows.map((row) => row.style.paddingInlineStart)).toEqual([
			"calc(1rem + 0 * var(--devices-step))",
			"calc(1rem + 1 * var(--devices-step))",
		]);
		const ports = view.getByTestId("devices-ports");
		expect(ports.style.getPropertyValue("--devices-step")).toBe("1.25rem");
		// The child hangs off the hub's dot; the hub's own line runs on to it.
		expect(
			rows[1]?.querySelector('[data-testid="device-branch"]'),
		).not.toBeNull();
		// Reason, hint and details start in the title column, never under the dot.
		for (const row of rows) {
			for (const part of row.querySelectorAll(
				'[data-testid="device-hint"], [data-testid="device-details"]',
			)) {
				expect(part.className).toContain("col-start-2");
			}
		}
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
