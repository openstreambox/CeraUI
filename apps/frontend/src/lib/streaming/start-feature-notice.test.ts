import { describe, expect, it } from "vitest";

import {
	localizedStartFeatureList,
	START_FEATURES_NOTICE_KEYS,
} from "./start-feature-notice";

// A stand-in catalog with the shape of a locale that is not English, so a test
// cannot pass by echoing the backend's English sentence.
const CATALOG: Record<string, string> = {
	"notifications.startFeatures.audioMix": "Audiomix",
	"notifications.startFeatures.composition": "Bild-in-Bild-Komposition",
	"notifications.startFeatures.customLayout": "eigene Anordnung",
	"notifications.startFeatures.pair": "{first} und {second}",
};

function translate(
	key: string,
	params?: Record<string, string | number | boolean>,
): string | undefined {
	const template = CATALOG[key];
	if (template === undefined) return undefined;
	return template.replace(/\{(\w+)\}/g, (_, name: string) =>
		String(params?.[name] ?? `{${name}}`),
	);
}

describe("localizedStartFeatureList", () => {
	it("reads one feature as its own phrase", () => {
		expect(localizedStartFeatureList(["custom-layout"], translate)).toBe(
			"eigene Anordnung",
		);
	});

	it("joins two features with the locale's pair wording, in order", () => {
		expect(
			localizedStartFeatureList(["audio-mix", "composition"], translate),
		).toBe("Audiomix und Bild-in-Bild-Komposition");
	});

	it("gives up on an unknown token so the caller shows the wire text", () => {
		expect(
			localizedStartFeatureList(["audio-mix", "hdr"], translate),
		).toBeUndefined();
	});

	it("gives up on a list the backend never sends", () => {
		expect(
			localizedStartFeatureList(["audio-mix", "audio-mix"], translate),
		).toBeUndefined();
		expect(
			localizedStartFeatureList(["composition", "custom-layout"], translate),
		).toBeUndefined();
	});

	it("gives up on a missing, empty or non-list value", () => {
		expect(localizedStartFeatureList(undefined, translate)).toBeUndefined();
		expect(localizedStartFeatureList([], translate)).toBeUndefined();
		expect(localizedStartFeatureList("audio-mix", translate)).toBeUndefined();
	});

	it("gives up when the catalog lacks a phrase", () => {
		expect(
			localizedStartFeatureList(["audio-mix"], () => undefined),
		).toBeUndefined();
	});

	it("knows both reason keys the backend sends", () => {
		expect([...START_FEATURES_NOTICE_KEYS].sort()).toEqual([
			"notifications.startFeatures.unconfirmed",
			"notifications.startFeatures.unsupported",
		]);
	});
});
