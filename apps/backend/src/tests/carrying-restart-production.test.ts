/**
 * The restart decision through production initialization and admission: the
 * module-level marker owner and session already exist (built at import), then
 * `initCarrying()` reads the boot claim, advances the generation, reads the
 * idle exit and the marker, and `tickCarrying()` takes the first counter sample
 * as `main.ts` does; `recordCarryingIdleExit()` is the termination handler's
 * first step. The files live in the test preload's scratch `/run/ceralive`.
 *
 * The scenarios share the process-wide tracker, whose startup hold can only be
 * extended, so the restart that keeps the hold runs last.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
} from "../modules/streaming/ota-streaming-marker.ts";
import { getCarryingStatus } from "../modules/system/carrying.ts";
import {
	carryingBootClaimPath,
	carryingGenerationPath,
	carryingIdleExitPath,
	initCarrying,
	recordCarryingIdleExit,
	tickCarrying,
} from "../modules/system/carrying-runtime.ts";
import { notifyDisruptiveActionRefused } from "../modules/system/disruptive-action-refusal.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import { getStreamLiveness } from "../modules/system/stream-liveness-source.ts";
import {
	isStreamReconciliationCompleted,
	setStreamReconciliationCompletedForTest,
} from "../modules/system/stream-reconciliation-latch.ts";
import * as notifications from "../modules/ui/notifications.ts";

const cleanup = () => {
	setCarryingOtaProtection(false);
	rmSync(otaStreamingMarkerPath(), { force: true });
	rmSync(carryingGenerationPath(), { force: true });
	rmSync(carryingIdleExitPath(), { force: true });
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

test("a restart after an idle clean exit admits SSH after the first sample", async () => {
	// The replaced process was generation 7 and exited idle.
	writeFileSync(carryingGenerationPath(), "7\n");
	writeFileSync(carryingIdleExitPath(), "7\n");
	setStreamReconciliationCompletedForTest(false);
	initCarrying();
	expect(getCarryingStatus().startup).toBe(false);
	expect(readFileSync(carryingGenerationPath(), "utf8")).toBe("8\n");
	// Before the first sample and the reconciliation nothing is admitted.
	expect(getDisruptiveActionDecision()).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	// main.ts: reconciliation returns, then the first carrying tick.
	setStreamReconciliationCompletedForTest(true);
	expect(isStreamReconciliationCompleted()).toBe(true);
	await tickCarrying();
	expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
	expect(existsSync(otaStreamingMarkerPath())).toBe(false);
	// Its own clean idle exit names its generation for the next start.
	expect(recordCarryingIdleExit(getStreamLiveness())).toBe(true);
	expect(readFileSync(carryingIdleExitPath(), "utf8")).toBe("8\n");
});

test("a restart after a crash keeps the hold and says the box is checking", async () => {
	// Generation 8 was killed: the idle exit still names 7.
	writeFileSync(carryingIdleExitPath(), "7\n");
	initCarrying();
	expect(readFileSync(carryingGenerationPath(), "utf8")).toBe("9\n");
	await tickCarrying();
	expect(getCarryingStatus()).toEqual({ state: "unknown", startup: true });
	expect(getDisruptiveActionDecision({ powerAction: "reboot" })).toEqual({
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
	// An exit during the hold records nothing for the next start.
	expect(recordCarryingIdleExit(getStreamLiveness())).toBe(false);
	expect(readFileSync(carryingIdleExitPath(), "utf8")).toBe("7\n");
});
