import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	askBeforePrompt,
	CHANGE_SAFETY_COPY,
	classifyPath,
	needsAskBefore,
} from "./network-change-policy.ts";

const MESSAGES = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"..",
	"packages",
	"i18n",
	"messages",
);

describe("who is asked, and when", () => {
	it("classifies the session's path from trusted evidence only", () => {
		expect(classifyPath(["wlan0"], "wlan0")).toBe("own");
		expect(classifyPath(["wwan0"], "wlan0")).toBe("other");
		expect(classifyPath(["wlan0"], undefined)).toBe("unknown");
	});
	it("asks before for own and unknown paths, and for deliberate re-applies", () => {
		expect(needsAskBefore("own", false)).toBe(true);
		expect(needsAskBefore("unknown", false)).toBe(true);
		expect(needsAskBefore("other", false)).toBe(false);
		expect(needsAskBefore("other", true)).toBe(true);
	});
	it("names the interface only when it is known, and focuses the safe answer", () => {
		expect(askBeforePrompt("own", "ap0", 90)).toMatchObject({
			via: "ap0",
			messageKey: CHANGE_SAFETY_COPY.askBeforeOwn,
			preselected: "undo-automatically",
		});
		expect(askBeforePrompt("unknown", undefined, 90)).toMatchObject({
			via: undefined,
			messageKey: CHANGE_SAFETY_COPY.askBeforeUnknown,
		});
	});
});

describe("change-safety copy", () => {
	const locales = readdirSync(MESSAGES).filter((f) => f.endsWith(".json"));
	const en = JSON.parse(
		readFileSync(join(MESSAGES, "en.json"), "utf8"),
	) as Record<string, string>;
	const placeholders = (text: string) =>
		[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	it("exists in every catalog with the same placeholders", () => {
		expect(locales.length).toBeGreaterThanOrEqual(10);
		for (const file of locales) {
			const catalog = JSON.parse(
				readFileSync(join(MESSAGES, file), "utf8"),
			) as Record<string, string>;
			for (const key of Object.values(CHANGE_SAFETY_COPY)) {
				expect(typeof catalog[key], `${file} ${key}`).toBe("string");
				expect(placeholders(catalog[key] as string), `${file} ${key}`).toEqual(
					placeholders(en[key] as string),
				);
			}
		}
	});
	it("stays one short sentence and short buttons in English", () => {
		for (const key of Object.values(CHANGE_SAFETY_COPY)) {
			const text = en[key] as string;
			expect(text.length, key).toBeLessThanOrEqual(90);
			expect(text, key).not.toMatch(/not live|return live/i);
		}
	});
});
