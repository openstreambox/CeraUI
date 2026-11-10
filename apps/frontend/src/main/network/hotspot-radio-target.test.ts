import type { WifiInterface } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import { chooseHotspotRadio } from "./hotspot-radio-target";

const station: WifiInterface = {
	ifname: "wlan0",
	conn: "station",
	hw: "Internal",
	saved: {},
	supports_hotspot: true,
};
const usb: WifiInterface = {
	ifname: "wlx020000000001",
	conn: "",
	hw: "USB",
	saved: {},
	supports_hotspot: true,
	radio_identity: {
		id: "02:00:00:00:00:01",
		permanent_mac: "02:00:00:00:00:01",
	},
};
describe("hotspot radio target", () => {
	it("prefers an idle USB radio to the station", () => {
		expect(
			chooseHotspotRadio([
				["0", station],
				["1", usb],
			])?.[0],
		).toBe("1");
	});
	it("retains an explicit radio selection across renames and roster id changes", () => {
		expect(
			chooseHotspotRadio(
				[
					["0", station],
					["8", { ...usb, ifname: "renamed" }],
				],
				usb.radio_identity?.id,
			)?.[0],
		).toBe("8");
		expect(
			chooseHotspotRadio(
				[
					["0", station],
					["1", usb],
				],
				"0",
			)?.[0],
		).toBe("0");
	});
	it("retains an active AP whose legacy status omits supports_hotspot", () => {
		expect(
			chooseHotspotRadio([
				[
					"1",
					{
						...usb,
						supports_hotspot: undefined,
						mode: "hotspot",
						hotspot: { name: "Example", available_channels: {} },
					},
				],
			])?.[0],
		).toBe("1");
	});
	it("does not silently retarget when a selected USB radio is unplugged", () => {
		expect(
			chooseHotspotRadio([["0", station]], usb.radio_identity?.id),
		).toBeUndefined();
	});
	it("does not select an unsupported or degraded radio", () => {
		expect(
			chooseHotspotRadio([["1", { ...usb, degraded_reason: "unavailable" }]]),
		).toBeUndefined();
	});
});
