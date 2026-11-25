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

test("refusal asks for a new attempt without claiming a stream ended or queuing an action", () => {
	const text = String(readCatalog("en")["notifications.disruptiveActionClientTraffic"]);
	expect(text).toMatch(/was not run/);
	expect(text).toMatch(/Try again/);
	expect(text).not.toMatch(/will wait|has stopped|have stopped/);
});

for (const locale of ALL_LOCALES) {
	test(`${locale} has unknown-liveness refusal copy`, () => {
		const text = readCatalog(locale)["notifications.disruptiveActionLivenessUnknown"];
		expect(typeof text).toBe("string");
		expect(String(text).trim().length).toBeGreaterThan(0);
	});
}

test("an unknown-liveness refusal says the box is checking, how long to wait and what settles it", () => {
	const catalog = readCatalog("en");
	const text = String(catalog["notifications.disruptiveActionLivenessUnknown"]);
	expect(text).toMatch(/was not run/);
	expect(text).toMatch(/still checking/);
	expect(text).toMatch(/Try again in a few minutes/);
	expect(text).toContain(String(catalog["live.stopStream"]));
	expect(text).toContain(String(catalog["navigation.live"]));
	expect(text).not.toMatch(/will wait|has stopped|have stopped/);
});
