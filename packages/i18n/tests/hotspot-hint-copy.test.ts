import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

// The hint under the hotspot setup form tells the operator which buttons to
// press. It drifted: eight locales still described an older flow ("the name and
// password appear when you turn the hotspot on") while the form already let you
// edit them first. Enable Hotspot does not start the hotspot by itself: it opens
// a confirmation of the name and password, whose Turn on hotspot starts it. Tie
// every locale's hint to the three button labels it names.
describe("hotspot setup hint names the buttons the dialog shows", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} names Save, Enable Hotspot and the confirmation's Turn on hotspot by their own labels`, () => {
			const catalog = readCatalog(locale);
			const hint = catalog["hotspotConfirm.inactiveHint"] as string;
			expect(hint).toContain(catalog["hotspotConfigurator.dialog.save"] as string);
			expect(hint).toContain(catalog["network.status.enableHotspot"] as string);
			expect(hint).toContain(catalog["hotspotConfirm.activate"] as string);
		});
	}

	it("English stays short and in order: edit, save, confirm, turn on", () => {
		expect(readCatalog("en")["hotspotConfirm.inactiveHint"]).toBe(
			"Edit the name, password or channel while the hotspot is off, then tap Save. Enable Hotspot then shows the name and password to confirm, and Turn on hotspot starts it.",
		);
	});
});
