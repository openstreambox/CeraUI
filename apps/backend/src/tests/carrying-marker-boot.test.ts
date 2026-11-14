import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
} from "../modules/streaming/ota-streaming-marker.ts";

test("an engine-less clean boot releases its carrying-only marker after confirmed idle", () => {
	expect(existsSync(otaStreamingMarkerPath())).toBe(false);
	setCarryingOtaProtection(true);
	expect(existsSync(otaStreamingMarkerPath())).toBe(true);
	setCarryingOtaProtection(false);
	expect(existsSync(otaStreamingMarkerPath())).toBe(false);
});

test("an uninitialized development carrying sampler leaves the host marker alone", async () => {
	const { tickCarrying } = await import(
		"../modules/system/carrying-runtime.ts"
	);
	await tickCarrying();
	expect(existsSync(otaStreamingMarkerPath())).toBe(false);
});
