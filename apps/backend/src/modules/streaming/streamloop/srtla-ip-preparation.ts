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

import { isIP } from "node:net";

// Resolving the bonded link set for a launch and publishing it, IP list plus
// bind-map sidecar, before anything is spawned.

import { isLocalIp } from "../../../helpers/ip-addresses.ts";
import { logger } from "../../../helpers/logger.ts";
import { netdevPresence } from "../../network/netdev-lifetime.ts";
import {
	wifiCarrierDownState,
	wifiCarrierLostMark,
} from "../../network/wifi-carrier-lost.ts";
import type { BondEntry } from "../bind-map.ts";
import type { BindMapPublication } from "../bind-map-writer.ts";
import {
	LINK_CARRYING_EVIDENCE_MS,
	LINK_CARRYING_SHOW_MS,
} from "../link-progress.ts";
import { buildLinkTelemetry } from "../link-telemetry.ts";
import type { LinkTelemetryMessage } from "../link-telemetry-rows.ts";
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
	/** A Wi-Fi link whose radio has lost its access point (the carrier watch). */
	readonly carrierLost?: (ifname: string) => boolean;
	/** A Wi-Fi link whose carrier is down right now, marked or not. */
	readonly carrierDown?: (ifname: string) => boolean;
	/** Interfaces the sender's telemetry shows carrying the stream right now. */
	readonly carryingIfaces?: () => ReadonlySet<string>;
	/** Wall clock for the held-row ages. */
	readonly now?: () => number;
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

/*
  A WI-FI LINK WITHOUT CARRIER CARRIES NOTHING, UNLESS NOTHING ELSE CAN.

  A radio that lost its access point keeps its netif row until the next poll,
  and the sender would keep assigning packets to it. The carrier watch marks it
  (`network/wifi-carrier-lost.ts`), and a live refresh leaves it out of the
  list for whichever receiver this bond serves (a LAN receiver's subnet subset
  included). It is left out only while another entry of the same address
  family is carrying: one that is not marked, whose carrier is not down right
  now, that the sender's own telemetry shows carrying the stream (a fresh row
  with `carrying: true`, so a link that is up but cannot reach the receiver is
  no backup), whose interface and address have been in every applied
  publication for longer than that flag's window (so its progress was made on
  the socket for this address, not on one an address change replaced), and
  that is not a CLAT translator row
  (write-time revalidation may still drop those). Without that evidence nothing
  counts as a backup. The telemetry's `carrying` is transmit progress over a
  short dwell, not a receiver acknowledgement: a backup that stops delivering
  inside that dwell while a radio loses its AP can still let the radio go, at
  the cost of one re-registration when it returns. Otherwise the list keeps those entries: an empty list, or one
  with only links the receiver cannot be reached over, would make the sender
  drop its last usable connection, and radios that lost one access point
  together usually re-associate within a second or two with their sockets
  intact. (A working CLAT backup therefore does not displace a marked radio:
  the conservative choice, as before this rule.)

  Each entry's state is read once per publication, so one refresh cannot judge
  an entry two ways.

  A launch (manual start, ingest forward without a live refresh, restoration)
  ignores marks: nothing would bring a link left out there back.
*/
function liveFor(
	ifname: string,
	read: (
		ifname: string,
	) => { readonly ifindex: number | undefined } | undefined,
): boolean {
	const state = read(ifname);
	if (state === undefined) return false;
	// State binds the netdev it was set on; an unreadable index fails open.
	return (
		state.ifindex === undefined ||
		netdevPresence.ifindex(ifname) === state.ifindex
	);
}

const liveCarrierLost = (ifname: string) =>
	liveFor(ifname, wifiCarrierLostMark);
const liveCarrierDown = (ifname: string) =>
	liveFor(ifname, wifiCarrierDownState);

/** The fresh telemetry rows that are carrying. Stale or missing: none. */
export function carryingIfacesFrom(
	telemetry: LinkTelemetryMessage | null,
): ReadonlySet<string> {
	if (!telemetry || telemetry.stale) return new Set();
	return new Set(
		telemetry.links
			.filter((row) => !row.stale && row.carrying === true)
			.map((row) => row.iface),
	);
}

/*
  How long each `iface ip` row has been in every applied publication. Telemetry
  is keyed by interface, so after an address change the interface's `carrying`
  can still describe the old socket. `carrying` means progress within
  LINK_CARRYING_SHOW_MS, over snapshots at most LINK_CARRYING_EVIDENCE_MS
  apart: once a row has been held longer than both, that progress was made
  while the sender held this address.
*/
export const SURVIVOR_ROW_AGE_MS =
	LINK_CARRYING_SHOW_MS + LINK_CARRYING_EVIDENCE_MS;
const heldSince = new Map<string, number>();

const rowKey = (entry: BondEntry) => `${entry.iface} ${entry.ip}`;

function noteApplied(
	entries: readonly BondEntry[],
	publication: BindMapPublication,
	at: number,
): void {
	// Nothing reached the sender: the record stays as it was.
	if (
		!publication.ok &&
		(publication.reason === "ips_write_failed" ||
			publication.reason === "timed_out")
	)
		return;
	const keys = new Set(entries.map(rowKey));
	for (const key of [...heldSince.keys()])
		if (!keys.has(key)) heldSince.delete(key);
	for (const key of keys) if (!heldSince.has(key)) heldSince.set(key, at);
}

export function resetHeldRowsForTest(): void {
	heldSince.clear();
}

function withoutDeafWifi(
	entries: BondEntry[],
	carrierLost: (ifname: string) => boolean,
	carrierDown: (ifname: string) => boolean,
	carryingIfaces: () => ReadonlySet<string>,
	now: number,
): BondEntry[] {
	const state = new Map(
		entries.map((entry) => [
			entry,
			{ lost: carrierLost(entry.iface), down: carrierDown(entry.iface) },
		]),
	);
	const deaf = entries.filter((entry) => state.get(entry)?.lost);
	if (deaf.length === 0) return entries;
	const family = (entry: BondEntry) => isIP(entry.ip);
	const carrying = carryingIfaces();
	const heldLongEnough = (entry: BondEntry) => {
		const since = heldSince.get(rowKey(entry));
		return since !== undefined && now - since >= SURVIVOR_ROW_AGE_MS;
	};
	const carriers = new Set(
		entries
			.filter((entry) => {
				const s = state.get(entry);
				return (
					entry.parentIface === undefined &&
					!s?.lost &&
					!s?.down &&
					carrying.has(entry.iface) &&
					heldLongEnough(entry)
				);
			})
			.map(family),
	);
	const kept = deaf.filter((entry) => !carriers.has(family(entry)));
	if (kept.length > 0) {
		logger.info("Wi-Fi links without carrier kept: no other bond link", {
			ifnames: kept.map((entry) => entry.iface),
		});
	}
	return entries.filter(
		(entry) => !state.get(entry)?.lost || kept.includes(entry),
	);
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
	const at = (deps.now ?? Date.now)();
	const local = deps.isLocal(srtlaAddr);
	const collected = local ? deps.localList(srtlaAddr) : deps.bondedList();
	const entries =
		purpose === "refresh"
			? withoutDeafWifi(
					collected,
					deps.carrierLost ?? liveCarrierLost,
					deps.carrierDown ?? liveCarrierDown,
					deps.carryingIfaces ??
						(() => carryingIfacesFrom(buildLinkTelemetry())),
					at,
				)
			: collected;
	if (purpose === "launch" && entries.length === 0) {
		throw new Error("no_available_network_connections");
	}
	const publication = await deps.writeList(
		entries,
		local ? srtlaAddr : undefined,
	);
	noteApplied(entries, publication, at);
	return publication;
}
