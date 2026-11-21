// @vitest-environment jsdom

import type { WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import HotspotSection from "./HotspotSection.svelte";

const onboard: WifiInterface = {
	ifname: "wlan0",
	incarnation: "onboard-1",
	hw: "Internal",
	conn: "station",
	saved: {},
	supports_hotspot: true,
};
const usb: WifiInterface = {
	ifname: "wlan1",
	incarnation: "usb-1",
	hw: "02:00:00:00:00:01",
	conn: "",
	saved: {},
	supports_hotspot: true,
};

it("lets the operator choose a specific radio by its row id", async () => {
	const select = vi.fn();
	const setup = vi.fn();
	const view = render(HotspotSection, {
		hotspotInterfaces: [],
		hotspotTarget: ["0", onboard],
		radios: [
			["0", onboard],
			["1", usb],
		],
		onSelect: select,
		onSetup: setup,
	});
	const picker = view.container.querySelector("select");
	if (!picker) throw new Error("missing radio picker");
	expect(picker.options).toHaveLength(2);
	expect(picker.options[1]?.textContent).toContain("Wi-Fi 2");
	// The label never prints a hardware address.
	expect(picker.textContent).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
	await fireEvent.change(picker, { target: { value: "1" } });
	expect(select).toHaveBeenCalledWith("1");
	await fireEvent.click(view.getByTestId("open-hotspot-dialog"));
	expect(setup).toHaveBeenCalledOnce();
});

it("asks for a radio and disables Setup while no target is chosen", () => {
	const view = render(HotspotSection, {
		hotspotInterfaces: [],
		hotspotTarget: undefined,
		radios: [
			["0", onboard],
			["1", usb],
		],
		selectionLost: true,
		onSelect: vi.fn(),
		onSetup: vi.fn(),
	});
	const picker = view.container.querySelector("select");
	if (!picker) throw new Error("missing radio picker");
	expect(picker.value).toBe("");
	expect(picker.options[0]?.disabled).toBe(true);
	expect(picker.options[0]?.textContent).toBe("Choose a radio");
	expect(view.getByTestId("hotspot-radio-lost")).toBeTruthy();
	expect(
		(view.getByTestId("open-hotspot-dialog") as HTMLButtonElement).disabled,
	).toBe(true);
});

it("shows steering pending instead of active until activation finishes", () => {
	const view = render(HotspotSection, {
		hotspotInterfaces: [
			[
				"93",
				{
					ifname: "wlan93",
					hw: "Test",
					conn: "ap",
					saved: {},
					mode: "hotspot",
					transition: "activating",
					hotspot: { name: "Test AP", available_channels: {} },
				},
			],
		],
		hotspotTarget: undefined,
		radios: [],
		onSelect: vi.fn(),
		onSetup: vi.fn(),
	});
	expect(view.getByText(/Steering pending/)).toBeTruthy();
	expect(view.queryByText(/^Active/)).toBeNull();
});
