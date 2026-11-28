/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { isOwnerEnded } from "../../helpers/effect-owner.ts";
import { imageAptSourceInUse } from "./image-apt-source.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
	type DetachedAptServiceDeps,
	type DetachedAptServiceState,
	defaultDetachedAptServiceDeps,
	type SoftwareUpdateOutputPaths,
} from "./software-update-service.ts";

export type { SoftwareUpdateOutputPaths } from "./software-update-service.ts";
export { buildDetachedAptUpgradeCommand } from "./software-update-service.ts";

const OUTPUT_POLL_INTERVAL_MS = 250;
const FINAL_DRAIN_MAX_FAILURES = 20;
const INSPECT_RETRY_MAX_MS = 30_000;
// systemd unloads an unreferenced stopped unit right after the stop job; a
// unit still loaded after these reads is kept by a reference.
const PINNED_READS = 3;

export type SoftwareUpdateOutputHandlers = {
	readonly onStdout: (chunk: string) => void;
	readonly onStderr: (chunk: string) => void;
	readonly onAttached?: () => void;
	/** systemd accepted the unit: from here the transaction is the unit's. */
	readonly onLaunched?: () => void;
	/**
	 * Runs the unit's submission: `systemd-run`, and what an uncertain result
	 * is taken for. An image with its own apt source passes its launch fence
	 * here (install-launch-fence.ts); without it the launcher submits directly.
	 * Rejecting means no unit was submitted.
	 */
	readonly submit?: <T>(launch: () => Promise<T>) => Promise<T>;
	/**
	 * The unit has stopped but systemd keeps it loaded (an image's drain names
	 * it in After=), so no install can start under its name until the next boot.
	 */
	readonly onUnitPinned?: () => void;
	readonly onObserverError?: (
		error: unknown,
		suppressedRetries?: number,
	) => void;
};

export type DetachedAptUpgradeDeps = DetachedAptServiceDeps;

export type RecoveredDetachedAptUpgrade = {
	readonly completion: Promise<number>;
	/**
	 * True when the unit was ALREADY in its "finished" state at the moment we
	 * inspected it — i.e. only a bounded final drain + cleanup remain on
	 * `completion`, never an unbounded poll loop (the "running" case can take
	 * minutes). A caller may safely AWAIT `completion` when this is true; it
	 * must not when it is false, or it risks blocking boot on a live apt
	 * transaction. See software-updates.ts `recoverSoftwareUpdate()`.
	 */
	readonly wasAlreadyFinished: boolean;
};

type OutputCursor = {
	readonly path: string;
	readonly offset: number;
	readonly decoder: TextDecoder;
	readonly emit: (chunk: string) => void;
};

export class DetachedAptServiceVanishedError extends Error {
	constructor() {
		super("software-update transient service vanished after launch");
		this.name = "DetachedAptServiceVanishedError";
	}
}

export class DetachedAptServiceAlreadyExistsError extends Error {
	constructor() {
		super("a detached apt transaction already exists");
		this.name = "DetachedAptServiceAlreadyExistsError";
	}
}

/**
 * The last transaction's unit has stopped, but another loaded unit names it
 * (an image's shutdown drain with After=ceralive-software-update.service), so
 * systemd keeps it loaded and refuses a new unit by its name until the next
 * boot.
 */
export class DetachedAptServicePinnedError extends Error {
	constructor() {
		super(
			"the previous software update's stopped unit is still loaded; restart the device before installing again",
		);
		this.name = "DetachedAptServicePinnedError";
	}
}

export class DetachedAptServiceCleanupError extends Error {
	constructor(
		readonly transactionExitCode: number,
		readonly cleanupError: unknown,
	) {
		super("apt transaction finished, but its transient service cleanup failed");
		this.name = "DetachedAptServiceCleanupError";
	}
}

export class DetachedAptOutputUnavailableError extends Error {
	constructor() {
		super(
			"detached apt output remained unreadable after the transaction finished",
		);
		this.name = "DetachedAptOutputUnavailableError";
	}
}

function reportObserverError(
	handlers: SoftwareUpdateOutputHandlers,
	error: unknown,
): void {
	handlers.onObserverError?.(error);
}

async function drainOutputCursor(
	cursor: OutputCursor,
	read: DetachedAptUpgradeDeps["readOutput"],
): Promise<OutputCursor> {
	const next = await read(cursor.path, cursor.offset);
	if (next.bytes.byteLength > 0) {
		const text = cursor.decoder.decode(next.bytes, { stream: true });
		if (text.length > 0) cursor.emit(text);
	}
	return { ...cursor, offset: next.nextOffset };
}

async function drainAvailableOutput(
	stdoutCursor: OutputCursor,
	stderrCursor: OutputCursor,
	handlers: SoftwareUpdateOutputHandlers,
	readOutput: DetachedAptUpgradeDeps["readOutput"],
): Promise<{
	readonly stdout: OutputCursor;
	readonly stderr: OutputCursor;
	readonly complete: boolean;
}> {
	const [stdoutResult, stderrResult] = await Promise.allSettled([
		drainOutputCursor(stdoutCursor, readOutput),
		drainOutputCursor(stderrCursor, readOutput),
	]);
	if (stdoutResult.status === "rejected") {
		reportObserverError(handlers, stdoutResult.reason);
	}
	if (stderrResult.status === "rejected") {
		reportObserverError(handlers, stderrResult.reason);
	}
	return {
		stdout:
			stdoutResult.status === "fulfilled" ? stdoutResult.value : stdoutCursor,
		stderr:
			stderrResult.status === "fulfilled" ? stderrResult.value : stderrCursor,
		complete:
			stdoutResult.status === "fulfilled" &&
			stderrResult.status === "fulfilled",
	};
}

function createOutputCursors(
	paths: SoftwareUpdateOutputPaths,
	handlers: SoftwareUpdateOutputHandlers,
): readonly [OutputCursor, OutputCursor] {
	return [
		{
			path: paths.stdout,
			offset: 0,
			decoder: new TextDecoder(),
			emit: handlers.onStdout,
		},
		{
			path: paths.stderr,
			offset: 0,
			decoder: new TextDecoder(),
			emit: handlers.onStderr,
		},
	];
}

async function observeDetachedAptUpgrade(
	initialState: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<number> {
	let state: DetachedAptServiceState = initialState;
	let [stdoutCursor, stderrCursor] = createOutputCursors(
		deps.outputPaths,
		handlers,
	);
	let inspectRetryMs = 1_000;
	let lastInspectReportAt = -Infinity;
	let suppressedInspectErrors = 0;

	while (state.kind === "running") {
		const drained = await drainAvailableOutput(
			stdoutCursor,
			stderrCursor,
			handlers,
			deps.readOutput,
		);
		stdoutCursor = drained.stdout;
		stderrCursor = drained.stderr;
		await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		try {
			state = await deps.inspect();
		} catch (error) {
			const now = deps.now?.() ?? Date.now();
			if (now - lastInspectReportAt >= INSPECT_RETRY_MAX_MS) {
				handlers.onObserverError?.(error, suppressedInspectErrors);
				lastInspectReportAt = now;
				suppressedInspectErrors = 0;
			} else {
				suppressedInspectErrors++;
			}
			await deps.sleep(inspectRetryMs);
			inspectRetryMs = Math.min(inspectRetryMs * 2, INSPECT_RETRY_MAX_MS);
			continue;
		}
		inspectRetryMs = 1_000;
		lastInspectReportAt = -Infinity;
		suppressedInspectErrors = 0;
		if (state.kind === "absent") throw new DetachedAptServiceVanishedError();
	}
	if (state.kind !== "finished") throw new DetachedAptServiceVanishedError();

	let finalDrainComplete = false;
	let finalDrainFailures = 0;
	while (!finalDrainComplete) {
		const before = [stdoutCursor.offset, stderrCursor.offset];
		const drained = await drainAvailableOutput(
			stdoutCursor,
			stderrCursor,
			handlers,
			deps.readOutput,
		);
		stdoutCursor = drained.stdout;
		stderrCursor = drained.stderr;
		// Each read is one bounded block: the files are drained once they give nothing more.
		finalDrainComplete =
			drained.complete &&
			stdoutCursor.offset === before[0] &&
			stderrCursor.offset === before[1];
		if (drained.complete) continue;
		if (!finalDrainComplete) {
			finalDrainFailures++;
			if (finalDrainFailures >= FINAL_DRAIN_MAX_FAILURES) {
				throw new DetachedAptOutputUnavailableError();
			}
			await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
	const stdoutTail = stdoutCursor.decoder.decode();
	if (stdoutTail.length > 0) handlers.onStdout(stdoutTail);
	const stderrTail = stderrCursor.decoder.decode();
	if (stderrTail.length > 0) handlers.onStderr(stderrTail);
	try {
		await deps.cleanup(state);
	} catch (error) {
		throw new DetachedAptServiceCleanupError(state.exitCode, error);
	}
	await reportPinnedAfterCleanup(handlers, deps);
	return state.exitCode;
}

const submitDirectly = <T>(launch: () => Promise<T>): Promise<T> => launch();
// Read-only and best effort: it never changes the transaction's result.
async function reportPinnedAfterCleanup(
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<void> {
	if (!handlers.onUnitPinned) return;
	try {
		for (let read = 1; ; read++) {
			const state = await deps.inspect();
			if (state.kind !== "absent" || !state.loaded) return;
			if (read === PINNED_READS) break;
			await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	} catch {
		// No answer is no proof that the name is free: the next start asks again.
	}
	handlers.onUnitPinned();
}

export async function runDetachedAptUpgrade(
	aptArgs: readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<number> {
	const existing = await deps.inspect();
	if (existing.kind !== "absent") {
		throw new DetachedAptServiceAlreadyExistsError();
	}
	if (existing.loaded) {
		handlers.onUnitPinned?.();
		throw new DetachedAptServicePinnedError();
	}
	await deps.prepareOutput();
	const command = buildDetachedAptUpgradeCommand(aptArgs, deps.outputPaths);
	await (handlers.submit ?? submitDirectly)(() => deps.start(command));
	handlers.onLaunched?.();
	return observeDetachedAptUpgrade({ kind: "running" }, handlers, deps);
}

export async function runDetachedAptAll(
	installArgs: readonly string[],
	verdict: "any" | "force_ipv4" | "force_ipv6",
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<number> {
	const existing = await deps.inspect();
	if (existing.kind !== "absent")
		throw new DetachedAptServiceAlreadyExistsError();
	if (existing.loaded) {
		handlers.onUnitPinned?.();
		throw new DetachedAptServicePinnedError();
	}
	await deps.prepareOutput();
	const command = buildDetachedAptAllCommand(
		installArgs,
		verdict,
		deps.outputPaths,
	);
	// The submission is one step: nothing may come between `systemd-run` and
	// what its result is taken for. It rejects only when no unit was submitted.
	const state = await (handlers.submit ?? submitDirectly)(
		async (): Promise<
			Exclude<DetachedAptServiceState, { readonly kind: "absent" }>
		> => {
			try {
				await deps.start(command);
				return { kind: "running" };
			} catch (error) {
				// Refused before it was started (its install has ended): no unit.
				if (isOwnerEnded(error)) throw error;
				// A client error or timeout does not say PID 1 refused the unit. On
				// an image with its own apt source, look for the fixed unit before
				// calling it refused: found, or unknowable, the transaction is the
				// unit's.
				if (!imageAptSourceInUse()) throw error;
				let found: DetachedAptServiceState;
				try {
					found = await deps.inspect();
				} catch (unreadable) {
					if (isOwnerEnded(unreadable)) throw unreadable;
					found = { kind: "running" };
				}
				if (found.kind === "absent") throw error;
				return found;
			}
		},
	);
	handlers.onLaunched?.();
	return observeDetachedAptUpgrade(state, handlers, deps);
}

export async function recoverDetachedAptUpgrade(
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<RecoveredDetachedAptUpgrade | null> {
	const state = await deps.inspect();
	if (state.kind === "absent") {
		if (state.loaded) handlers.onUnitPinned?.();
		return null;
	}
	handlers.onAttached?.();
	return {
		completion: observeDetachedAptUpgrade(state, handlers, deps),
		wasAlreadyFinished: state.kind === "finished",
	};
}
