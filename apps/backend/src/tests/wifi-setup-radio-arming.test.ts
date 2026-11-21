/*
  On the device image's setup radio (`wlan0`), CeraUI never arms NetworkManager
  autoconnect on its own hotspot profile, so the first-boot setup AP never
  competes with an autonomous CeraUI AP at boot. Saved hotspot intent is still
  honoured: CeraUI's restore starts the AP itself once it runs. The same cases
  on another radio keep upstream's arming (the autoconnect suites run there).
*/
import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import { hotspotAutoconnectFields } from "../modules/wifi/wifi-autoconnect-policy.ts";
import { PROVISIONING_AP_IFNAME } from "../modules/wifi/wifi-provisioning-ap.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture(PROVISIONING_AP_IFNAME);
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};

test("the arming decision differs only by the radio's name", async () => {
	f.persistMode(MAC, "hotspot");
	await f.sample();
	const binding = {
		"802-11-wireless.mac-address": MAC,
		"match.path": PORT,
	};

	expect(
		hotspotAutoconnectFields(MAC, binding, PROVISIONING_AP_IFNAME)[
			"connection.autoconnect"
		],
	).toBe("no");
	expect(
		hotspotAutoconnectFields(MAC, binding, "wlan1")["connection.autoconnect"],
	).toBe("yes");
});

test("a confirmed unique pinned Start on the setup radio leaves autoconnect off", async () => {
	expect(await f.start()).toEqual({ success: true });

	expect(profile()["802-11-wireless.mac-address"]).toBe(MAC);
	expect(profile()["match.path"]).toBe(PORT);
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
	expect(
		f.effects.some((e) => e.fields["connection.autoconnect"] === "yes"),
	).toBe(false);
});

test("saved hotspot intent on the setup radio is disarmed at discovery and restored by CeraUI", async () => {
	profile()["match.path"] = PORT;
	f.persistMode(MAC, "hotspot");

	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");

	await f.restore();
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(f.activations).toEqual([PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});

test("a legacy armed profile on the setup radio records hotspot intent before it is disarmed", async () => {
	profile()["match.path"] = PORT;

	await f.discover();
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(
		f.effects
			.filter((e) => e.fields["connection.autoconnect"] === "no")
			.map((e) => e.intent),
	).toEqual(["hotspot"]);

	await f.restore();
	expect(f.activations).toEqual([PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test("hybrid on the setup radio stays disarmed as upstream has it", async () => {
	f.seed(true);
	expect(await f.start()).toEqual({ success: true });
	expect(profile()["connection.autoconnect"]).toBe("no");
});
