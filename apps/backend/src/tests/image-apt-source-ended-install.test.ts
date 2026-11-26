/// <reference types="bun" />

/**
 * Single moments of an install on an image with its own apt source, each at
 * the one wait where it matters. The fixture is the one of the interleaving
 * and sequence tests (helpers/image-apt-install-harness.ts): the real code
 * over fakes at the spawn primitives and the owned files.
 */

import { describe, expect, it } from "bun:test";
import * as gateways from "../modules/network/gateways.ts";
import { setup } from "../modules/setup.ts";
import { setImageClockGateFlagForTest } from "../modules/system/image-apt-source.ts";
import {
	getUpdateState,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { PACKAGE_INSTALL_REFUSED } from "../modules/system/update-orchestrator/types.ts";
import { settleMicrotasks } from "./helpers/await-sequencer.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	acceptedInstall,
	atEveryWait,
	DOWNLOAD,
	expectEndedBeforeLaunch,
	expectNoStaleEffect,
	expectOfferAtNextCheck,
	failedFrames,
	installDraining,
	REFRESH_COMMAND,
	ROUTE_WRITE,
	recordWaits,
	SPOOL,
	SUBMIT,
	TIMEOUT_MS,
	useInstallHarness,
	type Variant,
} from "./helpers/image-apt-install-harness.ts";

useSessionOwnerForFile();
useInstallHarness();

const STREAMING = { kind: "failed", reason: "streaming" } as const;
const TOKEN = "k7Qm2xV9pL4sT8wZ";

/** The install standing at the first `label` among its waits. */
async function standingAt(variant: Variant, label: string) {
	const steps = await recordWaits(variant);
	const at = steps.indexOf(label);
	expect(at).toBeGreaterThanOrEqual(0);
	const box = await acceptedInstall(variant);
	await box.sequencer.advance(at);
	expect(box.sequencer.next()).toBe(label);
	return { box, steps, at };
}

const admitStream = (box: Awaited<ReturnType<typeof acceptedInstall>>) =>
	box.sequencer.outside(() => admitAndPrepareStreamStart());

describe("the download under the pin fails", () => {
	it(
		"is settled with apt's error before the routing is taken down, and a stream admitted meanwhile changes nothing",
		async () => {
			const { box } = await standingAt("pinned", DOWNLOAD);
			const { sequencer, frames } = box;
			// apt exits 100.
			sequencer.step("fail");
			await settleMicrotasks();
			// The rule is being removed, and the failure is on the wire already.
			expect(sequencer.next()).toBe(
				"ip rule del priority 120 uidrange 42042-42042 lookup 100000",
			);
			const wire = getUpdateState();
			expect(wire).toMatchObject({ kind: "failed", reason: "E: failed" });
			const id = wire.kind === "failed" ? wire.failure_id : undefined;
			expect(id).toBeString();
			expect(failedFrames(frames)).toEqual([
				{ kind: "failed", reason: "E: failed" },
			]);
			// A stream is admitted while the deletion is in flight.
			expect(await admitStream(box)).toEqual({ allowed: true });
			expect(getUpdateState()).toEqual(wire);
			const mark = box.mark();
			// The teardown finishes; nothing else happens, nothing is logged.
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			expect(installDraining()).toBe(false);
			expect(getUpdateState()).toEqual(wire);
			expect(failedFrames(frames)).toEqual([
				{ kind: "failed", reason: "E: failed" },
			]);
			// The orchestrator recorded apt's failure, by its id, once.
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: PACKAGE_INSTALL_REFUSED,
			});
			expect(
				box.emitted.filter(({ code }) => code === "update_failed"),
			).toEqual([
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
				},
			]);
			expect(box.unit.unit.submissions).toBe(0);
			expect(box.unit.unit.stops).toBe(0);
			// The rule and routes are gone: the next check can pin again.
			await expectOfferAtNextCheck(box);
		},
		TIMEOUT_MS,
	);
});

describe("updates are turned off while a pinned run sets up", () => {
	it(
		"during the routing journal read: no rule is added and apt-get update never runs",
		async () => {
			const { box, steps, at } = await standingAt(
				"pinned",
				"routing journal: read",
			);
			// This is the install's own refresh, about to pin.
			expect(steps.indexOf(REFRESH_COMMAND)).toBeGreaterThan(at);
			const { sequencer } = box;
			setup.apt_update_enabled = false;
			const mark = box.mark();
			await sequencer.drain(() => {
				expect(box.effectsSince(mark)).toEqual([]);
			});
			// Not a rule, not a route, not a look at them, and no refresh.
			const since = sequencer
				.calls()
				.slice(mark.calls)
				.map(({ label }) => label);
			expect(since.filter((label) => label.startsWith("ip "))).toEqual([]);
			expect(since).not.toContain(REFRESH_COMMAND);
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "discovery_failed",
			});
			await sequencer.outside(() => runOrchestratorTick());
			await expectEndedBeforeLaunch(box, "discovery_failed", false);
		},
		TIMEOUT_MS,
	);
});

describe("a launch cancelled after the download under the pin", () => {
	it(
		"logs none of what apt fetched, at any wait from there to systemd-run",
		async () => {
			const steps = await recordWaits("pinned");
			const downloaded = steps.indexOf(DOWNLOAD);
			expect(steps.indexOf(SPOOL)).toBeGreaterThan(downloaded);
			const runs = await atEveryWait(
				steps,
				async (step) => {
					const box = await acceptedInstall("pinned");
					await box.sequencer.advance(step);
					const mark = box.mark();
					expect(await admitStream(box)).toEqual({ allowed: true });
					expect(getUpdateState()).toMatchObject(STREAMING);
					await box.sequencer.drain();
					// The install itself says nothing more, and nobody logs the
					// output of a download that led to no install.
					expect(box.logsSince(mark)).toEqual([]);
					const lines = box.everyLogSince(mark).join("\n");
					expect(lines).not.toContain("Fetched");
					expect(lines).not.toContain("Get:1");
					expect(lines).not.toContain(TOKEN);
					expect(box.unit.unit.submissions).toBe(0);
				},
				(label, step) => step > downloaded && label !== SUBMIT,
			);
			expect(runs).toBe(steps.length - downloaded - 2);
		},
		TIMEOUT_MS,
	);
});

describe("a retry that is refused", () => {
	it.each(["start RPC from the Packages card", "orchestrated"] as const)(
		"%s: with the clock gate shut it leaves the ended install's outcome showing, not the old offer",
		async (variant) => {
			const { box } = await standingAt(variant, REFRESH_COMMAND);
			const { sequencer } = box;
			expect(await admitStream(box)).toEqual({ allowed: true });
			await sequencer.drain();
			expect(getUpdateState()).toMatchObject(STREAMING);
			// The clock gate closes; the install is asked for again.
			setImageClockGateFlagForTest(`${box.flag}.gone`);
			const before = box.observe();
			const retry =
				variant === "orchestrated"
					? await sequencer.outside(() =>
							installUpdatesNow({ scope: "packages" }),
						)
					: sequencer.outside(() => startSoftwareUpdate());
			expect(retry.started).toBe(false);
			// What happened last is still what shows: the install a stream
			// ended. The offer does not come back by itself.
			expect(getUpdateState()).toMatchObject(STREAMING);
			expect(box.observe().wire).toEqual(before.wire);
			expect(box.observe().frames).toBe(before.frames);
			expect(box.unit.unit.submissions).toBe(0);
			setImageClockGateFlagForTest(box.flag);
			await expectOfferAtNextCheck(box);
		},
		TIMEOUT_MS,
	);
});

describe("the host's gateway election, asked for by an install", () => {
	const ELECTION = "election: resolve";
	const PROBE = "election: probe the repositories on uplink-b";

	it(
		"while the install lives, the election writes the route it asked for",
		async () => {
			const { box } = await standingAt("route repair", ROUTE_WRITE);
			expect(box.routeWrites).toEqual(["uplink-b/4"]);
		},
		TIMEOUT_MS,
	);

	it(
		"a stream ends the install during the election: it runs on for the host and writes no route",
		async () => {
			const { box } = await standingAt("route repair", ELECTION);
			const { sequencer } = box;
			expect(await admitStream(box)).toEqual({ allowed: true });
			expect(getUpdateState()).toMatchObject(STREAMING);
			const mark = box.mark();
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			// The election went on (its probes were made) and left the route.
			expect(
				sequencer
					.calls()
					.slice(mark.calls)
					.map(({ label }) => label),
			).toContain(PROBE);
			expect(box.routeWrites).toEqual([]);
			expect(box.logsSince(mark)).toEqual([]);
			// The host's next pass, which asks for nobody, writes the route.
			sequencer.disarm();
			expect(
				await sequencer.outside(() => gateways.updateGwWrapper(true)),
			).toBe(true);
			expect(box.routeWrites).toEqual(["uplink-b/4"]);
			await expectEndedBeforeLaunch(box, "streaming", false);
		},
		TIMEOUT_MS,
	);

	it(
		"the network module joins the same election: its route is written, and the install stays ended",
		async () => {
			const { box } = await standingAt("route repair", ELECTION);
			const { sequencer } = box;
			expect(await admitStream(box)).toEqual({ allowed: true });
			// The host's own pass asks for nobody in particular.
			const joined = sequencer.outside(() => gateways.updateGwWrapper(true));
			const mark = box.mark();
			await sequencer.drain();
			expect(await joined).toBe(true);
			expect(box.routeWrites).toEqual(["uplink-b/4"]);
			// The install did nothing with it: no probe, no apt run, no word.
			expect(box.callsSince(mark)).toEqual([]);
			expect(box.logsSince(mark)).toEqual([]);
			expect(getUpdateState()).toMatchObject(STREAMING);
			expect(failedFrames(box.frames)).toEqual([STREAMING]);
			expect(box.unit.unit.submissions).toBe(0);
		},
		TIMEOUT_MS,
	);
});
