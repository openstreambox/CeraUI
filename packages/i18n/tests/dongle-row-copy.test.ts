import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

// A router-mode dongle's Cellular row carries two notes: who owns its
// settings, and where its bond switch is. They read as three long sentences
// and pointed at "its network interface row", a name nothing on the screen
// carries. The switch is on the dongle's row in the Ethernet section, so the
// note names that section by the label the Network view gives it.
describe("router-mode dongle notes", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} points at the Ethernet section by its own label`, () => {
			const catalog = readCatalog(locale);
			const where = catalog["network.cellular.bond.routerManagedLink"] as string;
			expect(where).toContain(catalog["network.view.ethernet"] as string);
		});
	}

	it("English stays short and plain", () => {
		const en = readCatalog("en");
		expect(en["network.cellular.reason.routerManaged"]).toBe(
			"This dongle runs its own connection. Change its settings in its own web interface.",
		);
		expect(en["network.cellular.bond.routerManagedLink"]).toBe(
			"Its bond switch is on its row under Ethernet.",
		);
	});
});
