/// <reference types="bun" />

/**
 * What follows the end of an install on an image with its own apt source.
 *
 * image-apt-source-interleavings.test.ts lets one thing happen at each wait of
 * an install. Here a second thing follows, again at every recorded wait:
 *
 * - a stream ends the install, then Check now;
 * - a stream ends the install, the wait it stood at then fails, then Check now;
 * - a stream ends the install, then it is installed again;
 * - a stream ends the install, then updates are turned off;
 * - the wait fails with nobody else involved, then a stream is admitted.
 *
 * An install that ended may still have a wait in flight. Each of those waits
 * is released in turn, and after every one the ended install must have done
 * nothing: it started no call (no apt run, no probe, no spool setup, no
 * routing rule) and nothing that can be seen of it changed (no write to the
 * wire or the inventory, no frame, no event, no backoff, no unit).
 *
 * The uncertain `systemd-run` (its client failed, so the launcher looks for
 * the unit again inside the launch fence) has its own cases at the end: the
 * second look answering, failing, and hanging while a stream is admitted.
 *
 * The install and its in-process fakes are
 * helpers/image-apt-install-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { setup } from "../modules/setup.ts";
import {
	getUpdateState,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { PACKAGE_INSTALL_REFUSED } from "../modules/system/update-orchestrator/types.ts";
import {
	type GateAnswer,
	settleEventLoop,
	settleMicrotasks,
} from "./helpers/await-sequencer.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	type Accepted,
	acceptedInstall,
	atEveryWait,
	BESIDE_START_RPC,
	DELAY,
	expectLaunched,
	expectNoStaleEffect,
	expectOfferAtNextCheck,
	failedFrames,
	installDraining,
	type Mark,
	PENDING,
	REINSPECT,
	recordWaits,
	SPOOL,
	SUBMIT,
	TIMEOUT_MS,
	useInstallHarness,
	VARIANTS,
	type Variant,
} from "./helpers/image-apt-install-harness.ts";

useSessionOwnerForFile();
useInstallHarness();

// A stream can end an install at every wait but the last: with `systemd-run`
// in flight the unit counts as launched.
const beforeSubmit = (label: string) => label !== SUBMIT;
const STREAMING = { kind: "failed", reason: "streaming" } as const;
const isStreaming = ({ reason }: { reason?: string }) => reason === "streaming";
const ARCHIVE_CLEANUP = "space preflight: apt-get clean";

/** The install at wait `step`, ended there by a stream that is never live. */
async function endedByStreamAt(
	variant: Variant,
	step: number,
	steps: readonly string[],
) {
	const box = await acceptedInstall(variant);
	await box.sequencer.advance(step);
	expect(box.sequencer.next()).toBe(steps[step] as string);
	expect(
		await box.sequencer.outside(() => admitAndPrepareStreamStart()),
	).toEqual({ allowed: true });
	expect(getUpdateState()).toMatchObject(STREAMING);
	// While the start still waited behind another check, that check runs on:
	// it is not the install, and what it does and writes is its own.
	const otherCheck = variant === "delayed" && step < steps.indexOf(DELAY);
	return { box, otherCheck };
}

/**
 * Releases what the ended install still has in flight, one wait at a time
 * (the first one as `first`), and after each asserts that it did nothing.
 * `whileDraining` limits the look at the state to the time the old install
 * still has a wait in flight, for when something waits behind it.
 */
async function drainEnded(
	box: Accepted,
	mark: Mark,
	options: {
		first?: GateAnswer;
		stateToo: boolean;
		whileDraining?: boolean;
		whenDrained?: () => void;
	},
) {
	const check = () => {
		expectNoStaleEffect(
			box,
			mark,
			options.stateToo && (!options.whileDraining || installDraining()),
		);
		if (!installDraining()) options.whenDrained?.();
	};
	if (options.first === "fail" && box.sequencer.step("fail")) {
		await settleMicrotasks(2);
		await settleEventLoop(1);
		check();
	}
	await box.sequencer.drain(check);
	expect(installDraining()).toBe(false);
	expect(box.callsSince(mark)).toEqual([]);
}

/** The offer is back for both, without disarming the sequencer. */
async function checkNowFindsTheOffer(
	box: Accepted,
	pending?: Promise<unknown>,
) {
	const os = box.counts.osChecks;
	expect(
		await (pending ?? box.sequencer.outside(() => checkUpdatesNow())),
	).toEqual({ started: true });
	expect(getUpdateState().kind).toBe("available");
	expect(getOrchestratorState()).toMatchObject({
		phase: "available",
		failureReason: null,
		// The check ran once and succeeded: no failure counted, no backoff.
		packageCheck: { consecutiveFailures: 0 },
	});
	expect(await box.quarantine.readPending()).toEqual([]);
	expect(box.counts.osChecks).toBe(os + (pending ? 0 : 1));
	// Nobody was told a check or an install was refused.
	expect(box.emitted.filter(({ code }) => code === "update_refused")).toEqual(
		[],
	);
}

async function streamThenCheckNow(
	variant: Variant,
	step: number,
	steps: readonly string[],
	first: GateAnswer,
) {
	const { box, otherCheck } = await endedByStreamAt(variant, step, steps);
	const { sequencer, unit, frames } = box;
	// Asked for while the ended install still has a wait in flight, the check
	// waits for that instead of answering busy.
	let check: Promise<unknown> | undefined;
	let settled = false;
	const os = box.counts.osChecks;
	// (With the wait about to fail, the check is asked for afterwards, so
	// that what the failure writes is seen before any check could cover it.)
	if (installDraining() && first === "ok") {
		// Its package check parks like the install, so the test can stand in it.
		box.counts.parkChecks = true;
		check = sequencer
			.outside(() => checkUpdatesNow())
			.finally(() => {
				settled = true;
			});
		// It has started (the orchestrator says `checking`) and now waits.
		for (let turn = 0; turn < 500; turn++) {
			if (getOrchestratorState().phase === "checking") break;
			await settleEventLoop(1);
		}
		expect(getOrchestratorState().phase).toBe("checking");
		await settleEventLoop(3);
		expect(settled).toBe(false);
	}
	const mark = box.mark();
	// Once the old install has drained, the waiting check runs: from then on
	// the updater is the check's, and a second check finds it busy.
	let probed = false;
	await drainEnded(box, mark, {
		first,
		stateToo: !otherCheck,
		whileDraining: check !== undefined,
		whenDrained: () => {
			if (!check || probed || sequencer.next() === undefined) return;
			probed = true;
			expect(sequencer.outside(() => triggerManualUpdateCheck())).toBe(false);
		},
	});
	if (check) expect(probed).toBe(true);
	box.counts.parkChecks = false;
	await checkNowFindsTheOffer(box, check);
	if (check) expect(box.counts.osChecks).toBe(os + 1);
	// The ended install submitted nothing, and its end was said once. (A
	// check that ran beside it may have failed and said so for itself.)
	expect(unit.unit.submissions).toBe(0);
	expect(failedFrames(frames).filter(isStreaming)).toEqual([STREAMING]);
	if (!otherCheck) expect(failedFrames(frames)).toEqual([STREAMING]);
	// One install ended, as the orchestrator recorded if it had started it.
	expect(box.emitted.filter(({ code }) => code === "update_failed")).toEqual(
		BESIDE_START_RPC[variant] === undefined
			? [
					{
						code: "update_failed",
						params: { stage: "download", reason: PACKAGE_INSTALL_REFUSED },
					},
				]
			: [],
	);
}

async function streamThenInstallAgain(
	variant: Variant,
	step: number,
	steps: readonly string[],
) {
	const { box, otherCheck } = await endedByStreamAt(variant, step, steps);
	const { sequencer, unit, frames, quarantine } = box;
	// While the ended install has a wait in flight, the updater is its still:
	// a new install is refused until that has returned.
	if (installDraining())
		expect(sequencer.outside(() => startSoftwareUpdate())).toEqual({
			started: false,
			reason: "already_updating",
		});
	const mark = box.mark();
	await drainEnded(box, mark, { stateToo: !otherCheck });
	await checkNowFindsTheOffer(box);
	// Installed again, the way this install was started.
	const again = sequencer.calls().length;
	if (BESIDE_START_RPC[variant] !== undefined)
		expect(startSoftwareUpdate()).toEqual({ started: true });
	else
		expect(
			await sequencer.outside(() => installUpdatesNow({ scope: "packages" })),
		).toEqual({ started: true });
	await sequencer.drain();
	// One unit, the new install's, over a spool only the new install set up.
	expect(unit.unit.submissions).toBe(1);
	expect(unit.unit.state).toBe("running");
	expect(getUpdateState().kind).toBe("downloading");
	const since = sequencer.calls().slice(again);
	expect(since.filter(({ label }) => label === SPOOL)).toHaveLength(1);
	expect(since.filter(({ label }) => label === SUBMIT)).toHaveLength(1);
	expect(failedFrames(frames)).toEqual([STREAMING]);
	if (BESIDE_START_RPC[variant] !== undefined) return;
	expect(getOrchestratorState().phase).toBe("downloading");
	expect(await quarantine.readPending()).toEqual(PENDING);
}

async function streamThenUpdatesOff(
	variant: Variant,
	step: number,
	steps: readonly string[],
) {
	const { box, otherCheck } = await endedByStreamAt(variant, step, steps);
	const { sequencer, unit, frames, counts } = box;
	setup.apt_update_enabled = false;
	const mark = box.mark();
	await drainEnded(box, mark, { stateToo: !otherCheck });
	// The end the stream gave it stands: turning updates off adds nothing.
	expect(failedFrames(frames)).toEqual([STREAMING]);
	if (!otherCheck) expect(getUpdateState()).toMatchObject(STREAMING);
	expect(unit.unit.submissions).toBe(0);
	// Check now with updates off: no package check runs, so none fails. No
	// event, no backoff; the image check still runs.
	const before = box.observe();
	const os = counts.osChecks;
	expect(await sequencer.outside(() => checkUpdatesNow())).toEqual({
		started: true,
	});
	const after = box.observe();
	expect(after.events).toBe(before.events);
	expect(after.orchestrator.packageCheck).toEqual(
		before.orchestrator.packageCheck,
	);
	expect(after.wire).toEqual(before.wire);
	expect(counts.osChecks).toBe(os + 1);
	// Turned on again, the next check finds the offer.
	await expectOfferAtNextCheck(box);
}

async function waitFailsThenStream(
	variant: Variant,
	step: number,
	steps: readonly string[],
) {
	const box = await acceptedInstall(variant);
	const { sequencer, unit, frames, quarantine } = box;
	await sequencer.advance(step);
	expect(sequencer.next()).toBe(steps[step] as string);
	// The check the start waited behind is what fails here, not the install.
	const otherCheck = variant === "delayed" && step < steps.indexOf(DELAY);
	const failedAt = sequencer.calls().length;
	sequencer.step("fail");
	// Whatever the failure does, the install comes to rest in one of two
	// ways: ended before launch, said once, or launched after all (a failure
	// it can do without, or one of the check that ran beside it).
	const ended = () => {
		const { kind } = getUpdateState();
		return kind === "failed" || kind === "update_preflight_failed";
	};
	let mark: Mark | undefined;
	await sequencer.drain(() => {
		if (otherCheck) return;
		// Once it ended it starts nothing more: no cleanup, no further run.
		if (mark) expectNoStaleEffect(box, mark);
		else if (ended()) mark = box.mark();
	});
	const wire = getUpdateState();
	const beside = BESIDE_START_RPC[variant];
	if (otherCheck || !ended()) {
		await expectLaunched(box, !otherCheck);
		// A stream then meets a launched unit and stops it.
		expect(await sequencer.outside(() => admitAndPrepareStreamStart())).toEqual(
			{ allowed: true },
		);
		expect(unit.unit.stops).toBe(1);
		if (beside === undefined)
			expect(getOrchestratorState().phase).toBe("available");
		return;
	}
	// A failure that ends the install is settled when it is known: no archive
	// cleanup runs first, in which a stream could take the failure's place.
	expect(
		sequencer
			.calls()
			.slice(failedAt)
			.filter(({ label }) => label === ARCHIVE_CLEANUP),
	).toEqual([]);
	expect(unit.unit.submissions).toBe(0);
	expect(failedFrames(frames)).toHaveLength(1);
	expect(installDraining()).toBe(false);
	// A stream is admitted before the orchestrator has looked. The failure
	// stands, with its id: the stream neither replaces it nor stops anything.
	const said = box.emitted.length;
	expect(await sequencer.outside(() => admitAndPrepareStreamStart())).toEqual({
		allowed: true,
	});
	expect(getUpdateState()).toEqual(wire);
	expect(failedFrames(frames)).toHaveLength(1);
	expect(unit.unit.stops).toBe(0);
	if (mark) expect(box.callsSince(mark)).toEqual([]);
	if (beside === undefined) {
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		expect(box.emitted.slice(said)).toEqual([
			{
				code: "update_failed",
				params: {
					stage: "download",
					reason: PACKAGE_INSTALL_REFUSED,
					...(wire.kind === "failed" && wire.failure_id !== undefined
						? { id: wire.failure_id }
						: {}),
				},
			},
		]);
		expect(await quarantine.readPending()).toEqual(PENDING);
	} else {
		expect(getOrchestratorState().phase).toBe(beside);
		expect(box.emitted.slice(said)).toEqual([]);
	}
	await expectOfferAtNextCheck(box);
	expect(unit.unit.submissions).toBe(0);
}

const SEQUENCES = {
	"a stream ends it, then Check now": (variant, step, steps) =>
		streamThenCheckNow(variant, step, steps, "ok"),
	"a stream ends it, the wait then fails, then Check now": (
		variant,
		step,
		steps,
	) => streamThenCheckNow(variant, step, steps, "fail"),
	"a stream ends it, then it is installed again": streamThenInstallAgain,
	"a stream ends it, then updates are turned off": streamThenUpdatesOff,
	"the wait fails, then a stream is admitted": waitFailsThenStream,
} satisfies Record<
	string,
	(variant: Variant, step: number, steps: readonly string[]) => Promise<void>
>;

describe("after an install ended: nothing of it acts any more", () => {
	describe.each(VARIANTS)("%s", (variant) => {
		it.each(Object.keys(SEQUENCES) as (keyof typeof SEQUENCES)[])(
			"%s, at every wait",
			async (sequence) => {
				const steps = await recordWaits(variant);
				const runs = await atEveryWait(
					steps,
					(step) => SEQUENCES[sequence](variant, step, steps),
					beforeSubmit,
				);
				// Every wait but `systemd-run` itself.
				expect(runs).toBe(steps.length - 1);
			},
			TIMEOUT_MS,
		);
	});
});

// `systemd-run`'s client failed: the launcher looks for the unit again, still
// inside the launch fence. `created` is whether PID 1 made the unit anyway.
const SECOND_LOOKS = [
	{
		name: "finds no unit: the install is refused",
		created: false,
		look: "ok",
		launched: false,
	},
	{
		name: "finds the unit: it launched",
		created: true,
		look: "ok",
		launched: true,
	},
	{
		name: "fails: unknowable counts as launched",
		created: true,
		look: "fail",
		launched: true,
	},
] as const;

describe("an uncertain systemd-run: the second look for the unit", () => {
	const variants = [
		"orchestrated",
		"start RPC from the Packages card",
	] as const;

	async function atSecondLook(variant: Variant, created: boolean) {
		const steps = await recordWaits(variant);
		const box = await acceptedInstall(variant);
		await box.sequencer.advance(steps.length - 1);
		expect(box.sequencer.next()).toBe(SUBMIT);
		box.unit.unit.createdDespiteClientError = created;
		box.sequencer.step("fail");
		await settleMicrotasks();
		// The second look is in flight, inside the fence.
		expect(box.sequencer.next()).toBe(REINSPECT);
		expect(box.unit.unit.submissions).toBe(1);
		return box;
	}

	async function expectRefusedUnit(box: Accepted, streamAdmitted: boolean) {
		const wire = getUpdateState();
		expect(wire).toMatchObject({
			kind: "failed",
			reason: "systemd-run: Connection timed out",
		});
		expect(wire.kind === "failed" ? wire.failure_id : undefined).toBeString();
		expect(failedFrames(box.frames)).toHaveLength(1);
		expect(box.unit.unit.stops).toBe(0);
		if (BESIDE_START_RPC[box.variant] !== undefined) return;
		// A stream that was waiting has settled it; else the next tick does.
		if (!streamAdmitted)
			await box.sequencer.outside(() => runOrchestratorTick());
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: PACKAGE_INSTALL_REFUSED,
		});
		expect(box.emitted.filter(({ code }) => code === "update_failed")).toEqual([
			{
				code: "update_failed",
				params: {
					stage: "download",
					reason: PACKAGE_INSTALL_REFUSED,
					id: wire.kind === "failed" ? wire.failure_id : undefined,
				},
			},
		]);
	}

	describe.each(variants)("%s", (variant) => {
		it.each(SECOND_LOOKS)(
			"$name",
			async ({ created, look, launched }) => {
				const box = await atSecondLook(variant, created);
				box.sequencer.step(look);
				await box.sequencer.drain();
				if (launched) await expectLaunched(box);
				else {
					await expectRefusedUnit(box, false);
					await expectOfferAtNextCheck(box);
				}
			},
			TIMEOUT_MS,
		);

		it.each(SECOND_LOOKS)(
			"hangs while a stream is admitted, then $name",
			async ({ created, look, launched }) => {
				const box = await atSecondLook(variant, created);
				const { sequencer, unit } = box;
				let settled = false;
				const admission = sequencer
					.outside(() => admitAndPrepareStreamStart())
					.finally(() => {
						settled = true;
					});
				// The stream waits for the decision; meanwhile nothing moves.
				const mark = box.mark();
				await settleEventLoop(5);
				expect(settled).toBe(false);
				expectNoStaleEffect(box, mark);
				expect(getUpdateState().kind).toBe("downloading");
				sequencer.step(look);
				expect(await admission).toEqual({ allowed: true });
				if (!launched) {
					// Refused after all: nothing to stop, and never the offer.
					await expectRefusedUnit(box, true);
					await expectOfferAtNextCheck(box);
					return;
				}
				// Launched: the stream stops the unit, whoever started it.
				expect(unit.unit.stops).toBe(1);
				if (BESIDE_START_RPC[variant] === undefined)
					expect(getOrchestratorState()).toMatchObject({
						phase: "available",
						failureReason: null,
					});
			},
			TIMEOUT_MS,
		);
	});
});
