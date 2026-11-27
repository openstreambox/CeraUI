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
import { logger } from "../../../helpers/logger.ts";
import type { BondEntry } from "../bind-map.ts";
import type { BindMapPublication } from "../bind-map-writer.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
	interfacesOnSubnet,
	publishSrtlaBond,
} from "../srtla.ts";

export type SrtlaIpPreparationDeps = {
	readonly isLocal: (address: string) => boolean;
	/** Bonded links on the receiver's subnet: a subset of `bondedList`. */
	readonly localList: (address: string) => BondEntry[];
	readonly bondedList: () => BondEntry[];
	readonly writeList: (
		entries: readonly BondEntry[],
		localReceiver?: string,
	) => Promise<BindMapPublication>;
	/** Every interface on the receiver's subnet, bonded or not. */
	readonly onSubnet?: (address: string) => string[];
	readonly warn?: (message: string, meta?: Record<string, unknown>) => void;
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
	onSubnet: interfacesOnSubnet,
	warn: (message, meta) => logger.warn(message, meta),
};

/*
  WHICH LINKS A RECEIVER GETS.

  The bond is the user's: the per-link bond toggles (and every other exclusion
  `isBondCandidate` applies) decide the candidate set for every receiver.

  A private or link-local IPv4 receiver narrows that set to the bonded links on
  its subnet, because a modem cannot reach a LAN address. When no bonded link
  shares its subnet the receiver may still be routed (a venue VLAN behind the
  Wi-Fi's gateway, a host route), so it gets the whole bond, as a hostname
  resolving to the same address already does; the log says so and names any
  link on its subnet that is out of the bond. Only an empty bond refuses a
  launch.
*/
function selectReceiverLinks(
	srtlaAddr: string,
	deps: SrtlaIpPreparationDeps,
	purpose: "launch" | "refresh",
): { entries: BondEntry[]; localReceiver?: string } {
	const bonded = deps.bondedList();
	if (!deps.isLocal(srtlaAddr)) return { entries: bonded };
	const onSubnet = deps.localList(srtlaAddr);
	if (onSubnet.length > 0)
		return { entries: onSubnet, localReceiver: srtlaAddr };
	if (purpose === "launch" && bonded.length > 0) {
		const outside = (deps.onSubnet?.(srtlaAddr) ?? []).filter(
			(name) => !bonded.some((entry) => entry.iface === name),
		);
		deps.warn?.(
			`Receiver ${srtlaAddr} is a private address and no bonded link is on its subnet` +
				(outside.length > 0
					? ` (out of the bond: ${outside.join(", ")})`
					: "") +
				"; offering every bonded link in case it is routed",
			{ receiver: srtlaAddr, outsideBond: outside },
		);
	}
	return { entries: bonded };
}

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
	const { entries, localReceiver } = selectReceiverLinks(
		srtlaAddr,
		deps,
		purpose,
	);
	if (purpose === "launch" && entries.length === 0) {
		throw new Error("no_available_network_connections");
	}
	return deps.writeList(entries, localReceiver);
}
