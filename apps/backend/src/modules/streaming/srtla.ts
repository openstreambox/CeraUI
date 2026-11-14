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
import type { LinkPaths } from "@ceraui/rpc/schemas";
import { isSameSubnet } from "../../helpers/ip-addresses.ts";
import killall from "../../helpers/killall.ts";
import { logger } from "../../helpers/logger.ts";
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
import { readClatPath, refreshClatStatus } from "./clat-status.ts";
import { LinkFamilySelector, type ReceiverFamilies } from "./link-family.ts";
import { describeLinkPath, setLinkPaths } from "./link-path-status.ts";
import { registerSrtlaBond } from "./link-telemetry.ts";

export { isBondLinkMappable, setBondIdentityResolverForTest };

let receiverFamilies: ReceiverFamilies | undefined;
const familySelector = new LinkFamilySelector();
const familyStatus = new Map<string, string>();
const entryPaths = new WeakMap<
	BondEntry,
	{ interface: string; status: string }
>();
let resolutionGeneration = 0;

export async function resolveSrtla(addr: string) {
	let srtlaAddr = addr;
	const generation = ++resolutionGeneration;
	const interfaces = Object.entries(getNetworkInterfaces())
		.filter(
			([name, entry]) =>
				!/^clat\d+$/.test(name) && isBondCandidate(name, entry),
		)
		.map(([, entry]) => entry);
	const hasV4 = interfaces.some((entry) => entry.ip);
	await refreshClatStatus(Object.keys(getNetworkInterfaces()));
	const hasClat = Object.keys(getNetworkInterfaces()).some((name) =>
		readClatPath(name),
	);
	const hasV6 = interfaces.some((entry) => entry.ipv6);

	let addrs: string[] | undefined;
	let fromCache: boolean | undefined;
	let emptyA = false;
	try {
		const a = dnsCacheResolve(
			addr,
			isIP(addr) ? undefined : "a",
			!isIP(addr) && hasV6,
		);
		const first = await a.catch(() => undefined);
		emptyA = Boolean(first && !first.fromCache && first.addrs.length === 0);
		if (!isIP(addr) && first?.addrs.length && !first.fromCache)
			await dnsCacheValidate(addr);
		const aaaa =
			!isIP(addr) &&
			hasV6 &&
			(!first?.fromCache || !first.addrs.some((ip) => isIP(ip) === 4))
				? dnsCacheResolve(addr, "aaaa")
				: undefined;

		void aaaa
			?.then((answer) => {
				if (generation === resolutionGeneration && !answer.fromCache)
					void dnsCacheValidate(
						addr,
						emptyA && answer.addrs.some((ip) => isIP(ip) === 6)
							? "a"
							: undefined,
					);
			})
			.catch(() => {
				/* An unavailable optional AAAA answer keeps IPv4 usable. */
			});
		const resultsPromise = Promise.allSettled(aaaa ? [a, aaaa] : [a]);
		let results: PromiseSettledResult<
			Awaited<ReturnType<typeof dnsCacheResolve>>
		>[];
		if (aaaa && hasV4) {
			if (first?.addrs.length && !first.fromCache) {
				results = [{ status: "fulfilled", value: first }];
				void aaaa
					.then((answer) => {
						if (
							generation === resolutionGeneration &&
							!answer.fromCache &&
							receiverFamilies
						)
							receiverFamilies.ipv6 = answer.addrs.some((ip) => isIP(ip) === 6);
					})
					.catch(() => {
						/* An unavailable optional AAAA answer keeps IPv4 usable. */
					});
			} else results = await resultsPromise;
		} else results = await resultsPromise;
		const answers = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		// A live family answer takes precedence over another lookup's stale cache.
		const liveAnswers = answers.filter(
			(answer) => !answer.fromCache && answer.addrs.length > 0,
		);
		const selectedAnswers = liveAnswers.length ? liveAnswers : answers;
		const res = {
			addrs: selectedAnswers.flatMap((answer) => answer.addrs),
			fromCache: liveAnswers.length === 0,
		};
		if (!res.addrs.length) throw new Error("No receiver addresses");
		addrs = res.addrs;
		fromCache = res.fromCache;
	} catch (_err) {
		queueUpdateGw();
		throw `Failed to resolve SRTLA addr ${addr}`;
	}

	receiverFamilies = {
		ipv4: addrs.some((ip) => isIP(ip) === 4),
		ipv6: addrs.some((ip) => isIP(ip) === 6),
	};
	familySelector.reset();
	familyStatus.clear();
	setLinkPaths({});

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
				: (hasV4 || hasClat) && ipv4.length > 0
					? ipv4
					: hasV6
						? ipv6
						: [];
		const cachedAddr =
			compatible[Math.floor(Math.random() * compatible.length)];
		if (!cachedAddr) throw `No compatible cached SRTLA address for ${addr}`;
		srtlaAddr = cachedAddr;
		receiverFamilies = {
			ipv4: isIP(cachedAddr) === 4,
			ipv6: isIP(cachedAddr) === 6,
		};
		queueUpdateGw();
	} else {
		/* At the moment we don't check that the SRTLA connection was established before
       validating the DNS result. The caching DNS resolver checks for invalid
       results from captive portals, etc, so all results *should* be good already */
		void dnsCacheValidate(
			addr,
			emptyA && addrs.some((ip) => isIP(ip) === 6) ? "a" : undefined,
		);
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
	publishPaths: boolean,
): BondEntry[] {
	const entries: BondEntry[] = [];
	const paths: LinkPaths = {};
	const networkInterfaces = getNetworkInterfaces();
	familySelector.retainInterfaces(Object.keys(networkInterfaces));
	for (const name in networkInterfaces) {
		const networkInterface = networkInterfaces[name];
		if (
			!networkInterface ||
			/^clat\d+$/.test(name) ||
			!accept(name, networkInterface)
		)
			continue;
		const clat = receiverFamilies ? readClatPath(name) : undefined;
		const path = receiverFamilies
			? familySelector.choose(
					name,
					networkInterface,
					receiverFamilies,
					clat,
					Date.now(),
				)
			: undefined;
		const ip = receiverFamilies
			? path?.ip
			: (networkInterface.ip ?? networkInterface.ipv6);
		paths[name] = describeLinkPath(
			networkInterface,
			receiverFamilies,
			path,
			clat,
		);
		if (!ip) continue;
		const entry = {
			...describeBondEntry(name, ip),
			...(path ? { iface: path.iface } : {}),
		};
		if (requireMappableDuplicate && !admitEntry(networkInterface, entry)) {
			paths[name] = "unknown";
			continue;
		}
		entryPaths.set(entry, {
			interface: name,
			status:
				path?.mode === "clat"
					? "IPv4 via translation"
					: isIP(ip) === 6
						? "Native IPv6"
						: "Native IPv4",
		});
		entries.push(entry);
	}
	if (publishPaths) setLinkPaths(paths);
	return entries;
}

export function genSrtlaBondEntries(publishPaths = false): BondEntry[] {
	return collectBondEntries(isBondCandidate, false, publishPaths);
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
	publishPaths = false,
): BondEntry[] {
	return collectBondEntries(
		(_name, int) =>
			int.netmask !== undefined &&
			int.ip !== undefined &&
			isSameSubnet(ipAddress, int.ip, int.netmask),
		true,
		publishPaths,
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
	const next = new Map(
		entries.map((entry) => {
			const path = entryPaths.get(entry);
			return [
				path?.interface ?? entry.iface,
				path?.status ?? (isIP(entry.ip) === 6 ? "Native IPv6" : "Native IPv4"),
			];
		}),
	);
	for (const [name, status] of next)
		if (familyStatus.get(name) !== status)
			logger.info("Stream link path", { interface: name, status });
	for (const name of familyStatus.keys())
		if (!next.has(name))
			logger.info("Stream link path", {
				interface: name,
				status: "Unavailable",
			});
	familyStatus.clear();
	for (const [name, status] of next) familyStatus.set(name, status);
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
