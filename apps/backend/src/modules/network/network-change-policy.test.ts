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
	predictCut,
	sessionCanConfirm,
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
				canConfirm: true,
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
				canConfirm: true,
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
		canConfirm: true,
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
	it("accepts only the two explicit answers", () => {
		expect(isAskBeforeAnswer("undo-automatically")).toBe(true);
		expect(isAskBeforeAnswer("keep-change")).toBe(true);
		for (const value of [
			undefined,
			null,
			"",
			"keep",
			"yes",
			true,
			1,
			{},
			// The automatic keep from an earlier design: no longer an answer.
			"keep-if-reachable",
		])
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

describe("who can confirm: one predicate for the prompt and the acceptance", () => {
	const login = {
		authenticated: true,
		tokenHash: "a".repeat(64),
		origin: "https://box.example",
		host: "box.example",
	};
	it("is a signed-in browser login with the UI address it used", () => {
		expect(sessionCanConfirm(login)).toBe(true);
		for (const missing of ["tokenHash", "origin", "host"] as const)
			expect(sessionCanConfirm({ ...login, [missing]: undefined })).toBe(false);
		expect(sessionCanConfirm({ ...login, authenticated: false })).toBe(false);
	});
});

describe("ask before, by what the box knows of the session's path", () => {
	const base = {
		path: "unknown" as const,
		ingress: undefined,
		devices: ["eth0"],
		seconds: 90,
		settleSeconds: 15,
		canConfirm: true,
	};
	it("offers the protected change and the deliberate keep, and nothing else", () => {
		const prompt = askBeforePrompt({
			...base,
			route: { carriers: ["eth0"], tunnel: true },
		});
		expect(prompt).toEqual({
			kind: "ask-before",
			cut: "cuts",
			via: "eth0",
			canConfirm: true,
			seconds: 90,
			settleSeconds: 15,
			messageKey: CHANGE_SAFETY_COPY.askBeforeRouteCuts,
			primary: {
				answer: "undo-automatically",
				labelKey: CHANGE_SAFETY_COPY.askBeforeUndo,
			},
			deliberate: {
				answer: "keep-change",
				labelKey: CHANGE_SAFETY_COPY.askBeforeKeepRemote,
			},
		});
	});
	it("tells a session that can't confirm that the change will be undone", () => {
		const prompt = askBeforePrompt({ ...base, canConfirm: false });
		expect(prompt.primary).toEqual({
			answer: "undo-automatically",
			labelKey: CHANGE_SAFETY_COPY.askBeforeUndoNoConfirm,
		});
		expect(prompt.canConfirm).toBe(false);
		expect(prompt.cut).toBe("unknown");
	});
	it("a session on the changed port is told it will be disconnected", () => {
		const prompt = askBeforePrompt({ ...base, path: "own", ingress: "eth0" });
		expect(prompt).toMatchObject({
			messageKey: CHANGE_SAFETY_COPY.askBeforeOwn,
			via: "eth0",
			deliberate: { labelKey: CHANGE_SAFETY_COPY.askBeforeKeep },
		});
	});
	it("a deliberate re-apply from another path is never told 'disconnect me'", () => {
		const prompt = askBeforePrompt({
			...base,
			path: "other",
			ingress: "wlan0",
		});
		expect(prompt).toMatchObject({
			canConfirm: true,
			cut: "unknown",
			primary: { answer: "undo-automatically" },
			deliberate: { labelKey: CHANGE_SAFETY_COPY.askBeforeKeepRemote },
		});
	});
	it("warns while live, and only then", () => {
		expect(askBeforePrompt({ ...base, live: true }).liveKey).toBe(
			CHANGE_SAFETY_COPY.askBeforeLive,
		);
		expect(askBeforePrompt(base)).not.toHaveProperty("liveKey");
	});
	it("maps every notice reason to its own sentence", () => {
		const keys = (
			["disconnected", "restart", "interrupted", "unsaved"] as const
		).map(noticeMessageKey);
		expect(new Set(keys).size).toBe(4);
	});
});

describe("copy for the confirm rule", () => {
	const en = JSON.parse(
		readFileSync(join(MESSAGES, "en.json"), "utf8"),
	) as Record<string, string>;
	const placeholders = (text: string) =>
		[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	it("says this browser confirms, and when the box undoes it", () => {
		const text = en[CHANGE_SAFETY_COPY.askBeforeUndo] as string;
		expect(text).toMatch(/this browser/);
		expect(placeholders(text)).toEqual(["seconds"]);
		const none = en[CHANGE_SAFETY_COPY.askBeforeUndoNoConfirm] as string;
		expect(none).toStartWith("Make the change");
		expect(none).toMatch(/can't confirm/);
	});
	it("asks to confirm here, and names where a confirmation came from", () => {
		expect(en[CHANGE_SAFETY_COPY.confirmPrompt]).toMatch(/confirm here/);
		expect(placeholders(en[CHANGE_SAFETY_COPY.confirmedVia] as string)).toEqual(
			["via"],
		);
		expect(en[CHANGE_SAFETY_COPY.confirmedRemote]).toMatch(/remote connection/);
	});
	it("never tells a remote session it will be disconnected, only that there is no undo", () => {
		const text = en[CHANGE_SAFETY_COPY.askBeforeKeepRemote] as string;
		expect(text).not.toMatch(/disconnect me/i);
		expect(text).toMatch(/no undo/);
		expect(en[CHANGE_SAFETY_COPY.noticeUnsaved]).toMatch(/confirmed/);
	});
	it("describes only what the box does", () => {
		for (const key of Object.values(CHANGE_SAFETY_COPY))
			expect(en[key], key).not.toMatch(/viewer|receiver|internet/i);
	});
});
