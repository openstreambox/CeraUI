import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { ensureEncoderShutdownProtection } from "../modules/system/shutdown-protection.ts";

test("production stream admission uses the shutdown owner", () => {
	expect(streamSessionProductionDeps.ensureShutdownProtection).toBe(
		ensureEncoderShutdownProtection,
	);
});
test("production boot initializes protection before readiness and watchdog", () => {
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	const production = main.slice(main.indexOf("if (!isDevelopment())"));
	expect(main).toMatch(
		/if \(!isDevelopment\(\)\) \{[^}]*\binitShutdownProtection\(\);/,
	);
	expect(production.indexOf("initShutdownProtection()")).toBeLessThan(
		production.indexOf('runCritical("systemd-ready"'),
	);
	expect(main.lastIndexOf("startServiceWatchdog()")).toBeGreaterThan(
		main.lastIndexOf('await runCritical("systemd-ready"'),
	);
});
