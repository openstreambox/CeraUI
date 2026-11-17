import { describe, expect, test } from "bun:test";
import {
	collectDynamicLogCalls,
	collectErrorTemplates,
	collectLogTemplates,
} from "../../scripts/support-log-messages.ts";
import {
	SUPPORT_ERROR_TEMPLATES,
	SUPPORT_LOG_DYNAMIC_CALLS,
	SUPPORT_LOG_TEMPLATES,
} from "../modules/system/support-log-messages.generated.ts";
import {
	MODEM_COULDNT_HEADS,
	MODEM_ERROR_PHRASES,
} from "../modules/system/support-reason-vocabulary.generated.ts";

describe("generated support vocabularies", () => {
	// A new or changed log message is withheld from support downloads until
	// the list is regenerated: `bun scripts/support-log-messages.ts --write`.
	// Parsing every backend source takes a few seconds on a loaded host.
	test("backend message templates match the source", () => {
		expect([...SUPPORT_LOG_TEMPLATES]).toEqual(collectLogTemplates());
	}, 60000);
	test("bare warn()/error() calls and literal-valued variables are collected", () => {
		const texts = SUPPORT_LOG_TEMPLATES.map((template) => template.join("…"));
		expect(texts).toContain("bluetooth: could not export the pairing agent: …");
		expect(texts).toContain("Log collection timed out.");
		expect(texts).toContain("Failed to read the system journal.");
	});
	test("logger calls whose message is not literal text are listed", () => {
		// Each listed call's messages are withheld from support downloads.
		expect([...SUPPORT_LOG_DYNAMIC_CALLS]).toEqual(collectDynamicLogCalls());
		for (const call of SUPPORT_LOG_DYNAMIC_CALLS)
			expect(call).toMatch(/^src\/[^:]+: /);
	});
	test("error texts the code throws are collected", () => {
		const texts = SUPPORT_ERROR_TEMPLATES.map((template) => template.join("…"));
		expect(texts).toContain("binary not allowlisted: …");
		expect([...SUPPORT_ERROR_TEMPLATES]).toEqual(collectErrorTemplates());
	});
	test("templates hold fixed text only", () => {
		for (const template of SUPPORT_LOG_TEMPLATES) {
			expect(template.length).toBeGreaterThan(0);
			expect(
				template.join("").replace(/[^A-Za-z]/g, "").length,
			).toBeGreaterThanOrEqual(4);
		}
	});
	test("modem vocabulary is sorted fixed text from ModemManager", () => {
		for (const list of [MODEM_ERROR_PHRASES, MODEM_COULDNT_HEADS]) {
			expect(list.length).toBeGreaterThan(10);
			expect([...list]).toEqual([...list].sort());
			for (const phrase of list) expect(phrase).not.toMatch(/[%\n]/);
		}
		for (const phrase of [
			"SIM PIN required",
			"Missing or unknown APN",
			"Serial command timed out",
		])
			expect(MODEM_ERROR_PHRASES).toContain(phrase);
		expect(MODEM_COULDNT_HEADS).toContain("connect bearer");
	});
});
