import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog, readRenderedOracle } from "./helpers/catalog.js";

describe("carrying-safe idle copy", () => {
 for (const locale of ALL_LOCALES) {
  it(`${locale} preserves the frozen idle key and provides separate own-stream wording`, () => {
   const catalog = readCatalog(locale);
   expect(catalog["hud.healthExplainIdle"]).toBe(readRenderedOracle(locale)["hud.healthExplainIdle"]);
   const copy = catalog["hud.healthExplainOwnStreamIdle"];
   expect(typeof copy).toBe("string");
   expect((copy as string).trim().length).toBeGreaterThan(0);
   expect(copy).not.toBe(catalog["hud.healthExplainIdle"]);
  });
 }
 it("English leaves client liveness explicit", () => {
  expect(readCatalog("en")["hud.healthExplainOwnStreamIdle"]).toBe("The box’s own stream is idle. Client traffic can still be live.");
 });
});
