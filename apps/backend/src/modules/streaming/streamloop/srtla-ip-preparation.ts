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
	getLastPublishedBond,
	publishSrtlaBond,
} from "../srtla.ts";

export type SrtlaIpPreparationDeps = {
	readonly isLocal: (address: string) => boolean;
	readonly localList: (address: string) => BondEntry[];
	readonly bondedList: () => BondEntry[];
	readonly writeList: (
		entries: readonly BondEntry[],
	) => Promise<BindMapPublication>;
	/** Actual committed rows, which may shrink while publication is queued. */
	readonly publishedEntries?: () => readonly BondEntry[] | undefined;
};

const defaultSrtlaIpPreparationDeps: SrtlaIpPreparationDeps = {
	isLocal: isLocalIp,
	localList: genSrtlaBondEntriesForLocalIpAddress,
	bondedList: genSrtlaBondEntries,
	writeList: publishSrtlaBond,
	publishedEntries: () => getLastPublishedBond()?.entries,
};

/**
 * Publish the bond for a launch, and refuse the launch when there is none.
 *
 * The returned publication is what tells the caller whether a SIGHUP is owed and
 * whether the spawn may carry `--bind-map`; a bond with no links throws before
 * anything reaches disk.
 */
export async function prepareSrtlaIpAddresses(
	srtlaAddr: string,
	deps: SrtlaIpPreparationDeps = defaultSrtlaIpPreparationDeps,
): Promise<BindMapPublication> {
	const entries = deps.isLocal(srtlaAddr)
		? deps.localList(srtlaAddr)
		: deps.bondedList();
	if (entries.length === 0) {
		throw new Error("no_available_network_connections");
	}
	const publication = await deps.writeList(entries);
	if (deps.publishedEntries && !deps.publishedEntries()?.length)
		throw new Error("no_available_network_connections");
	return publication;
}

/** A running sender must receive a valid empty mapping when the final uplink
 * withdraws. Only launch preparation rejects an empty bond before publication.
 */
export async function refreshSrtlaIpAddresses(
	srtlaAddr: string,
	deps: SrtlaIpPreparationDeps = defaultSrtlaIpPreparationDeps,
): Promise<BindMapPublication> {
	return deps.writeList(
		deps.isLocal(srtlaAddr) ? deps.localList(srtlaAddr) : deps.bondedList(),
	);
}
