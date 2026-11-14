import { expect, test } from "bun:test";
import {
	ensureEncoderShutdownProtection,
	initShutdownProtection,
	setShutdownProtection,
} from "../modules/system/shutdown-protection.ts";

test("retained startup owner survives slow logind and reacquires on retry", () => {
	setShutdownProtection("encoder", true);
	setShutdownProtection("carrying", true);
	let attempts = 0;
	let released = 0;
	expect(() =>
		initShutdownProtection(() => {
			if (++attempts <= 2) throw Error("logind starting");
			return () => {
				released++;
			};
		}),
	).not.toThrow();
	expect(setShutdownProtection("encoder", true)).toBe(true);
	setShutdownProtection("encoder", false);
	expect(released).toBe(0);
	setShutdownProtection("carrying", false);
	expect(released).toBe(1);
	expect(ensureEncoderShutdownProtection()).toBe(true);
	setShutdownProtection("encoder", false);
	expect(released).toBe(2);
});
