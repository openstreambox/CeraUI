import { expect, test } from "bun:test";
import {
	ensureEncoderShutdownProtection,
	initShutdownProtection,
	setShutdownProtection,
} from "../modules/system/shutdown-protection.ts";

test("failed fresh admission leaves idle unowned but preserves an already retained encoder", () => {
	let attempts = 0;
	initShutdownProtection(() => {
		attempts++;
		throw Error("logind unavailable");
	});
	expect(ensureEncoderShutdownProtection()).toBe(false);
	expect(attempts).toBe(1);
	expect(setShutdownProtection("carrying", false)).toBe(true);
	expect(attempts).toBe(1);
	expect(setShutdownProtection("encoder", true)).toBe(false);
	expect(ensureEncoderShutdownProtection()).toBe(false);
	expect(setShutdownProtection("carrying", false)).toBe(false);
	expect(attempts).toBe(4);
});
