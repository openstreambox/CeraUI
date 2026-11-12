import { expect, test } from "bun:test";
import { probeSourceBoundHttps } from "./source-bound-https.ts";

test("invalid or cancelled HTTPS paths create no connection", async () => {
	await expect(
		probeSourceBoundHttps({ device: "--interface", source: "192.0.2.2" }),
	).rejects.toThrow("identity");
	await expect(
		probeSourceBoundHttps({ device: "wwan0", source: "example.invalid" }),
	).rejects.toThrow("identity");
	expect(
		await probeSourceBoundHttps({
			device: "wwan0",
			source: "192.0.2.2",
			signal: AbortSignal.abort(),
		}),
	).toBe("unavailable");
});
