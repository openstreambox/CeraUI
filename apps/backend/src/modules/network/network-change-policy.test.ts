import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	askBeforePrompt,
	CHANGE_SAFETY_COPY,
	classifyPath,
	DEFAULT_SETTLE_MS,
	DEFAULT_WINDOW_SECONDS,
	isAskBeforeAnswer,
	needsAskBefore,
	noticeMessageKey,
	offeredAnswers,
	predictCut,
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
	it("names the interface only when it is known", () => {
		expect(
			askBeforePrompt({
				path: "own",
				ingress: "ap0",
				devices: ["ap0"],
				seconds: 90,
			}),
		).toMatchObject({
			via: "ap0",
			messageKey: CHANGE_SAFETY_COPY.askBeforeOwn,
		});
		expect(
			askBeforePrompt({
				path: "unknown",
				ingress: undefined,
				devices: ["ap0"],
				seconds: 90,
			}),
		).toMatchObject({
			via: undefined,
			messageKey: CHANGE_SAFETY_COPY.askBeforeUnknown,
		});
	});
	it("undoes after 90 s without confirmation and settles for 15 s", () => {
		expect(DEFAULT_WINDOW_SECONDS).toBe(90);
		expect(DEFAULT_SETTLE_MS).toBe(15_000);
	});
});

describe("ask before: a primary action and a deliberate one, nothing preselected", () => {
	const prompt = askBeforePrompt({
		path: "own",
		ingress: "ap0",
		devices: ["ap0"],
		seconds: 90,
	});
	it("makes the protected change the primary action", () => {
		expect(prompt.primary).toEqual({
			answer: "undo-automatically",
			labelKey: CHANGE_SAFETY_COPY.askBeforeUndo,
		});
	});
	it("offers keeping the disconnect only as the deliberate action", () => {
		expect(prompt.deliberate).toEqual({
			answer: "keep-change",
			labelKey: CHANGE_SAFETY_COPY.askBeforeKeep,
		});
	});
	it("has no preselected, default or focused answer, and no toggle", () => {
		for (const field of [
			"preselected",
			"default",
			"focus",
			"selected",
			"answers",
		])
			expect(prompt, field).not.toHaveProperty(field);
	});
	it("accepts only the three explicit answers", () => {
		expect(isAskBeforeAnswer("undo-automatically")).toBe(true);
		expect(isAskBeforeAnswer("keep-if-reachable")).toBe(true);
		expect(isAskBeforeAnswer("keep-change")).toBe(true);
		for (const value of [undefined, null, "", "keep", "yes", true, 1, {}])
			expect(isAskBeforeAnswer(value), String(value)).toBe(false);
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
			if (key === CHANGE_SAFETY_COPY.askBeforeKeep) continue;
			const text = en[key] as string;
			expect(text.length, key).toBeLessThanOrEqual(90);
			expect(text, key).not.toMatch(/not live|return live/i);
		}
	});
	it("names the 90 s undo on the primary action", () => {
		const text = en[CHANGE_SAFETY_COPY.askBeforeUndo] as string;
		expect(text).toStartWith("Make the change");
		expect(placeholders(text)).toEqual(["seconds"]);
	});
	it("states the consequence in the deliberate action's own label", () => {
		// The label is the button's accessible name, so a keyboard or
		// screen-reader user hears the consequence before choosing it.
		const text = en[CHANGE_SAFETY_COPY.askBeforeKeep] as string;
		expect(text).toStartWith("I know what I'm doing");
		expect(text).toMatch(/disconnect me/);
		expect(text).toMatch(/don't undo/);
		expect(text).toMatch(/switch connection or reset the box/);
		expect(text.length).toBeLessThanOrEqual(130);
		expect(text).not.toMatch(/not live|return live/i);
	});
	it("ties the ask-after notice to the missing confirmation", () => {
		const text = en[CHANGE_SAFETY_COPY.noticeDisconnected] as string;
		expect(text).toMatch(/confirm/);
		expect(text).toMatch(/undid/);
	});
});

describe("predicting whether a change cuts the session, before applying", () => {
	const route = (carriers: string[], tunnel = true) => ({ carriers, tunnel });
	it("trusted arrival evidence decides cuts or clear", () => {
		expect(predictCut(["eth0"], "eth0", undefined)).toEqual({
			verdict: "cuts",
			via: "eth0",
		});
		expect(predictCut(["eth0"], "wlan0", route(["eth0"]))).toEqual({
			verdict: "clear",
			via: undefined,
		});
	});
	it("route evidence can say cuts or may-cut, never clear", () => {
		expect(predictCut(["eth0"], undefined, route(["eth0"], false))).toEqual({
			verdict: "cuts",
			via: "eth0",
		});
		expect(predictCut(["eth0"], undefined, route(["eth0", "wwan0"]))).toEqual({
			verdict: "may-cut",
			via: "eth0",
		});
		expect(predictCut(["eth0"], undefined, route(["wwan0"]))).toEqual({
			verdict: "unknown",
			via: undefined,
		});
		expect(predictCut(["eth0"], undefined, undefined).verdict).toBe("unknown");
	});
});

describe("ask before, for a session that cannot confirm", () => {
	const base = {
		path: "unknown" as const,
		ingress: undefined,
		devices: ["eth0"],
		seconds: 90,
		settleSeconds: 15,
	};
	it("offers keep-if-reachable first when the box has endpoints to probe", () => {
		const prompt = askBeforePrompt({
			...base,
			route: { carriers: ["eth0"], tunnel: true },
			reachability: true,
		});
		expect(prompt).toMatchObject({
			cut: "cuts",
			via: "eth0",
			canConfirm: false,
			settleSeconds: 15,
			messageKey: CHANGE_SAFETY_COPY.askBeforeRouteCuts,
			primary: {
				answer: "keep-if-reachable",
				labelKey: CHANGE_SAFETY_COPY.askBeforeReachable,
			},
			alternative: {
				answer: "undo-automatically",
				labelKey: CHANGE_SAFETY_COPY.askBeforeUndoVia,
			},
			deliberate: {
				answer: "keep-change",
				labelKey: CHANGE_SAFETY_COPY.askBeforeKeepRemote,
			},
		});
		expect(offeredAnswers(prompt)).toEqual([
			"keep-if-reachable",
			"undo-automatically",
			"keep-change",
		]);
	});
	it("without endpoints, says who can confirm instead of promising a confirm", () => {
		const prompt = askBeforePrompt(base);
		expect(prompt.primary).toEqual({
			answer: "undo-automatically",
			labelKey: CHANGE_SAFETY_COPY.askBeforeUndoLocal,
		});
		expect(prompt).not.toHaveProperty("alternative");
		expect(prompt.cut).toBe("unknown");
	});
	it("never offers keep-if-reachable to a session on the changed port", () => {
		const prompt = askBeforePrompt({
			...base,
			path: "own",
			ingress: "eth0",
			reachability: true,
		});
		expect(offeredAnswers(prompt)).toEqual([
			"undo-automatically",
			"keep-change",
		]);
		expect(prompt.canConfirm).toBe(true);
	});
	it("a deliberate re-apply from another path can confirm, and is never told 'disconnect me'", () => {
		const prompt = askBeforePrompt({
			...base,
			path: "other",
			ingress: "wlan0",
			reachability: true,
		});
		expect(prompt).toMatchObject({
			canConfirm: true,
			primary: { answer: "undo-automatically" },
			deliberate: { labelKey: CHANGE_SAFETY_COPY.askBeforeKeepRemote },
		});
		expect(prompt).not.toHaveProperty("alternative");
	});
	it("warns while live, and only then", () => {
		expect(askBeforePrompt({ ...base, live: true }).liveKey).toBe(
			CHANGE_SAFETY_COPY.askBeforeLive,
		);
		expect(askBeforePrompt(base)).not.toHaveProperty("liveKey");
	});
	it("maps every notice reason to its own sentence", () => {
		const keys = (
			[
				"disconnected",
				"unreachable",
				"restart",
				"interrupted",
				"unsaved",
			] as const
		).map(noticeMessageKey);
		expect(new Set(keys).size).toBe(5);
	});
});

describe("copy for sessions that cannot confirm", () => {
	const en = JSON.parse(
		readFileSync(join(MESSAGES, "en.json"), "utf8"),
	) as Record<string, string>;
	const placeholders = (text: string) =>
		[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	it("names who can still confirm, and the deadline", () => {
		expect(
			placeholders(en[CHANGE_SAFETY_COPY.askBeforeUndoVia] as string),
		).toEqual(["seconds", "via"]);
		expect(
			placeholders(en[CHANGE_SAFETY_COPY.askBeforeUndoLocal] as string),
		).toEqual(["seconds"]);
		expect(en[CHANGE_SAFETY_COPY.askBeforeUndoVia]).toMatch(/unless someone/);
	});
	it("says keep-if-reachable checks the path to your own device, and when", () => {
		const text = en[CHANGE_SAFETY_COPY.askBeforeReachable] as string;
		expect(text).toStartWith("Make the change");
		expect(text).toMatch(/your device/);
		expect(placeholders(text)).toEqual(["settle"]);
	});
	it("never tells a remote session it will be disconnected, only that there is no undo", () => {
		const text = en[CHANGE_SAFETY_COPY.askBeforeKeepRemote] as string;
		expect(text).not.toMatch(/disconnect me/i);
		expect(text).toMatch(/no undo/);
	});
	it("the reachability notice does not blame a missing confirmation", () => {
		const text = en[CHANGE_SAFETY_COPY.noticeUnreachable] as string;
		expect(text).not.toMatch(/confirm/);
		expect(text).toMatch(/your device/);
		expect(en[CHANGE_SAFETY_COPY.noticeUnsaved]).toMatch(/confirmed/);
	});
});
