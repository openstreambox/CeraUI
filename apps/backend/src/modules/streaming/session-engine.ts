/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Which engine process ran the session this backend started.
 *
 * A stream lives inside the engine process. When systemd restarts cerastream
 * (a watchdog abort, a crash), the unit gets a new invocation, and the session
 * that ran in the old one cannot exist any more. The engine that comes back is
 * idle and says nothing at all, so without this record a reconcile could only
 * answer "unknown" and the session stayed unconfirmed until an operator Stop.
 *
 * The record is taken when this process's own launch commits (never for an
 * adopted session), kept while that session is unconfirmed, and dropped once
 * the lifecycle is idle. Every doubt reads as "not replaced": no record, a
 * failed or unparseable read, an engine with no process, or the same
 * invocation.
 */
import { run } from "../../helpers/run.ts";
import { ENGINE_UNIT } from "./engine-unit-state.ts";

/**
 * The engine unit's current invocation, or undefined when it has no running
 * process or the answer cannot be read.
 */
export function parseEngineInvocation(stdout: string): string | undefined {
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
	return invocation;
}

export type ReadEngineInvocation = () => Promise<string | undefined>;

export const readEngineInvocation: ReadEngineInvocation = async () => {
	try {
		return parseEngineInvocation(
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

let sessionEngine: string | undefined;

/** Record the engine invocation a just-committed launch runs in. */
export async function noteSessionEngine(
	current: () => boolean,
	read: ReadEngineInvocation = readEngineInvocation,
): Promise<void> {
	const invocation = await read();
	if (current()) sessionEngine = invocation;
}

/** The session ended (the lifecycle is idle): nothing left to compare. */
export function forgetSessionEngine(): void {
	sessionEngine = undefined;
}

/**
 * True only when this backend's own session ran in an engine invocation that
 * is no longer the unit's running one.
 */
export async function sessionEngineReplaced(
	read: ReadEngineInvocation = readEngineInvocation,
): Promise<boolean> {
	const recorded = sessionEngine;
	if (recorded === undefined) return false;
	const now = await read();
	return now !== undefined && now !== recorded && sessionEngine === recorded;
}
