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

import { isSameSubnet } from "../../helpers/ip-addresses.ts";
import killall from "../../helpers/killall.ts";
import { hasIsolatedCellularRecovery } from "../modems/cellular-host-recovery.ts";
import {
	captureCellularSourcePublication,
	cellularHiddenInterface,
	cellularSourceBinding,
	cellularSourceManaged,
	cellularSourceReady,
} from "../network/cellular-source-state.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	isDupIpOnly,
	type NetworkInterface,
} from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import type { BondEntry } from "./bind-map.ts";
import {
	type BindMapPublication,
	defaultBindMapWriterDeps,
	defaultSidecarPath,
} from "./bind-map-writer.ts";
import {
	describeBondEntry,
	isBondLinkMappable,
	setBondIdentityResolverForTest,
} from "./bond-entry.ts";
import { BondPublicationQueue } from "./bond-publication-queue.ts";
import {
	cellularSenderAllowsPublication,
	cellularSenderRuntime,
} from "./cellular-sender-runtime.ts";
import { getMutationBlocks } from "./lifecycle-admission.ts";
import { registerSrtlaBond } from "./link-telemetry.ts";
import { srtlaSendExec } from "./streamloop/exec-paths.ts";
import { getStreamingProcesses } from "./streamloop/process-runner.ts";

export { isBondLinkMappable, setBondIdentityResolverForTest };

const entryPermits = new WeakMap<BondEntry, () => boolean>();

export async function resolveSrtla(addr: string) {
	let srtlaAddr = addr;

	let addrs: string[] | undefined;
	let fromCache: boolean | undefined;
	try {
		const res = await dnsCacheResolve(addr, "a");
		addrs = res.addrs;
		fromCache = res.fromCache;
	} catch (_err) {
		queueUpdateGw();
		throw `Failed to resolve SRTLA addr ${addr}`;
	}

	if (fromCache) {
		const cachedAddr = addrs[Math.floor(Math.random() * addrs.length)];
		if (cachedAddr) srtlaAddr = cachedAddr;
		queueUpdateGw();
	} else {
		/* At the moment we don't check that the SRTLA connection was established before
       validating the DNS result. The caching DNS resolver checks for invalid
       results from captive portals, etc, so all results *should* be good already */
		void dnsCacheValidate(addr);
	}

	return srtlaAddr;
}

export function srtlaBindMapPath(): string {
	return setup.bind_map_file ?? defaultSidecarPath(setup.ips_file ?? "");
}

/**
 * A duplicate-IP link joins the bond ONLY when it can be described.
 *
 * Without a row the sender cannot tell it from its twin, so admitting it would
 * put a second identical line in the IP list that the legacy path silently
 * collapses — the exact silent loss this contract exists to end.
 */
function admitEntry(int: NetworkInterface, entry: BondEntry): boolean {
	return !isDupIpOnly(int) || isBondLinkMappable(entry.iface, entry.ip);
}

function collectBondEntries(
	accept: (name: string, int: NetworkInterface) => boolean,
	requireMappableDuplicate: boolean,
): BondEntry[] {
	const entries: BondEntry[] = [];
	const networkInterfaces = getNetworkInterfaces();
	for (const name in networkInterfaces) {
		const networkInterface = networkInterfaces[name];
		if (
			!networkInterface?.ip ||
			!cellularSourceReady(name, networkInterface.ip)
		)
			continue;
		if (!accept(name, networkInterface)) continue;
		const physicalEntry = describeBondEntry(name, networkInterface.ip);
		const binding = cellularSourceBinding(name);
		const entry = binding?.translated
			? { ...physicalEntry, iface: binding.device }
			: physicalEntry;
		entryPermits.set(
			entry,
			(() => {
				const observation = captureCellularSourcePublication(
						name,
						entry.ip,
						entry.iface,
					),
					managed = cellularSourceManaged(name);
				return () =>
					observation() &&
					(!managed ||
						cellularSenderAllowsPublication(
							cellularSenderRuntime(getStreamingProcesses(), srtlaSendExec),
						));
			})(),
		);
		if (requireMappableDuplicate && !admitEntry(networkInterface, entry))
			continue;
		entries.push(entry);
	}
	return entries;
}

export function genSrtlaBondEntries(): BondEntry[] {
	return collectBondEntries(isBondCandidate, false);
}

/**
 * The local-subnet variant, now equally interface-aware.
 *
 * It deliberately keeps its own membership rule — reaching a receiver on the
 * LAN is a routing question, not a bonding one, so it does not consult the
 * bond toggle — but it must still describe each link, or a same-subnet pair of
 * twins would collapse exactly as the bonded pair used to.
 */
export function genSrtlaBondEntriesForLocalIpAddress(
	ipAddress: string,
): BondEntry[] {
	return collectBondEntries(
		(_name, int) =>
			int.netmask !== undefined &&
			int.ip !== undefined &&
			isSameSubnet(ipAddress, int.ip, int.netmask),
		true,
	);
}

export function genSrtlaIpList(): string[] {
	return genSrtlaBondEntries().map((entry) => entry.ip);
}

export function genSrtlaIpListForLocalIpAddress(ipAddress: string): string[] {
	return genSrtlaBondEntriesForLocalIpAddress(ipAddress).map(
		(entry) => entry.ip,
	);
}

/**
 * Publish the IP list and its sidecar, then keep the telemetry registry in step.
 *
 * ADR-003 §5.1 publication order lives in `publishBondMapping`; the SIGHUP is
 * the caller's, because only the caller knows whether a sender is running.
 */
export async function publishSrtlaBond(
	entries: readonly BondEntry[],
): Promise<BindMapPublication> {
	return bondPublisher.publish(entries);
}
const bondPublisher = new BondPublicationQueue({
	capture: (entry) => ({
		entry: Object.freeze({ ...entry }),
		current:
			entryPermits.get(entry) ??
			(!cellularSourceManaged(entry.iface) &&
			!cellularHiddenInterface(entry.iface)
				? captureCellularSourcePublication(entry.iface, entry.ip, entry.iface)
				: () => false),
	}),
	writer: () =>
		defaultBindMapWriterDeps(setup.ips_file ?? "", srtlaBindMapPath()),
	published: (entries, publication, current, captured) => {
		for (const row of captured) entryPermits.set(row.entry, row.current);
		registerSrtlaBond(entries);
		lastBond = { entries: [...entries], publication };
		lastBondCurrent = current;
	},
});
export function drainSrtlaBondPublication(): Promise<void> {
	return bondPublisher.drain();
}
/** Restriction only: preserve the receiver's existing membership and each
 * surviving row's captured observation. Never add a new uplink during cleanup.
 */
export function restrictSrtlaBond(
	linkId: string,
	devices: readonly string[],
	owned: () => boolean,
): Promise<BindMapPublication> {
	return bondPublisher.publish(
		(lastBond?.entries ?? []).filter(
			(entry) => entry.linkId !== linkId && !devices.includes(entry.iface),
		),
		owned,
	);
}

/**
 * What the writer last put on disk.
 *
 * The spawn path needs BOTH halves: whether a usable sidecar exists (so it may
 * pass `--bind-map`) and exactly which rows were published (so it can name the
 * collision group when it may not).
 */
export interface PublishedBond {
	readonly entries: readonly BondEntry[];
	readonly publication: BindMapPublication;
}

let lastBond: PublishedBond | undefined;
let lastBondCurrent: () => boolean = () => true;

export function getLastPublishedBond(): PublishedBond | undefined {
	return lastBondCurrent() ? lastBond : undefined;
}
export function publishedBondNeedsRequiredBinding(): boolean {
	return (
		hasIsolatedCellularRecovery() ||
		getMutationBlocks().length > 0 ||
		!lastBondCurrent() ||
		!!lastBond?.entries.some(
			(entry) =>
				cellularSourceManaged(entry.iface) ||
				cellularHiddenInterface(entry.iface),
		)
	);
}

export function resetPublishedBond(): void {
	lastBond = undefined;
	lastBondCurrent = () => true;
}

export async function setSrtlaIpList(
	entries: readonly BondEntry[],
): Promise<BindMapPublication> {
	return publishSrtlaBond(entries);
}

export function restartSrtla() {
	void killall(["-HUP", "srtla_send"]);
}
