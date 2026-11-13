import { describe, expect, test } from "bun:test";
import { collectLogTemplates } from "../../scripts/support-log-messages.ts";
import { SUPPORT_LOG_TEMPLATES } from "../modules/system/support-log-messages.generated.ts";
import {
	MODEM_COULDNT_HEADS,
	MODEM_ERROR_PHRASES,
} from "../modules/system/support-reason-vocabulary.generated.ts";

describe("generated support vocabularies", () => {
	// A new or changed log message is withheld from support downloads until
	// the list is regenerated: `bun scripts/support-log-messages.ts --write`.
	test("backend message templates match the source", () => {
		expect([...SUPPORT_LOG_TEMPLATES]).toEqual(collectLogTemplates());
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
