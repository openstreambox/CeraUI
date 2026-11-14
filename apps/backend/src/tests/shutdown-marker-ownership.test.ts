import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import {
	clearOtaStreamingMarker,
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
	setOtaStreamingMarker,
} from "../modules/streaming/ota-streaming-marker.ts";
import { initShutdownProtection } from "../modules/system/shutdown-protection.ts";

let held = false;
let acquisitions = 0;
let unavailable = false;
initShutdownProtection(() => {
	if (unavailable) throw Error("logind unavailable");
	acquisitions++;
	held = true;
	return () => {
		held = false;
	};
});
test("production marker owners share one inhibitor", () => {
	expect(setOtaStreamingMarker()).toBe(true);
	expect(held).toBe(true);
	setCarryingOtaProtection(true);
	clearOtaStreamingMarker();
	expect(held).toBe(true);
	setCarryingOtaProtection(false);
	expect(held).toBe(false);
});
test("inhibitor failure preserves the independent activation marker", () => {
	unavailable = true;
	try {
		expect(setCarryingOtaProtection(true)).toBe(false);
		expect(existsSync(otaStreamingMarkerPath())).toBe(true);
	} finally {
		unavailable = false;
		setCarryingOtaProtection(false);
	}
});
test("failed idle cleanup retains shutdown protection until cleanup succeeds", () => {
	setOtaStreamingMarker();
	const path = otaStreamingMarkerPath();
	rmSync(path);
	mkdirSync(path);
	try {
		expect(clearOtaStreamingMarker()).toBe(false);
		expect(held).toBe(true);
	} finally {
		rmSync(path, { recursive: true });
	}
	expect(clearOtaStreamingMarker()).toBe(true);
	expect(held).toBe(false);
});

test("carrying cleanup never drops and reacquires the lock on a failed unlink", () => {
	setCarryingOtaProtection(true);
	const before = acquisitions;
	const path = otaStreamingMarkerPath();
	rmSync(path);
	mkdirSync(path);
	try {
		expect(setCarryingOtaProtection(false)).toBe(false);
		expect(held).toBe(true);
		expect(acquisitions).toBe(before);
	} finally {
		rmSync(path, { recursive: true });
	}
	expect(setCarryingOtaProtection(false)).toBe(true);
	expect(held).toBe(false);
});
