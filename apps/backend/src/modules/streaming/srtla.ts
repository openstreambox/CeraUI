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

import { logger } from "../../helpers/logger.ts";

import { readClatTranslations } from "../network/clat-translation.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	isBondIdentityPending,
	isDupIpOnly,
	type NetworkInterface,
} from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import type { BondEntry } from "./bind-map.ts";
import {
	type BindMapPublication,
	type BindMapWriterDeps,
	defaultBindMapWriterDeps,
	defaultSidecarPath,
	invalidateBindMapReuse,
	publishBondMapping,
} from "./bind-map-writer.ts";
import {
	describeBondEntry,
	isBondLinkMappable,
	setBondIdentityResolverForTest,
} from "./bond-entry.ts";
import { registerSrtlaBond } from "./link-telemetry.ts";
import { signalSenders } from "./streamloop/process-runner.ts";

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
	let emptyA = false;
	try {
		// Resolve the preferred family first; a dropped AAAA query must not hold
		// an IPv4 start open. Fall back to AAAA for an AAAA-only receiver.
		const literal = isIP(addr) !== 0;
		const aaaaFallback = !literal && hasV4 && hasV6;
		let res: Awaited<ReturnType<typeof dnsCacheResolve>>;
		try {
			res = await dnsCacheResolve(
				addr,
				literal ? undefined : hasV4 ? "a" : hasV6 ? "aaaa" : undefined,
				aaaaFallback,
			);
		} catch (error) {
			if (!aaaaFallback) throw error;
			res = await dnsCacheResolve(addr, "aaaa");
		}
		if (
			aaaaFallback &&
			!res.addrs.some((ip) => isIP(ip) === 4) &&
			(res.fromCache || res.addrs.length === 0)
		) {
			// A lost A keeps cached IPv4. Only a validated empty A can retire
			// it, together with the fresh AAAA answer in one cache update.
			emptyA = !res.fromCache && res.addrs.length === 0;
			res = await dnsCacheResolve(addr, "aaaa");
		}
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
): BondEntry[] {
	const entries: BondEntry[] = [];
	const networkInterfaces = getNetworkInterfaces();
	for (const name in networkInterfaces) {
		const networkInterface = networkInterfaces[name];
		const ip = receiverIpv6Only
			? (networkInterface?.ipv6 ?? networkInterface?.ip)
			: (networkInterface?.ip ?? networkInterface?.ipv6);
		if (!networkInterface || !ip) continue;
		if (isBondIdentityPending(name, networkInterface)) continue;
		if (!accept(name, networkInterface)) continue;
		const entry = describeBondEntry(name, ip);
		if (requireMappableDuplicate && !admitEntry(networkInterface, entry))
			continue;
		entries.push(entry);
	}
	return oneEntryPerTranslatedModem(entries);
}

/*
  ONE BOND ENTRY PER MODEM WHILE ITS IPV6-ONLY BEARER IS TRANSLATED.

  An IPv6-only modem with a live CLAT translation shows up twice: the parent
  with its native IPv6 address and the `clat<N>` TUN with the translator's
  IPv4. Both resolve to the same physical modem and so to the same `linkId`.
  Offering both gives the sender two rows with one id, which it rejects
  (falling back to unique source addresses), and an uplink whose family can
  never reach the receiver. Exactly one of them can carry the stream:

  - an IPv6-only receiver: the parent's native IPv6;
  - an IPv4 receiver: the parent's native IPv4 if it has one (it wins on the
    modem's UI row too), otherwise the translator.

  A TUN entry carries `parentIface` only while its translation is usable, so a
  withdrawn or expired translation leaves the parent as it was.
*/
function oneEntryPerTranslatedModem(entries: BondEntry[]): BondEntry[] {
	const parents = new Set(
		entries.flatMap((entry) =>
			entry.parentIface === undefined ? [] : [entry.parentIface],
		),
	);
	if (parents.size === 0) return entries;
	const nativeIpv4 = new Set(
		entries
			.filter((entry) => parents.has(entry.iface) && isIP(entry.ip) === 4)
			.map((entry) => entry.iface),
	);
	return entries.filter((entry) => {
		if (entry.parentIface !== undefined)
			return !receiverIpv6Only && !nativeIpv4.has(entry.parentIface);
		if (!parents.has(entry.iface)) return true;
		return receiverIpv6Only || nativeIpv4.has(entry.iface);
	});
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

export interface SrtlaReloadOptions {
	/** Whether a stream is live right now; a failed reload is re-sent only then. */
	readonly isStreaming?: () => Promise<boolean>;
	/** Pause before the one re-signal of a failed reload. */
	readonly retryDelayMs?: number;
	/** How long one delivery may take before it counts as failed. */
	readonly deliveryDeadlineMs?: number;
}

export interface SrtlaPublishOptions extends SrtlaReloadOptions {
	/** Requests the reload that a writer-started republication owes. */
	readonly reload?: (publication: BindMapPublication) => Promise<unknown>;
	/** Keys the telemetry registry on published rows (tests inject it). */
	readonly registerBond?: (entries: readonly BondEntry[]) => void;
}

// Loaded lazily: streaming.ts imports this module.
const isStreamingNow = async () =>
	(await import("./streaming.ts")).getIsStreaming();

/** Recheck the producer and topology immediately before a queued write. */
export async function revalidateClatBondEntries(
	entries: readonly BondEntry[],
	read: typeof readClatTranslations = readClatTranslations,
): Promise<readonly BondEntry[]> {
	if (!entries.some((e) => e.clatGeneration !== undefined)) return entries;
	let fresh: Awaited<ReturnType<typeof readClatTranslations>>;
	try {
		fresh = await read();
	} catch {
		fresh = new Map();
	}
	return entries.filter((e) => {
		if (e.clatGeneration === undefined) return true;
		const live = fresh.get(e.iface);
		const int = getNetworkInterfaces()[e.iface];
		return (
			live?.generation === e.clatGeneration &&
			live.ipv4 === e.ip &&
			describeBondEntry(e.iface, e.ip, false).linkId === e.linkId &&
			int !== undefined &&
			isBondCandidate(e.iface, int)
		);
	});
}

/**
 * Publish the IP list and its sidecar, then keep the telemetry registry in step.
 *
 * ADR-003 §5.1 publication order lives in `publishBondMapping`; the SIGHUP is
 * the caller's, because only the caller knows whether a sender is running.
 * The one exception is a republication the writer starts itself while the
 * files on disk are stale (after a stuck or failed write): no caller waits on
 * it, so it requests its own reload while streaming. A launch that is not yet
 * marked streaming gets that reload when it commits (`reloadOwedAtLaunchCommit`).
 *
 * The bond record and the telemetry registry are updated inside the writer's
 * queue, from the snapshot that was actually written, so they follow
 * publication order for every caller, including callers whose submission was
 * superseded before it ran.
 */
export async function publishSrtlaBond(
	entries: readonly BondEntry[],
	writerDeps: BindMapWriterDeps = defaultBindMapWriterDeps(
		setup.ips_file ?? "",
		srtlaBindMapPath(),
	),
	options: SrtlaPublishOptions = {},
): Promise<BindMapPublication> {
	return publishBondMapping(entries, {
		...writerDeps,
		prepareEntries: async (submitted) => {
			const prepared =
				(await writerDeps.prepareEntries?.(submitted)) ?? submitted;
			return revalidateClatBondEntries(prepared);
		},
		onSettled: (published, publication, origin) => {
			writerDeps.onSettled?.(published, publication, origin);
			// Keys the telemetry registry on the ids just published, so a rendered row
			// follows its PHYSICAL device across a reload rather than a file position,
			// and keeps the legacy conn_id -> interface fallback in step with it.
			// Only rows whose IP list reached disk: after a timeout or a failed IP
			// write the sender still reads the previous list.
			if (wroteIpList(publication)) {
				(options.registerBond ?? registerSrtlaBond)(published);
			}
			lastBond = { entries: [...published], publication };
			if (wroteIpList(publication) && publication.changed)
				publicationSequence += 1;
			if (
				origin.republished &&
				wroteIpList(publication) &&
				publication.changed
			) {
				void reloadIfStreaming(publication, options);
			}
		},
	});
}

const wroteIpList = (publication: BindMapPublication) =>
	publication.ok ||
	publication.reason === "unmappable" ||
	publication.reason === "sidecar_write_failed";

/**
 * Counts publications that owe the sender a reload. A launch notes the count
 * when its spawn reads the bond; if it moved by the time the launch commits as
 * streaming, the reload that every publication in between skipped (nothing was
 * streaming yet) is delivered then.
 */
let publicationSequence = 0;
let launchSequence: number | undefined;

/** The spawn is reading the published bond now. */
export function noteSenderLaunchBond(): void {
	launchSequence = publicationSequence;
}

/**
 * Called once a launch commits as streaming: deliver the reload owed to
 * publications that settled after its spawn read the bond. Their callers, and
 * the writer's own republications, skipped the reload because the stream was
 * not marked streaming yet. Answers whether a reload was delivered.
 */
export async function reloadOwedAtLaunchCommit(
	current: () => boolean,
	/** Defaults to `restartSrtla`'s own delivery. */
	deliver?: () => Promise<boolean>,
	options: SrtlaReloadOptions = {},
): Promise<boolean> {
	if (launchSequence === undefined || launchSequence === publicationSequence)
		return false;
	if (!current()) return false;
	logger.info(
		"SRTLA bond changed while the stream was starting; reloading the sender",
		{ publications: publicationSequence - launchSequence },
	);
	launchSequence = publicationSequence;
	return restartSrtla(deliver, options);
}

async function reloadIfStreaming(
	publication: BindMapPublication,
	options: SrtlaPublishOptions,
): Promise<void> {
	try {
		if (!(await (options.isStreaming ?? isStreamingNow)())) return;
		await (options.reload ?? (() => restartSrtla(undefined, options)))(
			publication,
		);
	} catch (error) {
		logger.warn("SRTLA reload after republication failed", { error });
	}
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

/** Pause before the one re-signal of a failed reload. */
export const SRTLA_RELOAD_RETRY_DELAY_MS = 1_000;

/** A delivery that has not answered after this long counts as failed, so one
 * stuck signaller cannot hold every later reload behind it. */
export const SRTLA_RELOAD_DELIVERY_DEADLINE_MS = 5_000;

/** Deliver through the supervised sender handles. */
const signalSupervisedSenders = supervisedSenderDelivery(() =>
	signalSenders("SIGHUP"),
);

/**
 * Delivery from a count of supervised senders that received the signal.
 *
 * This is the seam a reload by tracked process handle plugs into
 * (`supervisedSenderDelivery(() => signalSenders("SIGHUP"))`): delivered means
 * at least one supervised sender received SIGHUP. A count of zero, or a throw,
 * is a failed delivery and invalidates reuse like any other.
 */
export function supervisedSenderDelivery(
	signalSupervised: () => number,
): () => Promise<boolean> {
	return async () => signalSupervised() > 0;
}

interface ReloadRequest {
	deliver: () => Promise<boolean>;
	options: SrtlaReloadOptions;
	readonly result: ReturnType<typeof Promise.withResolvers<boolean>>;
}

let reloadSession = 0;
let reloadInFlight = false;
let reloadFollowUp: ReloadRequest | undefined;

/** Drop reload coordination state (test isolation). */
export function resetSrtlaReloadForTest(): void {
	reloadSession += 1;
	reloadInFlight = false;
	reloadFollowUp = undefined;
	publicationSequence = 0;
	launchSequence = undefined;
}

/**
 * Ask the sender to reload its IP list and bind map (SIGHUP), and say whether
 * the signal was delivered. Delivered is not applied: only the sender's
 * applied receipt proves that.
 *
 * One delivery runs at a time. Requests made while one is in flight share a
 * single follow-up delivery, because the in-flight signal may predate the
 * publication that requested the next one. A failed delivery invalidates
 * no-op reuse, so the next publication reloads, and is re-sent once while the
 * stream is still live: a publication made during the failed delivery may
 * have been a no-op that requested nothing.
 */
export function restartSrtla(
	deliver: () => Promise<boolean> = signalSupervisedSenders,
	options: SrtlaReloadOptions = {},
): Promise<boolean> {
	if (!reloadInFlight) return runReload(deliver, options);
	if (reloadFollowUp === undefined) {
		reloadFollowUp = {
			deliver,
			options,
			result: Promise.withResolvers<boolean>(),
		};
	} else {
		reloadFollowUp.deliver = deliver;
		reloadFollowUp.options = options;
	}
	return reloadFollowUp.result.promise;
}

let reloadObserver: ((delivered: Promise<boolean>) => void) | undefined;
export function observeSenderReload(
	observer: (delivered: Promise<boolean>) => void,
): () => void {
	reloadObserver = observer;
	return () => {
		if (reloadObserver === observer) reloadObserver = undefined;
	};
}

function runReload(
	deliver: () => Promise<boolean>,
	options: SrtlaReloadOptions,
): Promise<boolean> {
	reloadInFlight = true;
	const session = reloadSession;
	const run = reloadWithOneRetry(deliver, options);
	reloadObserver?.(run);
	void run.then(() => {
		if (session !== reloadSession) return;
		reloadInFlight = false;
		const next = reloadFollowUp;
		reloadFollowUp = undefined;
		if (next !== undefined) {
			void runReload(next.deliver, next.options).then(next.result.resolve);
		}
	});
	return run;
}

async function deliverOnce(
	deliver: () => Promise<boolean>,
	options: SrtlaReloadOptions,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<false>((resolve) => {
		timer = setTimeout(
			() => resolve(false),
			options.deliveryDeadlineMs ?? SRTLA_RELOAD_DELIVERY_DEADLINE_MS,
		);
	});
	try {
		/* Unknown or late delivery is not success. */
		const delivered = (await Promise.race([deliver(), deadline])) === true;
		logger.info("SRTLA reload signal result", { delivered });
		return delivered;
	} catch (error) {
		logger.error("SRTLA reload signal failed", { error });
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function mayResignal(options: SrtlaReloadOptions): Promise<boolean> {
	// A follow-up already queued delivers after this one; it is the retry.
	if (reloadFollowUp !== undefined) return false;
	try {
		return await (options.isStreaming ?? isStreamingNow)();
	} catch {
		return false;
	}
}

async function reloadWithOneRetry(
	deliver: () => Promise<boolean>,
	options: SrtlaReloadOptions,
): Promise<boolean> {
	if (await deliverOnce(deliver, options)) return true;
	invalidateBindMapReuse();
	if (await mayResignal(options)) {
		const delay = options.retryDelayMs ?? SRTLA_RELOAD_RETRY_DELAY_MS;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		if (await mayResignal(options)) {
			logger.warn("SRTLA reload delivery failed; signalling once more");
			if (await deliverOnce(deliver, options)) return true;
		}
	}
	logger.warn("SRTLA reload delivery failed; next publication must reload");
	return false;
}
