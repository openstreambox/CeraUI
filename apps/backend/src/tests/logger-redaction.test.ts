import { describe, expect, test } from "bun:test";
import { logger, logRedact, REDACTED } from "../helpers/logger.ts";

describe("logger redaction", () => {
	test("redacts pin, token, and nested password keys", () => {
		const out = logRedact({
			pin: "1234",
			token: "v4.public.abc",
			nested: { password: "x" },
		}) as { pin: string; token: string; nested: { password: string } };

		expect(out.pin).toBe(REDACTED);
		expect(out.token).toBe(REDACTED);
		expect(out.nested.password).toBe(REDACTED);
	});

	test("redacts every sensitive key variant", () => {
		const out = logRedact({
			simPin: "9999",
			auth_token: "abc",
			bcrp_key: "mock-bcrp-key-12345",
			device_secret: "s",
			pasetoKey: "k",
		}) as Record<string, string>;

		for (const value of Object.values(out)) {
			expect(value).toBe(REDACTED);
		}
	});

	test("redacts secret-shaped VALUES under innocent keys", () => {
		const out = logRedact({
			note: "v4.public.aGVsbG8",
			header: "Bearer abc123XYZ.token",
			jwt: "eyJhbGci.eyJzdWIi.sigPart",
		}) as Record<string, string>;

		expect(out.note).toBe(REDACTED);
		expect(out.header).toBe(REDACTED);
		expect(out.jwt).toBe(REDACTED);
	});

	test("non-sensitive keys and values pass through unchanged", () => {
		const input = {
			host: "relay-eu-west.example.com",
			port: 2001,
			enabled: true,
			version: "2026.6.1",
			tags: ["alpha", "beta"],
		};

		expect(logRedact(input)).toEqual(input);
	});

	test("redacts inside arrays of objects and string entries", () => {
		const out = logRedact({
			items: [{ secret: "s" }, "v4.public.zzz", "plain"],
		}) as { items: [{ secret: string }, string, string] };

		expect(out.items[0].secret).toBe(REDACTED);
		expect(out.items[1]).toBe(REDACTED);
		expect(out.items[2]).toBe("plain");
	});

	test("leaves Error instances intact for structured-error logging", () => {
		const err = new Error("boom");
		const out = logRedact({ err }) as { err: Error };

		expect(out.err).toBe(err);
		expect(out.err.message).toBe("boom");
	});

	test("redacts decoded Wi-Fi QR text under any key and in messages", () => {
		const qr = String.raw`WIFI:T:WPA;S:Venue;P:sample\;only;;`;
		const out = logRedact({
			qr,
			input: { note: `scanned ${qr}` },
			lower: "wifi:s:Venue;p:sample-only;;",
		}) as Record<string, unknown>;

		expect(JSON.stringify(out)).not.toContain("sample");
		expect(logRedact("WIFI: scan finished")).toBe("WIFI: scan finished");
		expect(logRedact("wifi: 2 networks")).toBe("wifi: 2 networks");
	});

	test("logger still accepts redacted metadata without throwing", () => {
		expect(() => {
			logger.error("login failed", logRedact({ token: "v4.public.abc" }));
		}).not.toThrow();
	});
});
