/**
 * The restart decision through production initialization and admission: the
 * module-level marker owner and session already exist (built at import), then
 * `initCarrying()` reads the boot claim, the idle record and the marker, and
 * `tickCarrying()` takes the first counter sample as `main.ts` does. The files
 * live in the test preload's scratch `/run/ceralive`.
 *
 * The scenarios share the process-wide tracker, whose startup hold can only be
 * extended, so the restart that keeps the hold runs last.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
} from "../modules/streaming/ota-streaming-marker.ts";
import { getCarryingStatus } from "../modules/system/carrying.ts";
import {
	carryingBootClaimPath,
	carryingIdleRecordPath,
	initCarrying,
	tickCarrying,
} from "../modules/system/carrying-runtime.ts";
import { notifyDisruptiveActionRefused } from "../modules/system/disruptive-action-refusal.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	isStreamReconciliationCompleted,
	setStreamReconciliationCompletedForTest,
} from "../modules/system/stream-reconciliation-latch.ts";
import * as notifications from "../modules/ui/notifications.ts";

const cleanup = () => {
	setCarryingOtaProtection(false);
	rmSync(otaStreamingMarkerPath(), { force: true });
	rmSync(carryingIdleRecordPath(), { force: true });
};
beforeAll(() => {
	cleanup();
	// Same boot, an earlier process already started.
	writeFileSync(carryingBootClaimPath(), "");
});
afterAll(() => {
	cleanup();
	rmSync(carryingBootClaimPath(), { force: true });
	setStreamReconciliationCompletedForTest(true);
});

test("a restart after a recorded idle predecessor admits SSH after the first sample", async () => {
	// The predecessor published confirmed idle: record present, no marker.
	writeFileSync(carryingIdleRecordPath(), "");
	setStreamReconciliationCompletedForTest(false);
	initCarrying();
	expect(getCarryingStatus().startup).toBe(false);
	// Until the first sample the record is withdrawn: this process is unknown.
	expect(existsSync(carryingIdleRecordPath())).toBe(false);
	expect(getDisruptiveActionDecision()).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	// main.ts: reconciliation returns, then the first carrying tick.
	setStreamReconciliationCompletedForTest(true);
	expect(isStreamReconciliationCompleted()).toBe(true);
	await tickCarrying();
	expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
	// Confirmed idle again: the next restart finds the record.
	expect(existsSync(carryingIdleRecordPath())).toBe(true);
	expect(existsSync(otaStreamingMarkerPath())).toBe(false);
});

test("a restart without the record keeps the hold and says the box is checking", async () => {
	// The predecessor's publication failed or it crashed mid-way: no record.
	rmSync(carryingIdleRecordPath(), { force: true });
	initCarrying();
	await tickCarrying();
	expect(getCarryingStatus()).toEqual({ state: "unknown", startup: true });
	const decision = getDisruptiveActionDecision({ powerAction: "reboot" });
	expect(decision).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	const broadcast = spyOn(notifications, "notificationBroadcast");
	try {
		notifyDisruptiveActionRefused("stream_liveness_unknown");
		const refusal = broadcast.mock.calls.find(
			([name]) => name === "disruptive_action_refused",
		);
		expect(refusal?.[7]).toBe("notifications.disruptiveActionCarryingChecking");
	} finally {
		broadcast.mockRestore();
	}
	expect(existsSync(carryingIdleRecordPath())).toBe(false);
});
