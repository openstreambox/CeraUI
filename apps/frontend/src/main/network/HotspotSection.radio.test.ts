// @vitest-environment jsdom

import type { WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import HotspotSection from "./HotspotSection.svelte";

it("lets the operator choose a specific USB radio by permanent identity", async () => {
	const onboard: WifiInterface = {
		ifname: "wlan0",
		hw: "Internal",
		conn: "station",
		saved: {},
		supports_hotspot: true,
	};
	const usb: WifiInterface = {
		ifname: "wlx020000000001",
		hw: "USB",
		conn: "",
		saved: {},
		supports_hotspot: true,
		radio_identity: {
			id: "02:00:00:00:00:01",
			permanent_mac: "02:00:00:00:00:01",
		},
	};
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
	expect(picker).not.toBeNull();
	if (!picker) throw new Error("missing radio picker");
	expect(picker.options[1]?.textContent).toContain("wlx020000000001");
	await fireEvent.change(picker, { target: { value: usb.radio_identity?.id } });
	expect(select).toHaveBeenCalledWith("02:00:00:00:00:01");
	await fireEvent.click(view.getByTestId("open-hotspot-dialog"));
	expect(setup).toHaveBeenCalledOnce();
});
