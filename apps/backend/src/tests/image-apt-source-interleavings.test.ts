/// <reference types="bun" />

/**
 * The launch fence of an install on an image with its own apt source, tested
 * as a class: at every wait between "the start was accepted" and "the unit was
 * submitted", something else happens (a stream is admitted, updates are turned
 * off, a second start arrives) and exactly one outcome is allowed.
 *
 * The waits are not listed here. Every fake waits on a sequencer gate; a first
 * run records the gates the real code passes, in order, and proves that the
 * install waits on nothing else (helpers/await-sequencer.ts). The other runs
 * replay the install up to each recorded wait in turn. A new wait in the code
 * is therefore either a new step with all three events run at it, or a failed
 * recording.
 *
 * What happens after such an event (a retry, a check, a failing wait) is in
 * image-apt-source-sequences.test.ts. The install itself, with its in-process
 * fakes, is helpers/image-apt-install-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { setup } from "../modules/setup.ts";
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
	ARCHIVE_CLEANUP,
	acceptedInstall,
	atEveryWait,
	BESIDE_START_RPC,
	DELAY,
	expectEndedBeforeLaunch,
	expectLaunched,
	PENDING,
	REINSPECT,
	ROUTE_WRITE,
	recordWaits,
	restoreUpdatesSetting,
	SPOOL,
	SUBMIT,
	TIMEOUT_MS,
	useInstallHarness,
	VARIANTS,
	type Variant,
} from "./helpers/image-apt-install-harness.ts";

useSessionOwnerForFile();
useInstallHarness();

const EVENTS = ["stream admission", "updates off", "second start"] as const;
type Event = (typeof EVENTS)[number];

async function run(
	variant: Variant,
	event: Event,
	step: number,
	steps: readonly string[],
) {
	const box = await acceptedInstall(variant);
	const { sequencer, unit, quarantine } = box;
	await sequencer.advance(step);
	// The wait the install stands at now, and the event that happens there.
	expect(sequencer.next()).toBe(steps[step] as string);
	// At its last wait `systemd-run` is in flight: the unit is submitted.
	const submitting = steps[step] === SUBMIT;
	// The delayed start has not run yet: the other check is still in flight.
	const delayedAt = steps.indexOf(DELAY);
	const waiting = variant === "delayed" && step <= delayedAt;
	const beside = BESIDE_START_RPC[variant];

	if (event === "stream admission") {
		// Admitted, and never seen live: only the fence can stop the launch.
		const admission = sequencer.outside(() => admitAndPrepareStreamStart());
		if (!submitting) {
			expect(await admission).toEqual({ allowed: true });
			// Refused at once, before the install resumes.
			expect(getUpdateState()).toMatchObject({
				kind: "failed",
				reason: "streaming",
			});
			if (beside === undefined)
				expect(getOrchestratorState()).toMatchObject({
					phase: "failed",
					failureReason: PACKAGE_INSTALL_REFUSED,
				});
			// The host's election may still be running for it: from here on it
			// starts no route write that only this install asked for.
			const routes = box.routeWrites.length;
			await sequencer.drain();
			expect(box.routeWrites.length).toBe(routes);
			await expectEndedBeforeLaunch(
				box,
				"streaming",
				variant === "delayed" && step < delayedAt,
			);
			return;
		}
		// The submission is decided first; the stream then meets a launched unit.
		await settleMicrotasks();
		expect(getUpdateState().kind).toBe("downloading");
		expect(unit.unit.state).toBe("absent");
		sequencer.step();
		expect(await admission).toEqual({ allowed: true });
		expect(unit.unit.submissions).toBe(1);
		// A launched unit is stopped for the stream, whoever started it.
		expect(unit.unit.stops).toBe(1);
		if (beside !== undefined) {
			// The orchestrator did not start it: it has no plan to return to an
			// offer, and keeps its phase.
			expect(getOrchestratorState().phase).toBe(beside);
			return;
		}
		// Today's path: the plan returns to the offer.
		expect(getOrchestratorState()).toMatchObject({
			phase: "available",
			failureReason: null,
		});
		expect(await quarantine.readPending()).toEqual(PENDING);
		return;
	}

	if (event === "updates off") {
		setup.apt_update_enabled = false;
		if (submitting) {
			await sequencer.drain();
			restoreUpdatesSetting();
			await expectLaunched(box);
			return;
		}
		// From here on the install does nothing more: no command, no file
		// step, no owned write, and no route written for it. It ends where it
		// would have done the next one.
		const mark = box.mark();
		const routes = box.routeWrites.length;
		await sequencer.drain(() => {
			expect(box.effectsSince(mark)).toEqual([]);
		});
		expect(box.routeWrites.length).toBe(routes);
		expect(getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "discovery_failed",
		});
		// The orchestrator learns of it when it next looks.
		if (beside === undefined)
			await sequencer.outside(() => runOrchestratorTick());
		await expectEndedBeforeLaunch(box, "discovery_failed", false);
		return;
	}

	// A second start, through the orchestrator and through the start RPC.
	const before = getOrchestratorState().phase;
	expect(
		await sequencer.outside(() => installUpdatesNow({ scope: "packages" })),
	).toEqual({
		started: false,
		// An idle orchestrator has no package offer of its own to install.
		reason: beside === "idle" ? "not_available" : "busy",
	});
	// Through the orchestrator it changes nothing. Beside the start RPC's
	// install, a request for the offer the orchestrator holds stays queued,
	// as any request that cannot start yet.
	expect(getOrchestratorState().phase).toBe(
		beside === "available" ? "awaiting-idle" : before,
	);
	// While the start still waits behind the other check, a second start is
	// that same install; afterwards it is refused. Never a second install.
	expect(sequencer.outside(() => startSoftwareUpdate())).toEqual(
		waiting
			? { started: true }
			: { started: false, reason: "already_updating" },
	);
	await sequencer.drain();
	await expectLaunched(box);
}

describe("the launch fence: every wait before the unit is submitted", () => {
	it.each(VARIANTS)(
		"%s: the install waits only where a fake stands, and its last wait is systemd-run",
		async (variant) => {
			const steps = await recordWaits(variant);
			expect(steps.at(-1)).toBe(SUBMIT);
			expect(steps.filter((label) => label === SUBMIT)).toHaveLength(1);
			// Its own check, its preparation and the launcher are all in there.
			expect(steps).toContain("apt-get update");
			expect(steps).toContain("apt-get -s (discovery)");
			expect(steps).toContain(ARCHIVE_CLEANUP);
			expect(steps).toContain(REINSPECT);
			expect(steps).toContain(SPOOL);
			if (variant === "pinned")
				expect(steps).toContain("apt-get -d (download under the pin)");
			// Only the start behind a running check waits on the timer.
			expect(steps.includes(DELAY)).toBe(variant === "delayed");
			// Where the backend elects the default route, apt waits for the
			// election, which writes the route while the install lives.
			expect(steps.includes(ROUTE_WRITE)).toBe(variant === "route repair");
		},
		TIMEOUT_MS,
	);

	describe.each(VARIANTS)("%s", (variant) => {
		it.each(EVENTS)(
			"%s at every wait",
			async (event) => {
				const steps = await recordWaits(variant);
				await atEveryWait(steps, (step) => run(variant, event, step, steps));
			},
			TIMEOUT_MS,
		);
	});
});
