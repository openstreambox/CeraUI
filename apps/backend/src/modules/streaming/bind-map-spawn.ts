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

import {
	noteWriterBindMapReport,
	type WriterDispositionCause,
} from "./bind-map-disposition.ts";
import { announceBindMapReport } from "./bind-map-notification.ts";
import type { PublishedBond } from "./srtla.ts";
import {
	type CapabilityProbeResult,
	probeSrtlaSenderCapabilities,
} from "./srtla-capabilities.ts";

export interface BindMapSpawnDeps {
	readonly getBond: () => PublishedBond | undefined;
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

	if (bond === undefined || !bond.publication.ok) {
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

export type RequiredBindMapResolution =
	| { readonly ok: true; readonly args: string[] }
	| {
			readonly ok: false;
			readonly reason: "mapping-unavailable" | "capability-unavailable";
	  };
/** Managed cellular paths require the opt-in sender contract. A refusal never
 * returns a legacy argument vector or claims source-only links are running.
 * The caller reports the typed refusal before submitting the sender process.
 */
export async function resolveRequiredBindMapArgs(
	execPath: string,
	deps: BindMapSpawnDeps,
): Promise<RequiredBindMapResolution> {
	const before = deps.getBond();
	if (!before?.publication.ok)
		return { ok: false, reason: "mapping-unavailable" };
	let capabilities: CapabilityProbeResult;
	try {
		capabilities = await deps.probe(execPath);
	} catch {
		return { ok: false, reason: "capability-unavailable" };
	}
	if (!capabilities.bindMap || capabilities.bindMapRequired !== true)
		return { ok: false, reason: "capability-unavailable" };
	const current = deps.getBond();
	if (!current?.publication.ok)
		return { ok: false, reason: "mapping-unavailable" };
	deps.announce("bind-map-passed", current);
	return {
		ok: true,
		args: ["--bind-map", current.publication.sidecarPath, "--require-bind-map"],
	};
}
