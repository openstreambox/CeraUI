import { expect, test } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

for (const locale of ALL_LOCALES) {
 test(`${locale} has client-aware update and power refusal copy`, () => {
  const catalog = readCatalog(locale);
  for (const key of ["general.updateReasonClientTraffic", "notifications.disruptiveActionClientTraffic"]) {
   expect(typeof catalog[key]).toBe("string");
   expect(String(catalog[key]).trim().length).toBeGreaterThan(0);
  }
 });
}

test("English refusals direct connected devices to stop and explain power protection", () => {
 const catalog = readCatalog("en");
 expect(catalog["general.updateReasonClientTraffic"]).toMatch(/connected devices/);
 expect(catalog["general.updateReasonClientTraffic"]).not.toMatch(/Press Stop/);
 expect(catalog["notifications.disruptiveActionClientTraffic"]).toMatch(/connected devices.*traffic/);
 expect(catalog["notifications.clientCarrying"]).toMatch(/restarts, power-off/);
});
