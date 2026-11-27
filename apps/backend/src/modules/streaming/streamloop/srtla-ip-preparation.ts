/*
    CeraUI - web UI for the CERALIVE project
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

// Resolving the bonded link set for a launch and publishing it, IP list plus
// bind-map sidecar, before anything is spawned.

import { isLocalIp } from "../../../helpers/ip-addresses.ts";
import type { BondEntry } from "../bind-map.ts";
import type { BindMapPublication } from "../bind-map-writer.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	publishSrtlaBond,
} from "../srtla.ts";

export type SrtlaIpPreparationDeps = {
	readonly isLocal: (address: string) => boolean;
	readonly localList: (address: string) => BondEntry[];
	readonly bondedList: () => BondEntry[];
	readonly writeList: (
		entries: readonly BondEntry[],
		localReceiver?: string,
	) => Promise<BindMapPublication>;
};

const defaultSrtlaIpPreparationDeps: SrtlaIpPreparationDeps = {
	isLocal: isLocalIp,
	localList: genSrtlaBondEntriesForLocalIpAddress,
	bondedList: genSrtlaBondEntries,
	writeList: (entries, localReceiver) =>
		publishSrtlaBond(
			entries,
			undefined,
			localReceiver === undefined ? undefined : { localReceiver },
		),
};

/**
 * Publish the launch or live bond. A launch requires at least one link.
 *
 * The returned publication is what tells the caller whether a SIGHUP is owed and
 * whether the spawn may carry `--bind-map`. A live refresh publishes an empty
 * set to withdraw the last link.
 */
export async function prepareSrtlaIpAddresses(
	srtlaAddr: string,
	deps: SrtlaIpPreparationDeps = defaultSrtlaIpPreparationDeps,
	purpose: "launch" | "refresh" = "launch",
): Promise<BindMapPublication> {
	const local = deps.isLocal(srtlaAddr);
	const entries = local ? deps.localList(srtlaAddr) : deps.bondedList();
	if (purpose === "launch" && entries.length === 0) {
		throw new Error("no_available_network_connections");
	}
	return deps.writeList(entries, local ? srtlaAddr : undefined);
}
