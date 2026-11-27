import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { carryingTracker } from "../modules/system/carrying.ts";
import { notifyDisruptiveActionRefused } from "../modules/system/disruptive-action-refusal.ts";
import type { DisruptiveRefusalReason } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	getOwnStreamLiveness,
	getStreamLiveness,
	setStreamLivenessSourceForTest,
} from "../modules/system/stream-liveness-source.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";

const SOURCE = "refusal-copy-test";

beforeEach(() => {
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	carryingTracker.session(SOURCE, false, performance.now());
	setStreamLivenessSourceForTest(null);
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});

function refusalKey(reason: DisruptiveRefusalReason): {
	readonly key: unknown;
	readonly text: unknown;
} {
	const broadcast = spyOn(notifications, "notificationBroadcast");
	try {
		notifyDisruptiveActionRefused(reason);
		const call = broadcast.mock.calls.find(
			([name]) => name === "disruptive_action_refused",
		);
		return { key: call?.[7], text: call?.[2] };
	} finally {
		broadcast.mockRestore();
	}
}

test("unknown client traffic beside an idle own stream says to wait, without Stop", () => {
	// Given the box's own session idle and one client session unreadable.
	carryingTracker.session(SOURCE, null, performance.now());
	expect(getOwnStreamLiveness()).toBe("idle");
	expect(getStreamLiveness()).toBe("unknown");
	// When the unknown refusal is announced.
	const refusal = refusalKey("stream_liveness_unknown");
	// Then it names the client check and offers no Stop.
	expect(refusal.key).toBe("notifications.disruptiveActionCarryingChecking");
	expect(refusal.text).toContain("still checking");
	expect(refusal.text).not.toContain("Stop Stream");
});

test("an unconfirmed own stream offers Stop Stream", () => {
	// Given the box's own lifecycle still starting, so its stop is unconfirmed.
	updateStreamLifecycleState("starting");
	expect(getOwnStreamLiveness()).toBe("unknown");
	const refusal = refusalKey("stream_liveness_unknown");
	expect(refusal.key).toBe("notifications.disruptiveActionStreamUnconfirmed");
	expect(refusal.text).toContain("Stop Stream");
});

test("streaming and non-pending update refusals keep the existing copy", () => {
	for (const reason of ["streaming", "update_in_progress"] as const) {
		expect(refusalKey(reason).key).toBe(
			"notifications.disruptiveActionClientTraffic",
		);
	}
});

test("choosing the copy leaves the admission decision unchanged", () => {
	// Given a refusal on unknown client traffic.
	carryingTracker.session(SOURCE, null, performance.now());
	const before = getDisruptiveActionDecision();
	expect(before).toEqual({ allowed: false, reason: "stream_liveness_unknown" });
	// When the notice reads the own-session part.
	refusalKey("stream_liveness_unknown");
	// Then admission still answers the same, and still refuses.
	expect(getDisruptiveActionDecision()).toEqual(before);
	expect(getStreamLiveness()).toBe("unknown");
});
