import type { WifiInterface } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import {
	chooseHotspotRadio,
	expireHotspotChoice,
	findHotspotRadio,
	type HotspotRadioChoice,
	hotspotRadioLabel,
	pickHotspotRadio,
} from "./hotspot-radio-target";

const station: WifiInterface = {
	ifname: "wlan0",
	incarnation: "onboard-1",
	conn: "station",
	hw: "Internal",
	saved: {},
	supports_hotspot: true,
};
const usb: WifiInterface = {
	ifname: "wlan1",
	incarnation: "usb-1",
	conn: "",
	hw: "USB",
	saved: {},
	supports_hotspot: true,
};
const two: [string, WifiInterface][] = [
	["0", station],
	["1", usb],
];

describe("hotspot radio target", () => {
	it("preselects the only capable radio", () => {
		expect(chooseHotspotRadio([["0", station]])?.[0]).toBe("0");
	});

	it("needs an explicit pick when several radios can host", () => {
		expect(chooseHotspotRadio(two)).toBeUndefined();
		// Not even a live AP is picked for the operator on an ambiguous host.
		expect(
			chooseHotspotRadio([
				["0", station],
				[
					"1",
					{
						...usb,
						mode: "hotspot",
						hotspot: { name: "Example", available_channels: {} },
					},
				],
			]),
		).toBeUndefined();
	});

	it("records a pick as [id, incarnation] and targets exactly that lifetime", () => {
		const choice = pickHotspotRadio(two, "1");
		expect(choice).toEqual({ selected: ["1", "usb-1"] });
		expect(chooseHotspotRadio(two, choice)?.[0]).toBe("1");
	});

	it("ignores a pick of a radio that cannot host", () => {
		expect(
			pickHotspotRadio([["0", { ...station, supports_hotspot: false }]], "0"),
		).toEqual({});
	});

	it("keeps an active AP whose status omits supports_hotspot", () => {
		const live: WifiInterface = {
			...usb,
			supports_hotspot: undefined,
			mode: "hotspot",
			hotspot: { name: "Example", available_channels: {} },
		};
		expect(chooseHotspotRadio([["1", live]])?.[0]).toBe("1");
		expect(pickHotspotRadio([["1", live]], "1")).toEqual({
			selected: ["1", "usb-1"],
		});
	});

	it.each([
		[
			"a backend restart or replug (new incarnation)",
			[
				["0", station],
				["1", { ...usb, incarnation: "usb-2" }],
			],
		],
		[
			"an unplugged radio (id missing)",
			[
				["0", station],
				["2", { ...usb, incarnation: "other" }],
			],
		],
		[
			"a degraded row",
			[
				["0", station],
				["1", { ...usb, degraded_reason: "permanent-mac-unresolved" }],
			],
		],
	] as const)(
		"expires the pick on %s and does not fall through",
		(_, roster) => {
			const radios = roster as unknown as [string, WifiInterface][];
			const choice: HotspotRadioChoice = { selected: ["1", "usb-1"] };
			expect(chooseHotspotRadio(radios, choice)).toBeUndefined();
			const expired = expireHotspotChoice(radios, choice);
			expect(expired).toEqual({ lost: true });
			expect(chooseHotspotRadio(radios, expired)).toBeUndefined();
		},
	);

	it("returns the same choice object while the pick is still valid", () => {
		const choice = pickHotspotRadio(two, "0");
		expect(expireHotspotChoice(two, choice)).toBe(choice);
		const empty: HotspotRadioChoice = {};
		expect(expireHotspotChoice(two, empty)).toBe(empty);
	});

	it("expires a pick on the only radio when its incarnation changes under the same id", () => {
		const before: [string, WifiInterface][] = [
			["0", { ...station, incarnation: "old" }],
		];
		const after: [string, WifiInterface][] = [
			["0", { ...station, incarnation: "new" }],
		];
		const choice = pickHotspotRadio(before, "0");
		expect(choice).toEqual({ selected: ["0", "old"] });
		const expired = expireHotspotChoice(after, choice);
		expect(expired).toEqual({ lost: true });
		// No singleton default for an expired pick, not even the same id.
		expect(chooseHotspotRadio(after, expired)).toBeUndefined();
		// A fresh pick binds the new lifetime.
		expect(pickHotspotRadio(after, "0")).toEqual({ selected: ["0", "new"] });
	});

	it("does not move an expired pick onto a different single remaining radio", () => {
		const expired = expireHotspotChoice([["0", station]], {
			selected: ["1", "usb-1"],
		});
		expect(chooseHotspotRadio([["0", station]], expired)).toBeUndefined();
	});

	it("never matches or picks a row without an incarnation", () => {
		const tokenless: WifiInterface = { ...usb, incarnation: undefined };
		expect(
			findHotspotRadio([["1", tokenless]], ["1", undefined]),
		).toBeUndefined();
		expect(pickHotspotRadio([["1", tokenless]], "1")).toEqual({});
		expect(chooseHotspotRadio([["1", tokenless]])).toBeUndefined();
	});

	it("does not select an unsupported or degraded radio", () => {
		expect(
			chooseHotspotRadio([["1", { ...usb, degraded_reason: "unavailable" }]]),
		).toBeUndefined();
		expect(
			chooseHotspotRadio([["1", { ...usb, supports_hotspot: false }]]),
		).toBeUndefined();
	});

	it("labels a radio without its hardware address", () => {
		expect(hotspotRadioLabel(usb)).toBe("USB · wlan1");
		expect(hotspotRadioLabel({ ...usb, hw: "02:00:00:00:00:01" })).toBe(
			"wlan1",
		);
		expect(hotspotRadioLabel({ ...usb, hw: "wlan1" })).toBe("wlan1");
	});
});
