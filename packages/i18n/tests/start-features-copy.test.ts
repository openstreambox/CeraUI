import { describe, expect, it } from "bun:test";

import { ALL_LOCALES, readCatalog } from "./helpers/catalog.js";

// The `stream-start-features` notice. The backend sends a reason key with the
// dropped features as tokens; the UI reads each token as its feature phrase and
// joins two with the pair template. Every catalog needs every piece, with the
// slots the UI fills, and no catalog may lean on English for the sentence.
const SENTENCES = [
	"notifications.startFeatures.unsupported",
	"notifications.startFeatures.unconfirmed",
] as const;
const PHRASES = [
	"notifications.startFeatures.audioMix",
	"notifications.startFeatures.composition",
	"notifications.startFeatures.customLayout",
] as const;
const PAIR = "notifications.startFeatures.pair";

const placeholders = (value: string) => [...value.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).sort();

function text(locale: (typeof ALL_LOCALES)[number], key: string): string {
	const value = readCatalog(locale)[key];
	if (typeof value !== "string") throw new Error(`${locale}:${key} is not a plain string`);
	return value;
}

describe("stream-start-features notice copy", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale}: both reasons take the feature list`, () => {
			for (const key of SENTENCES) expect(placeholders(text(locale, key))).toEqual(["features"]);
		});

		it(`${locale}: feature phrases are plain text`, () => {
			for (const key of PHRASES) {
				expect(text(locale, key).length).toBeGreaterThan(0);
				expect(placeholders(text(locale, key))).toEqual([]);
			}
			// The fallback audio depends on the saved source, so the mix phrase
			// names the mix only and adds no aside about what the stream carries.
			expect(text(locale, "notifications.startFeatures.audioMix")).not.toMatch(/[(（]/);
		});

		it(`${locale}: the pair template joins two phrases in order`, () => {
			const pair = text(locale, PAIR);
			expect(placeholders(pair)).toEqual(["first", "second"]);
			expect(pair.indexOf("{first}")).toBeLessThan(pair.indexOf("{second}"));
		});

		if (locale !== "en") {
			it(`${locale}: the reasons are not the English sentences`, () => {
				for (const key of SENTENCES) expect(text(locale, key)).not.toBe(text("en", key));
			});
		}
	}
});
