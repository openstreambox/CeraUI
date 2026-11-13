/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  WHETHER THIS SPAWN MAY CARRY `--bind-map`, and what to tell the operator.

  THE ORDER IS THE BACKWARD-COMPATIBILITY GUARANTEE (ADR-003 §7). The capability
  probe runs BEFORE the argument vector is built, so a new CeraUI against an OLD
  sender constructs the byte-identical legacy vector — passing an unknown flag
  would make that binary exit non-zero with a usage error, which at spawn time is
  a FAILED STREAM rather than a graceful downgrade. Any probe failure at all
  (non-zero exit, unparseable JSON, timeout) is read as no support.

  The writer-side disposition is recorded on EVERY branch, mapped included,
  because two of the three branches never hand the sender a flag it could report
  on, and the third must not leave the band blank until the first telemetry frame
  lands.
*/

import { logger } from "../../helpers/logger.ts";
import {
	noteWriterBindMapReport,
	type WriterDispositionCause,
} from "./bind-map-disposition.ts";
import { announceBindMapReport } from "./bind-map-notification.ts";
import { noteSenderLaunchBond, type PublishedBond } from "./srtla.ts";
import {
	type CapabilityProbeResult,
	probeSrtlaSenderCapabilities,
} from "./srtla-capabilities.ts";

export interface BindMapSpawnDeps {
	readonly getBond: () => PublishedBond | undefined;
	/** Told when the spawn reads the bond, so a later change can be reloaded at commit. */
	readonly noteLaunch?: () => void;
	readonly probe: (execPath: string) => Promise<CapabilityProbeResult>;
	readonly announce: (
		cause: WriterDispositionCause,
		bond?: PublishedBond,
	) => void;
}

export function defaultBindMapSpawnDeps(
	getBond: () => PublishedBond | undefined,
): BindMapSpawnDeps {
	return {
		getBond,
		noteLaunch: noteSenderLaunchBond,
		probe: (execPath) => probeSrtlaSenderCapabilities(execPath),
		announce: (cause, bond) => {
			noteWriterBindMapReport(cause, bond?.entries ?? []);
			announceBindMapReport();
		},
	};
}

export async function resolveBindMapArgs(
	execPath: string,
	deps: BindMapSpawnDeps,
): Promise<string[]> {
	const bond = deps.getBond();
	deps.noteLaunch?.();

	if (bond === undefined || !bond.publication.ok) {
		if (
			bond !== undefined &&
			!bond.publication.ok &&
			bond.publication.reason === "timed_out"
		) {
			// The sender starts on whatever IP list is on disk, without a bind map.
			// The writer keeps republishing; once it lands the sender is reloaded,
			// at the latest when this launch commits.
			logger.warn(
				"SRTLA starts on an unconfirmed IP list: the newest bond did not reach disk in time",
			);
		}
		deps.announce("mapping-write-failed", bond);
		return [];
	}

	const capabilities = await deps.probe(execPath);
	if (!capabilities.bindMap) {
		deps.announce("capability-unsupported", bond);
		return [];
	}

	deps.announce("bind-map-passed", bond);
	return ["--bind-map", bond.publication.sidecarPath];
}
