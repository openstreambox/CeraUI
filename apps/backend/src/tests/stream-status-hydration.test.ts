import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StatusEvent, statusEventSchema } from "@ceralive/cerastream";
import {
	clearOtaStreamingMarker,
	setCarryingOtaProtection,
} from "../modules/streaming/ota-streaming-marker.ts";
import { initShutdownProtection } from "../modules/system/shutdown-protection.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let marker = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
let held = false;
initShutdownProtection(() => {
	held = true;
	return () => {
		held = false;
	};
});
const status = (
	state: StatusEvent["state"],
	streaming = false,
	seq = 1,
): StatusEvent =>
	statusEventSchema.parse({ type: "status", state, streaming, seq });
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "stream-hydration-"));
	marker = join(directory, "streaming");
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = marker;
	writeFileSync(marker, ""); // inherited from a previous backend process
});
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	setCarryingOtaProtection(false);
	clearOtaStreamingMarker();
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});
function boot(...events: StatusEvent[]) {
	const harness = idleProductionHarness(directory);
	h = harness;
	harness.engine.hydrate(...events);
	setCarryingOtaProtection(true);
	return harness;
}
test("hydrated idle clears inherited encoder protection without Stop; carrying still owns its hold", async () => {
	const h = boot(status("idle"));
	expect(await h.session.reconcile()).toBe("idle");
	expect(h.session.streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(true);
	expect(held).toBe(true);
	setCarryingOtaProtection(false);
	expect(existsSync(marker)).toBe(false);
	expect(held).toBe(false);
	expect(h.calls()).not.toContain("stop");
});
test("hydrated surviving stream is adopted and remains protected after carrying ends", async () => {
	const h = boot(status("streaming", true));
	h.engine.setEngine("streaming");
	expect(await h.session.reconcile()).toBe("streaming");
	setCarryingOtaProtection(false);
	expect(h.session.streamLiveness()).toBe("streaming");
	expect(existsSync(marker)).toBe(true);
	expect(held).toBe(true);
	expect(h.calls()).not.toContain("stop");
	h.engine.status(0, false);
	await flushEvidence();
	expect(existsSync(marker)).toBe(false);
});
for (const state of ["starting", "stopping"] as const) {
	test(`idle hydration followed by ${state} cannot release inherited protection`, async () => {
		const h = boot(status("idle"), status(state, false, 2));
		expect(await h.session.reconcile()).toBe("reconciling");
		setCarryingOtaProtection(false);
		expect(h.session.streamLiveness()).toBe("unknown");
		expect(existsSync(marker)).toBe(true);
		expect(held).toBe(true);
	});
}
test("failed subscription cannot publish an idle hydration or release guards", async () => {
	const h = boot(status("idle"));
	const gate = Promise.withResolvers<void>();
	h.engine.holdSubscribe(gate.promise);
	const observing = h.session.reconcile();
	await flushEvidence();
	expect(h.session.snapshot().state).toBe("reconciling");
	expect(existsSync(marker)).toBe(true);
	gate.reject(new Error("subscription failed"));
	expect(await observing).toBe("reconciling");
	setCarryingOtaProtection(false);
	expect(existsSync(marker)).toBe(true);
	expect(held).toBe(true);
});
test("older silent engines remain unknown without a Stop or polling", async () => {
	const h = boot();
	const observing = h.session.reconcile();
	await h.expireProbe();
	expect(await observing).toBe("reconciling");
	setCarryingOtaProtection(false);
	expect(existsSync(marker)).toBe(true);
	expect(held).toBe(true);
	expect(h.calls()).toEqual(["subscribe", "unsubscribe", "close"]);
});

test("a stream starting after the idle snapshot stays protected on restart", async () => {
	const h = boot(status("idle"), status("streaming", true, 2));
	h.engine.setEngine("streaming");
	expect(await h.session.reconcile()).toBe("streaming");
	setCarryingOtaProtection(false);
	expect(existsSync(marker)).toBe(true);
	expect(held).toBe(true);
	expect(h.session.streamLiveness()).toBe("streaming");
	expect(h.calls()).not.toContain("stop");
});

test("contradictory hydration remains unknown", async () => {
	const h = boot(status("idle", true));
	expect(await h.session.reconcile()).toBe("reconciling");
	setCarryingOtaProtection(false);
	expect(existsSync(marker)).toBe(true);
	expect(held).toBe(true);
});
