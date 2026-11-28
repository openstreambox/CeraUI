import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { setup } from "../modules/setup.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { carryingTracker } from "../modules/system/carrying.ts";
import { notifyDisruptiveActionRefused } from "../modules/system/disruptive-action-refusal.ts";
import type { DisruptiveRefusalReason } from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	getOwnStreamState,
	getStreamLiveness,
	setStreamLivenessSourceForTest,
} from "../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";

const SOURCE = "refusal-copy-test";
const savedEngine = setup.engine;

beforeEach(() => {
	resetOrchestratorRuntimeForTest();
	setup.engine = "ceracoder";
	setStreamReconciliationCompletedForTest(true);
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	carryingTracker.session(SOURCE, false, performance.now());
	setStreamLivenessSourceForTest(null);
	setStreamReconciliationCompletedForTest(true);
	setup.engine = savedEngine;
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});

function refusal(reason: DisruptiveRefusalReason): {
	readonly key: unknown;
	readonly text: unknown;
	readonly authedOnly: unknown;
} {
	const broadcast = spyOn(notifications, "notificationBroadcast");
	try {
		notifyDisruptiveActionRefused(reason);
		const call = broadcast.mock.calls.find(
			([name]) => name === "disruptive_action_refused",
		);
		return { key: call?.[7], text: call?.[2], authedOnly: call?.[6] };
	} finally {
		broadcast.mockRestore();
	}
}

test("unknown client traffic beside an idle own stream says to wait, without Stop", () => {
	// Given the box's own session idle and one client session unreadable.
	carryingTracker.session(SOURCE, null, performance.now());
	expect(getOwnStreamState()).toBe("idle");
	expect(getStreamLiveness()).toBe("unknown");
	// When the unknown refusal is announced.
	const notice = refusal("stream_liveness_unknown");
	// Then it names the client check, offers no Stop and reaches signed-in clients only.
	expect(notice.key).toBe("notifications.disruptiveActionCarryingChecking");
	expect(notice.text).toContain("still checking");
	expect(notice.text).not.toContain("Stop Stream");
	expect(notice.authedOnly).toBe(true);
});

test("an unconfirmed own stream offers Stop Stream", () => {
	// Given the box's own lifecycle still starting, so its stop is unconfirmed.
	updateStreamLifecycleState("starting");
	expect(getOwnStreamState()).toBe("unconfirmed");
	const notice = refusal("stream_liveness_unknown");
	expect(notice.key).toBe("notifications.disruptiveActionStreamUnconfirmed");
	expect(notice.text).toContain("Stop Stream");
	expect(notice.authedOnly).toBe(true);
});

test("only the startup reconciliation open: retry, without Stop", () => {
	// Given an otherwise idle own session before reconciliation returns.
	setStreamReconciliationCompletedForTest(false);
	expect(getOwnStreamState()).toBe("reconciling");
	expect(getDisruptiveActionDecision()).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	const notice = refusal("stream_liveness_unknown");
	// Then Stop would not help, so the notice only says to try again.
	expect(notice.key).toBe("notifications.disruptiveActionStillChecking");
	expect(notice.text).toContain("Try again in a moment");
	expect(notice.text).not.toContain("Stop Stream");
});

test("phone-only power-off refused on own-session uncertainty offers no Stop", () => {
	// Given a box without an encoder (no Live page, so no Stop Stream), with an
	// own session that is not yet confirmed.
	setup.engine = "none";
	updateStreamLifecycleState("starting");
	expect(getOwnStreamState()).toBe("unconfirmed");
	expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	const notice = refusal("stream_liveness_unknown");
	expect(notice.key).toBe("notifications.disruptiveActionStillChecking");
	expect(notice.text).not.toContain("Stop Stream");
});

test("phone-only power-off refused while reconciliation is open says to retry", () => {
	setup.engine = "none";
	setStreamReconciliationCompletedForTest(false);
	expect(getDisruptiveActionDecision({ powerAction: "poweroff" })).toEqual({
		allowed: false,
		reason: "stream_liveness_unknown",
	});
	expect(refusal("stream_liveness_unknown").key).toBe(
		"notifications.disruptiveActionStillChecking",
	);
});

test("streaming and non-pending update refusals keep the existing copy and audience", () => {
	for (const reason of ["streaming", "update_in_progress"] as const) {
		const notice = refusal(reason);
		expect(notice.key).toBe("notifications.disruptiveActionClientTraffic");
		expect(notice.authedOnly).toBe(false);
	}
});

test("choosing the copy leaves the admission decision unchanged", () => {
	// Given a refusal on unknown client traffic.
	carryingTracker.session(SOURCE, null, performance.now());
	const before = getDisruptiveActionDecision();
	expect(before).toEqual({ allowed: false, reason: "stream_liveness_unknown" });
	// When the notice reads the own-session part.
	refusal("stream_liveness_unknown");
	// Then admission still answers the same, and still refuses.
	expect(getDisruptiveActionDecision()).toEqual(before);
	expect(getStreamLiveness()).toBe("unknown");
});
