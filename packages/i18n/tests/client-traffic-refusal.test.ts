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
		const catalog = readCatalog(locale);
		for (const key of [
			"notifications.disruptiveActionCarryingChecking",
			"notifications.disruptiveActionStreamUnconfirmed",
		]) {
			expect(typeof catalog[key]).toBe("string");
			expect(String(catalog[key]).trim().length).toBeGreaterThan(0);
		}
		// The Stop hint names the locale's own button and page labels.
		const stream = String(catalog["notifications.disruptiveActionStreamUnconfirmed"]);
		expect(stream).toContain(String(catalog["live.stopStream"]));
		expect(stream).toContain(String(catalog["navigation.live"]));
		const carrying = String(catalog["notifications.disruptiveActionCarryingChecking"]);
		expect(carrying).not.toContain(String(catalog["live.stopStream"]));
	});
}

test("unknown-liveness refusals say what is checking and only offer Stop for the box's own stream", () => {
	const catalog = readCatalog("en");
	const carrying = String(catalog["notifications.disruptiveActionCarryingChecking"]);
	expect(carrying).toMatch(/was not run/);
	expect(carrying).toMatch(/still checking whether connected devices/);
	expect(carrying).toMatch(/Try again in a few minutes/);
	expect(carrying).not.toContain(String(catalog["live.stopStream"]));
	const stream = String(catalog["notifications.disruptiveActionStreamUnconfirmed"]);
	expect(stream).toMatch(/was not run/);
	expect(stream).toMatch(/its own stream/);
	expect(stream).toContain(String(catalog["live.stopStream"]));
	expect(stream).toContain(String(catalog["navigation.live"]));
	for (const text of [carrying, stream]) expect(text).not.toMatch(/will wait/);
});
