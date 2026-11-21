import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

// The hint under the hotspot setup form tells the operator which buttons to
// press. It drifted: eight locales still described an older flow ("the name and
// password appear when you turn the hotspot on") while the form already let you
// edit them first. The dialog's Turn on hotspot does not start the hotspot by
// itself: it opens a confirmation of the name and password, whose button carries
// the same label and starts it. Tie every locale's hint to the labels it names.
describe("hotspot setup hint names the buttons the dialog shows", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} names Save and Turn on hotspot by their own labels`, () => {
			const catalog = readCatalog(locale);
			const hint = catalog["hotspotConfirm.inactiveHint"] as string;
			expect(hint).toContain(catalog["hotspotConfigurator.dialog.save"] as string);
			expect(hint).toContain(catalog["hotspotConfirm.activate"] as string);
		});
	}

	it("English stays short and in order: edit, save, confirm, turn on", () => {
		expect(readCatalog("en")["hotspotConfirm.inactiveHint"]).toBe(
			"Edit the name or password while the hotspot is off, then tap Save. Turn on hotspot shows the name and password to confirm before it starts.",
		);
	});
});
