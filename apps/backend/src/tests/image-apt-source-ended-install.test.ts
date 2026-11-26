/// <reference types="bun" />

/**
 * Single moments of an install on an image with its own apt source, each at
 * the one wait where it matters. The fixture is the one of the interleaving
 * and sequence tests (helpers/image-apt-install-harness.ts): the real code
 * over fakes at the spawn primitives and the owned files.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { setup } from "../modules/setup.ts";
import {
	PRIVATE_CURL_DIRECTORY,
	PRIVATE_FILE_LEFT_BEHIND,
	wipePrivateCurlConfigs,
} from "../modules/system/curl-private-url.ts";
import { setImageClockGateFlagForTest } from "../modules/system/image-apt-source.ts";
import {
	getUpdateState,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { PACKAGE_INSTALL_REFUSED } from "../modules/system/update-orchestrator/types.ts";
import {
	settleEventLoop,
	settleMicrotasks,
} from "./helpers/await-sequencer.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	acceptedInstall,
	atEveryWait,
	CONFIG_DIRECTORY,
	CONFIG_REMOVAL,
	DOWNLOAD,
	expectEndedBeforeLaunch,
	expectLaunched,
	expectNoStaleEffect,
	expectOfferAtNextCheck,
	FRAGMENT,
	failedFrames,
	installDraining,
	REFRESH_COMMAND,
	REINSPECT,
	recordWaits,
	SPOOL,
	SUBMIT,
	TIMEOUT_MS,
	teardownInstall,
	useInstallHarness,
	type Variant,
} from "./helpers/image-apt-install-harness.ts";

useSessionOwnerForFile();
useInstallHarness();

const STREAMING = { kind: "failed", reason: "streaming" } as const;
const TOKEN = "k7Qm2xV9pL4sT8wZb3Nc";

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

describe("the scheduled retry and an install that still drains", () => {
	it(
		"waits: no check is dispatched behind the drain, and the due image check runs",
		async () => {
			const { box } = await standingAt("orchestrated", REFRESH_COMMAND);
			const { sequencer, counts } = box;
			// A stream ends the install; its refresh is still out.
			expect(await admitStream(box)).toEqual({ allowed: true });
			expect(installDraining()).toBe(true);
			// The tick comes: the retry is due at once, and so is an image check.
			setOrchestratorStateForTest({
				...getOrchestratorState(),
				osCheck: { ...getOrchestratorState().osCheck, nextAttemptAt: 0 },
			});
			const before = getOrchestratorState().packageCheck;
			const os = counts.osChecks;
			const said = box.emitted.length;
			let returned = false;
			const tick = sequencer
				.outside(() => runOrchestratorTick())
				.finally(() => {
					returned = true;
				});
			await settleEventLoop(10);
			// It did not wait for the drain: it deferred the package check and
			// ran the image check.
			expect(returned).toBe(true);
			await tick;
			expect(installDraining()).toBe(true);
			expect(getOrchestratorState().phase).not.toBe("checking");
			expect(getOrchestratorState().packageCheck).toEqual(before);
			expect(counts.osChecks).toBe(os + 1);
			expect(
				box.emitted.slice(said).filter(({ code }) => code === "update_refused"),
			).toEqual([]);
			// Drained, the next tick runs the retry and finds the offer.
			await sequencer.drain();
			expect(installDraining()).toBe(false);
			sequencer.disarm();
			await sequencer.outside(() => runOrchestratorTick());
			expect(getUpdateState().kind).toBe("available");
			expect(getOrchestratorState()).toMatchObject({
				phase: "available",
				packageCheck: { consecutiveFailures: 0 },
			});
		},
		TIMEOUT_MS,
	);
});

describe("updates are turned off during the install's refresh", () => {
	it(
		"and the refresh then fails: the install ends as turned off, not as a failed refresh",
		async () => {
			const { box } = await standingAt("orchestrated", REFRESH_COMMAND);
			const { sequencer } = box;
			setup.apt_update_enabled = false;
			sequencer.step("fail");
			await sequencer.drain();
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "discovery_failed",
			});
			expect(failedFrames(box.frames)).toEqual([
				{ kind: "failed", reason: "discovery_failed" },
			]);
			await sequencer.outside(() => runOrchestratorTick());
			await expectEndedBeforeLaunch(box, "discovery_failed", false);
		},
		TIMEOUT_MS,
	);
});

describe("the Packages card rechecks before the orchestrator has looked", () => {
	it(
		"the refused install still reaches the orchestrator, which does not stay in downloading",
		async () => {
			// The install's own discovery fails: refused, with nobody admitting
			// a stream, so the orchestrator learns of it at its next tick.
			const { box } = await standingAt(
				"orchestrated",
				"apt-get -s (discovery)",
			);
			const { sequencer } = box;
			sequencer.step("fail");
			await sequencer.drain();
			expect(getUpdateState().kind).toBe("failed");
			expect(installDraining()).toBe(false);
			expect(getOrchestratorState().phase).toBe("downloading");
			// Before that tick the card rechecks: the failure is cleared and the
			// offer found again.
			sequencer.disarm();
			expect(sequencer.outside(() => triggerManualUpdateCheck())).toBe(true);
			for (let turn = 0; turn < 200; turn++) {
				if (getUpdateState().kind === "available") break;
				await settleEventLoop(1);
			}
			await settleEventLoop(5);
			expect(getUpdateState().kind).toBe("available");
			expect(getOrchestratorState().phase).toBe("downloading");
			// The tick: the refusal is recorded from what the install kept for
			// it, though the wire no longer shows it.
			await sequencer.outside(() => runOrchestratorTick());
			await settleEventLoop(5);
			expect(getOrchestratorState().phase).not.toBe("downloading");
			const failed = () =>
				box.emitted.filter(({ code }) => code === "update_failed");
			expect(failed()).toEqual([
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED },
				},
			]);
			// It was taken once: a further tick records nothing again.
			await sequencer.outside(() => runOrchestratorTick());
			expect(failed()).toHaveLength(1);
			await expectOfferAtNextCheck(box);
			expect(box.unit.unit.submissions).toBe(0);
		},
		TIMEOUT_MS,
	);
});

describe("an orchestrated install's failure, and what the Packages card does before the tick", () => {
	type Box = Awaited<ReturnType<typeof acceptedInstall>>;
	const failures = (box: Box) =>
		box.emitted.filter(({ code }) => code === "update_failed");
	const failureId = () => {
		const wire = getUpdateState();
		return wire.kind === "failed" ? wire.failure_id : undefined;
	};

	/** The orchestrator's install fails its download under the pin. */
	async function failedDownload() {
		const { box } = await standingAt("pinned", DOWNLOAD);
		box.sequencer.step("fail");
		await box.sequencer.drain();
		const id = failureId();
		expect(id).toBeString();
		expect(getOrchestratorState().phase).toBe("downloading");
		return { box, id };
	}

	/** The card's own recheck: the failure is cleared, the offer is back. */
	async function cardRechecks(box: Box) {
		box.sequencer.disarm();
		expect(box.sequencer.outside(() => triggerManualUpdateCheck())).toBe(true);
		for (let turn = 0; turn < 200; turn++) {
			if (getUpdateState().kind === "available") break;
			await settleEventLoop(1);
		}
		await settleEventLoop(5);
		expect(getUpdateState().kind).toBe("available");
	}

	it(
		"a recheck and a start the clock gate declines: the tick still records the refusal, once, with its id",
		async () => {
			const { box, id } = await failedDownload();
			await cardRechecks(box);
			// The card asks to install; the clock gate has closed, so the start
			// is declined. It was never an install.
			setImageClockGateFlagForTest(`${box.flag}.gone`);
			expect(box.sequencer.outside(() => startSoftwareUpdate()).started).toBe(
				false,
			);
			expect(getOrchestratorState().phase).toBe("downloading");
			await box.sequencer.outside(() => runOrchestratorTick());
			await settleEventLoop(5);
			// Not stranded in downloading with no unit.
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: PACKAGE_INSTALL_REFUSED,
			});
			const expected = [
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
				},
			];
			expect(failures(box)).toEqual(expected);
			await box.sequencer.outside(() => runOrchestratorTick());
			expect(failures(box)).toEqual(expected);
			expect(box.unit.unit.submissions).toBe(0);
			setImageClockGateFlagForTest(box.flag);
			await expectOfferAtNextCheck(box);
		},
		TIMEOUT_MS,
	);

	it(
		"a recheck and an install of the card's own that fails too: each failure keeps its own id",
		async () => {
			const { box, id } = await failedDownload();
			const { sequencer } = box;
			await cardRechecks(box);
			// The card installs through the start RPC: a second install, which
			// fails its download as well.
			sequencer.arm();
			expect(startSoftwareUpdate()).toEqual({ started: true });
			for (let turn = 0; turn < 400; turn++) {
				await settleMicrotasks();
				if (sequencer.next() === DOWNLOAD) break;
				sequencer.step();
			}
			expect(sequencer.next()).toBe(DOWNLOAD);
			sequencer.step("fail");
			await sequencer.drain();
			const second = failureId();
			expect(second).toBeString();
			expect(second).not.toBe(id);
			// The orchestrator records the install it started, by that
			// install's id; the card's failure is the card's.
			await sequencer.outside(() => runOrchestratorTick());
			await settleEventLoop(5);
			expect(failures(box)).toEqual([
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
				},
			]);
			expect(getOrchestratorState().phase).not.toBe("downloading");
			expect(box.unit.unit.submissions).toBe(0);
		},
		TIMEOUT_MS,
	);

	it(
		"a recheck, an install of the card's own that launches, then a stream: the refusal is recorded and that unit stopped",
		async () => {
			const { box, id } = await failedDownload();
			const { sequencer, unit } = box;
			await cardRechecks(box);
			// The card installs through the start RPC, and this one gets as far
			// as its unit.
			expect(startSoftwareUpdate()).toEqual({ started: true });
			for (let turn = 0; turn < 400; turn++) {
				if (unit.unit.state === "running") break;
				await settleEventLoop(1);
			}
			expect(unit.unit.submissions).toBe(1);
			expect(unit.unit.state).toBe("running");
			expect(getOrchestratorState().phase).toBe("downloading");
			// A stream, before any tick. The fence reports a launched unit: the
			// orchestrator's own install is still the refusal it was, and the
			// card's unit is stopped for the stream.
			expect(await admitStream(box)).toEqual({ allowed: true });
			expect(failures(box)).toEqual([
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
				},
			]);
			expect(unit.unit.stops).toBe(1);
			// Not quietly back at the offer as if nothing had failed.
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: PACKAGE_INSTALL_REFUSED,
			});
			await sequencer.outside(() => runOrchestratorTick());
			expect(failures(box)).toHaveLength(1);
		},
		TIMEOUT_MS,
	);

	it(
		"a recheck and an install of the card's own under way: the tick records the refusal and dispatches no check over that install",
		async () => {
			const { box, id } = await failedDownload();
			const { sequencer } = box;
			await cardRechecks(box);
			// The card's install is in progress: its refresh is out.
			sequencer.arm();
			expect(startSoftwareUpdate()).toEqual({ started: true });
			for (let turn = 0; turn < 400; turn++) {
				await settleMicrotasks();
				if (sequencer.next() === REFRESH_COMMAND) break;
				sequencer.step();
			}
			expect(sequencer.next()).toBe(REFRESH_COMMAND);
			expect(getUpdateState().kind).toBe("downloading");
			// The tick: the first install's refusal is recorded, which makes the
			// package retry due at once. It waits: the updater is the card's.
			let returned = false;
			const tick = sequencer
				.outside(() => runOrchestratorTick())
				.finally(() => {
					returned = true;
				});
			await settleEventLoop(10);
			expect(returned).toBe(true);
			await tick;
			expect(failures(box)).toEqual([
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
				},
			]);
			expect(
				box.emitted.filter(({ code }) => code === "update_refused"),
			).toEqual([]);
			expect(getOrchestratorState().phase).not.toBe("checking");
			expect(getOrchestratorState().packageCheck.consecutiveFailures).toBe(0);
			// A further tick waits likewise, and the card's install goes on to
			// launch its unit.
			await sequencer.outside(() => runOrchestratorTick());
			expect(
				box.emitted.filter(({ code }) => code === "update_refused"),
			).toEqual([]);
			await sequencer.drain();
			expect(box.unit.unit.submissions).toBe(1);
			expect(box.unit.unit.state).toBe("running");
		},
		TIMEOUT_MS,
	);

	it(
		"a recheck and then a stream: the refusal the stream settles carries the failure's id",
		async () => {
			const { box, id } = await failedDownload();
			await cardRechecks(box);
			expect(await admitStream(box)).toEqual({ allowed: true });
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: PACKAGE_INSTALL_REFUSED,
			});
			expect(failures(box)).toEqual([
				{
					code: "update_failed",
					params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED, id },
				},
			]);
			// Taken once: the tick adds nothing.
			await box.sequencer.outside(() => runOrchestratorTick());
			expect(failures(box)).toHaveLength(1);
			expect(box.unit.unit.stops).toBe(0);
		},
		TIMEOUT_MS,
	);
});

describe("updates are turned off during the final download under the pin", () => {
	it(
		"and the download then fails: the install ends as turned off, not with apt's error",
		async () => {
			const { box } = await standingAt("pinned", DOWNLOAD);
			const { sequencer } = box;
			setup.apt_update_enabled = false;
			sequencer.step("fail");
			await sequencer.drain();
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "discovery_failed",
			});
			expect(failedFrames(box.frames)).toEqual([
				{ kind: "failed", reason: "discovery_failed" },
			]);
			await sequencer.outside(() => runOrchestratorTick());
			await expectEndedBeforeLaunch(box, "discovery_failed", false);
		},
		TIMEOUT_MS,
	);
});

describe("the host's gateway election is the network module's", () => {
	it(
		"an install on a board that elects its route never asks for it, and goes by a fresh probe instead",
		async () => {
			const steps = await recordWaits("elected route");
			// Its own check and its preparation both probe the route as it is.
			expect(steps.filter((label) => label === "curl -4").length).toBe(4);
			const box = await acceptedInstall("elected route");
			await box.sequencer.drain();
			await expectLaunched(box);
			expect(box.electionRequests).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"an install whose fresh probe finds the route dead is refused, and still asks for nothing",
		async () => {
			const { box } = await standingAt("elected route", "curl -4");
			const { sequencer } = box;
			// Every probe of this round fails: no route to the repository.
			while (sequencer.parked().some((label) => label.startsWith("curl ")))
				sequencer.release(
					sequencer.parked().find((label) => label.startsWith("curl ")) ?? "",
					"fail",
				);
			await sequencer.drain();
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "repos_unreachable",
			});
			expect(box.electionRequests).toEqual([]);
			expect(box.unit.unit.submissions).toBe(0);
		},
		TIMEOUT_MS,
	);

	it(
		"a stream ends the install while it reads the board's capabilities: no election starts",
		async () => {
			const { box } = await standingAt(
				"elected route",
				"read the board capability os-updates",
			);
			const { sequencer } = box;
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			expect(box.electionRequests).toEqual([]);
			await expectEndedBeforeLaunch(box, "streaming", false);
		},
		TIMEOUT_MS,
	);

	it(
		"a check with no install behind it asks for the repair as it always did",
		async () => {
			const { box } = await standingAt("elected route", REFRESH_COMMAND);
			const { sequencer } = box;
			expect(await admitStream(box)).toEqual({ allowed: true });
			await sequencer.drain();
			expect(box.electionRequests).toEqual([]);
			// The Packages card's own check on the same board: no install, so
			// the route is repaired first, exactly as on every image.
			sequencer.disarm();
			expect(sequencer.beside(() => triggerManualUpdateCheck())).toBe(true);
			// Once before its refresh and once before its discovery.
			for (let turn = 0; turn < 200; turn++) {
				if (box.electionRequests.length >= 2) break;
				await settleEventLoop(1);
			}
			await settleEventLoop(5);
			expect(getUpdateState().kind).toBe("available");
			expect(box.electionRequests).toEqual([
				{ by: "beside", args: [true] },
				{ by: "beside", args: [true] },
			]);
		},
		TIMEOUT_MS,
	);
});

describe("an install ended while several of its commands are in flight", () => {
	const DNS = "resolvectl -4 -i eth0 query";

	it.each(["ok", "fail"] as const)(
		"keeps the updater until the last has returned, when the first returns %s and its next step is refused",
		async (first) => {
			const { box } = await standingAt("pinned", DNS);
			const { sequencer } = box;
			// Both sources are resolved for both address families at once.
			const dns = () =>
				sequencer
					.parkedOfFlow()
					.filter((label) => label.startsWith("resolvectl"));
			expect(dns()).toHaveLength(4);
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			// One lookup returns. What it would do next (the private curl
			// config) is refused, while three lookups are still out.
			sequencer.release(DNS, first);
			for (let left = 3; left > 0; left--) {
				await settleMicrotasks();
				await settleEventLoop(1);
				expectNoStaleEffect(box, mark);
				expect(dns()).toHaveLength(left);
				// The updater is the ended install's until they are back.
				expect(installDraining()).toBe(true);
				expect(sequencer.outside(() => startSoftwareUpdate())).toEqual({
					started: false,
					reason: "already_updating",
				});
				sequencer.release(dns()[0] as string);
			}
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			expect(installDraining()).toBe(false);
			expect(box.unit.unit.submissions).toBe(0);
			await expectEndedBeforeLaunch(box, "streaming", false);
		},
		TIMEOUT_MS,
	);

	it(
		"the unbound probe: one of four probes is refused at its next step while three are still out",
		async () => {
			// Four probes (two origins, two address families) each start by
			// making sure of the private directory.
			const { box } = await standingAt("orchestrated", CONFIG_DIRECTORY);
			const { sequencer } = box;
			const out = () =>
				sequencer.parkedOfFlow().filter((label) => label === CONFIG_DIRECTORY);
			expect(out()).toHaveLength(4);
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			// One returns. Its next step, writing the config, is refused, which
			// fails that probe at once; the other three have not come back.
			sequencer.release(CONFIG_DIRECTORY);
			for (let left = 3; left > 0; left--) {
				await settleMicrotasks();
				await settleEventLoop(1);
				expectNoStaleEffect(box, mark);
				expect(out()).toHaveLength(left);
				// A join that gave up at the first refusal would have released
				// the install's hold here.
				expect(installDraining()).toBe(true);
				expect(sequencer.outside(() => startSoftwareUpdate())).toEqual({
					started: false,
					reason: "already_updating",
				});
				sequencer.release(CONFIG_DIRECTORY);
			}
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			expect(installDraining()).toBe(false);
			expect([...box.privateFiles]).toEqual([]);
			await expectEndedBeforeLaunch(box, "streaming", false);
		},
		TIMEOUT_MS,
	);
});

describe("routing rules an earlier pinned run left in the journal", () => {
	// Two rules of an earlier run; recovery deletes the last recorded first.
	const RECOVERED = [
		{
			family: 4 as const,
			args: "rule add priority 120 uidrange 42042-42042 lookup 100000".split(
				" ",
			),
		},
		{
			family: 6 as const,
			args: "rule add priority 120 uidrange 42042-42042 prohibit".split(" "),
		},
	];
	const FIRST_DELETION =
		"ip -6 rule del priority 120 uidrange 42042-42042 prohibit";
	const SECOND_DELETION =
		"ip rule del priority 120 uidrange 42042-42042 lookup 100000";
	const READ = "routing journal: read";
	const routing = (
		box: Awaited<ReturnType<typeof acceptedInstall>>,
		from: number,
	) =>
		box.sequencer
			.calls()
			.slice(from)
			.map(({ label }) => label)
			.filter((label) => label.startsWith("ip "));

	it(
		"are not deleted by an install that ended while it read the journal",
		async () => {
			const { box } = await standingAt("pinned", READ);
			box.journal.entries = RECOVERED;
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			await box.sequencer.drain(() => expectNoStaleEffect(box, mark));
			// Not its rule: nothing was deleted and the entry is still recorded.
			expect(routing(box, mark.calls)).toEqual([]);
			expect(box.journal.entries).toEqual(RECOVERED);
			expect(getUpdateState()).toMatchObject(STREAMING);
		},
		TIMEOUT_MS,
	);

	it(
		"an install that ends between two deletions finishes the one it began and leaves the other",
		async () => {
			const { box } = await standingAt("pinned", READ);
			const { sequencer } = box;
			box.journal.entries = RECOVERED;
			const from = sequencer.calls().length;
			// Alive when the journal is read: recovery begins with the last rule.
			sequencer.step();
			await settleMicrotasks();
			expect(sequencer.next()).toBe(FIRST_DELETION);
			// It ends while that deletion is in flight.
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			// The deletion it had begun is finished and struck from the journal;
			// the other rule is not its to delete any more.
			expect(routing(box, from)).toEqual([FIRST_DELETION]);
			expect(routing(box, from)).not.toContain(SECOND_DELETION);
			expect(box.journal.entries).toEqual([RECOVERED[0]]);
			expect(getUpdateState()).toMatchObject(STREAMING);
		},
		TIMEOUT_MS,
	);

	it(
		"are recovered by an install that is still alive",
		async () => {
			const { box } = await standingAt("pinned", READ);
			box.journal.entries = RECOVERED;
			const from = box.sequencer.calls().length;
			await box.sequencer.drain();
			expect(routing(box, from).slice(0, 2)).toEqual([
				FIRST_DELETION,
				SECOND_DELETION,
			]);
			const left = box.journal.entries.map((entry) => entry.args.join(" "));
			for (const { args } of RECOVERED)
				expect(left).not.toContain(args.join(" "));
		},
		TIMEOUT_MS,
	);
});

describe("the launcher's first look for a unit", () => {
	it(
		"a stream ends the install while it looks, and a unit is there: its fragment is not read",
		async () => {
			// A unit as an earlier install left it running.
			const earlier = await acceptedInstall("orchestrated");
			await earlier.sequencer.drain();
			await expectLaunched(earlier);
			const script = earlier.unit.unit.script;
			await teardownInstall();
			const { box } = await standingAt("orchestrated", REINSPECT);
			box.unit.unit.script = script;
			box.unit.unit.state = "running";
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			await box.sequencer.drain(() => expectNoStaleEffect(box, mark));
			expect(
				box.sequencer
					.calls()
					.slice(mark.calls)
					.map(({ label }) => label),
			).not.toContain(FRAGMENT);
			expect(box.unit.unit.submissions).toBe(0);
			expect(getUpdateState()).toMatchObject(STREAMING);
		},
		TIMEOUT_MS,
	);
});

describe("a private curl config that could not be removed", () => {
	it(
		"is reported although its install has ended, without the token, and goes when the backend next starts",
		async () => {
			const { box } = await standingAt("orchestrated", CONFIG_REMOVAL);
			const { sequencer } = box;
			expect(await admitStream(box)).toEqual({ allowed: true });
			const mark = box.mark();
			// The first of the four removals fails.
			sequencer.step("fail");
			await sequencer.drain(() => expectNoStaleEffect(box, mark));
			expect([...box.privateFiles]).toHaveLength(1);
			const [left] = [...box.privateFiles] as [string];
			// It was written inside the service's own directory and nowhere else.
			expect(path.dirname(left)).toBe(PRIVATE_CURL_DIRECTORY);
			const reports = box
				.everyLogSince(mark)
				.filter((line) => line.startsWith(PRIVATE_FILE_LEFT_BEHIND));
			expect(reports).toHaveLength(1);
			// Which directory, never which file, and never the token.
			expect(reports[0]).toContain(PRIVATE_CURL_DIRECTORY);
			expect(reports[0]).not.toContain(path.basename(left));
			expect(reports[0]).not.toContain(TOKEN);
			// Nothing sweeps while the backend runs: the next install leaves it.
			await expectOfferAtNextCheck(box);
			expect(box.privateFiles.has(left)).toBe(true);
			// The backend's next start removes that one directory.
			await wipePrivateCurlConfigs(true);
			expect([...box.privateFiles]).toEqual([]);
		},
		TIMEOUT_MS,
	);
});
