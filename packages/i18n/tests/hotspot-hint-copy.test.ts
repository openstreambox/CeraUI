import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

// The hint under the hotspot setup form tells the operator which buttons to
// press. It drifted: eight locales still described an older flow ("the name and
// password appear when you turn the hotspot on") while the form already let you
// edit them first. Tie every locale's hint to the button labels it names.
describe("hotspot setup hint names the buttons the dialog shows", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} names Save and Enable Hotspot by their own labels`, () => {
			const catalog = readCatalog(locale);
			const hint = catalog["hotspotConfirm.inactiveHint"] as string;
			expect(hint).toContain(catalog["hotspotConfigurator.dialog.save"] as string);
			expect(hint).toContain(catalog["network.status.enableHotspot"] as string);
		});
	}

	it("English stays short and in order: edit, save, turn on", () => {
		expect(readCatalog("en")["hotspotConfirm.inactiveHint"]).toBe(
			"Edit the name, password or channel while the hotspot is off, then tap Save. Enable Hotspot turns it on with the saved settings.",
		);
	});
});
