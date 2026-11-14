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

import { isIP } from "node:net";

import { isSameSubnet } from "../../helpers/ip-addresses.ts";
import killall from "../../helpers/killall.ts";

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
	publishBondMapping,
} from "./bind-map-writer.ts";
import {
	describeBondEntry,
	isBondLinkMappable,
	setBondIdentityResolverForTest,
} from "./bond-entry.ts";
import { registerSrtlaBond } from "./link-telemetry.ts";

export { isBondLinkMappable, setBondIdentityResolverForTest };

let receiverIpv6Only = false;

export async function resolveSrtla(addr: string) {
	let srtlaAddr = addr;
	const interfaces = Object.entries(getNetworkInterfaces())
		.filter(([name, entry]) => isBondCandidate(name, entry))
		.map(([, entry]) => entry);
	const hasV4 = interfaces.some((entry) => entry.ip);
	const hasV6 = interfaces.some((entry) => entry.ipv6);

	let addrs: string[] | undefined;
	let fromCache: boolean | undefined;
	try {
		// Resolve the preferred family first; a dropped AAAA query must not hold
		// an IPv4 start open. Fall back to AAAA for an AAAA-only receiver.
		const literal = isIP(addr) !== 0;
		let res: Awaited<ReturnType<typeof dnsCacheResolve>>;
		try {
			res = await dnsCacheResolve(
				addr,
				literal ? undefined : hasV4 ? "a" : hasV6 ? "aaaa" : undefined,
			);
		} catch (error) {
			if (!hasV4 || !hasV6 || literal) throw error;
			res = await dnsCacheResolve(addr, "aaaa");
		}
		if (
			!literal &&
			hasV4 &&
			hasV6 &&
			!res.addrs.some((ip) => isIP(ip) === 4) &&
			(res.fromCache || res.addrs.length === 0)
		)
			res = await dnsCacheResolve(addr, "aaaa");
		addrs = res.addrs;
		fromCache = res.fromCache;
	} catch (_err) {
		queueUpdateGw();
		throw `Failed to resolve SRTLA addr ${addr}`;
	}

	receiverIpv6Only = addrs.length > 0 && addrs.every((ip) => ip.includes(":"));

	if (fromCache) {
		// Prefer IPv4 for compatibility when available; on a v6-only host keep
		// DNS64/native AAAA answers rather than pinning an unusable A record.
		const ipv4 = addrs.filter((ip) => !ip.includes(":"));
		const ipv6 = addrs.filter((ip) => ip.includes(":"));
		// With no bond candidate, leave admission to IP preparation. It supplies
		// the normal no-network error and still permits a local receiver path.
		const compatible =
			interfaces.length === 0
				? ipv4.length > 0
					? ipv4
					: ipv6
				: hasV4 && ipv4.length > 0
					? ipv4
					: hasV6
						? ipv6
						: [];
		const cachedAddr =
			compatible[Math.floor(Math.random() * compatible.length)];
		if (!cachedAddr) throw `No compatible cached SRTLA address for ${addr}`;
		srtlaAddr = cachedAddr;
		receiverIpv6Only = cachedAddr.includes(":");
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
		const ip = receiverIpv6Only
			? (networkInterface?.ipv6 ?? networkInterface?.ip)
			: (networkInterface?.ip ?? networkInterface?.ipv6);
		if (!networkInterface || !ip) continue;
		if (!accept(name, networkInterface)) continue;
		const entry = describeBondEntry(name, ip);
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
	const publication = await publishBondMapping(
		entries,
		defaultBindMapWriterDeps(setup.ips_file ?? "", srtlaBindMapPath()),
	);
	// Keys the telemetry registry on the ids just published, so a rendered row
	// follows its PHYSICAL device across a reload rather than a file position,
	// and keeps the legacy conn_id -> interface fallback in step with it.
	registerSrtlaBond(entries);
	lastBond = { entries: [...entries], publication };
	return publication;
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

export function getLastPublishedBond(): PublishedBond | undefined {
	return lastBond;
}

export function resetPublishedBond(): void {
	lastBond = undefined;
}

export async function setSrtlaIpList(
	entries: readonly BondEntry[],
): Promise<BindMapPublication> {
	return publishSrtlaBond(entries);
}

export function restartSrtla() {
	void killall(["-HUP", "srtla_send"]);
}
