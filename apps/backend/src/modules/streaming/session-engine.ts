/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Which engine process ran the session this backend launched.
 *
 * A stream lives inside the engine process. When systemd restarts cerastream
 * (a watchdog abort, a crash), the unit gets a new invocation, and the session
 * that ran in the old one cannot exist any more. The engine that comes back is
 * idle and says nothing at all, so without this record a reconcile could only
 * answer "unknown" and the session stayed unconfirmed until an operator Stop.
 *
 * The record comes from the Start itself: the backend reads the unit's
 * identity before it connects and again after the engine acknowledged the
 * Start, and records the invocation only when both reads name the same running
 * process, and only while that launch's session is still current (see
 * `CerastreamBackend.noteLaunchEngine`). An adopted session is never recorded.
 * It is kept while that session is unconfirmed and dropped once the lifecycle
 * is idle. Every doubt reads as "no record" or "no identity".
 */
import { run } from "../../helpers/run.ts";
import { ENGINE_UNIT } from "./engine-unit-state.ts";

/** One systemd activation of the engine unit and its running main process. */
export interface EngineIdentity {
	readonly invocation: string;
	readonly pid: string;
}

/**
 * The engine unit's current identity, or undefined when it has no running
 * process or the answer cannot be read.
 */
export function parseEngineIdentity(
	stdout: string,
): EngineIdentity | undefined {
	const rows = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) rows.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	const pid = rows.get("MainPID");
	const invocation = rows.get("InvocationID");
	if (pid === undefined || pid === "0" || !/^\d+$/.test(pid)) return undefined;
	if (invocation === undefined || !/^[0-9a-f]{32}$/.test(invocation))
		return undefined;
	return { invocation, pid };
}

export type ReadEngineIdentity = () => Promise<EngineIdentity | undefined>;

const defaultReadEngineIdentity: ReadEngineIdentity = async () => {
	try {
		return parseEngineIdentity(
			await run(
				"systemctl",
				["show", ENGINE_UNIT, "--property=InvocationID,MainPID"],
				{ timeout: 3_000, maxBuffer: 4096 },
			),
		);
	} catch {
		return undefined;
	}
};

let identityReader: ReadEngineIdentity = defaultReadEngineIdentity;

/** Test seam: replace the unit reader (`undefined` restores systemctl). */
export function setEngineIdentityReaderForTest(
	read: ReadEngineIdentity | undefined,
): void {
	identityReader = read ?? defaultReadEngineIdentity;
}

/** The engine unit's identity right now; never throws. */
export function readEngineIdentity(): Promise<EngineIdentity | undefined> {
	return identityReader().catch(() => undefined);
}

/** Two reads name the same activation and the same process. */
export function sameEngine(
	a: EngineIdentity | undefined,
	b: EngineIdentity | undefined,
): a is EngineIdentity {
	return (
		a !== undefined &&
		b !== undefined &&
		a.invocation === b.invocation &&
		a.pid === b.pid
	);
}

let sessionEngine: string | undefined;

/**
 * Record the engine invocation a just-committed launch ran in. `undefined`
 * (the Start's two reads disagreed or failed) clears any older record, so no
 * engine can later be taken for a replacement of it.
 */
export function recordSessionEngine(invocation: string | undefined): void {
	sessionEngine = invocation;
}

/** The invocation this backend's own unconfirmed session ran in, if known. */
export function recordedSessionEngine(): string | undefined {
	return sessionEngine;
}

/** The session ended (the lifecycle is idle): nothing left to compare. */
export function forgetSessionEngine(): void {
	sessionEngine = undefined;
}
