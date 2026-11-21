/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Whether the streaming engine's systemd unit has no process at all. A stream
 * runs inside the engine process, so a unit without one cannot be streaming,
 * whatever its control socket says. This is the evidence that lets a backend
 * restarted beside an engine that stays down settle an inherited carrying
 * line instead of holding the marker (and with it every update) until reboot.
 */
import { run } from "../../helpers/run.ts";

export const ENGINE_UNIT = "cerastream.service";

/**
 * `systemctl show` output proves a stopped engine only when the unit is
 * known, has no main process, and is inactive, failed, or waiting to restart
 * after a crash. Anything else (running, starting, stopping, not installed
 * under this name, unparseable) proves nothing.
 */
export function parseEngineUnitStopped(stdout: string): boolean {
	const rows = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) rows.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	if (rows.get("LoadState") !== "loaded" || rows.get("MainPID") !== "0")
		return false;
	const active = rows.get("ActiveState");
	return (
		active === "inactive" ||
		active === "failed" ||
		(active === "activating" && rows.get("SubState") === "auto-restart")
	);
}

export async function engineUnitStopped(
	show: () => Promise<string> = () =>
		run(
			"systemctl",
			[
				"show",
				ENGINE_UNIT,
				"--property=LoadState,ActiveState,SubState,MainPID",
			],
			{ timeout: 3_000, maxBuffer: 4096 },
		),
): Promise<boolean> {
	try {
		return parseEngineUnitStopped(await show());
	} catch {
		return false;
	}
}
