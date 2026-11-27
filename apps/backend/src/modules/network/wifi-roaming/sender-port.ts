/**
 * The sender as the roaming observer reads it: `get_stats` mapped onto the
 * box's interfaces, and what the sender can report or do (`get_capabilities`).
 * Read-only: the client is narrowed to those two calls and `close`.
 *
 * Only the sender this backend launched is read. Its control socket lives in
 * shared temporary storage, so the port connects only while the streaming
 * module reports an owned sender (pid and start time confirmed after launch),
 * only to that sender's socket, only when the process still has that start
 * time and the socket belongs to this backend's user. When the owned sender
 * changes or goes away, the client is dropped.
 *
 * - `poll()` fetches one `get_stats`; one read at a time, never throws.
 * - `at` is on the caller's clock, stamped when the reply arrived, and advances
 *   only when the sender's state moved, so a sender that hangs but keeps
 *   answering looks frozen.
 * - A failed read, no owned sender or a reply without arrival counters gives
 *   no snapshot. Every link, with counters or not, is checked for its mapping.
 * - After `close()` nothing connects or reads again.
 */

import { lstat, readFile } from "node:fs/promises";
import {
	type ControlClient,
	createControlClient,
	type SenderLinkStats,
	type SenderStats,
} from "@ceraui/srtla-send/control";
import { logger } from "../../../helpers/logger.ts";
import {
	type OwnedSender,
	ownedSenderLifetime,
} from "../../streaming/continuity-observer.ts";
import { getNetworkInterfaces } from "../network-interfaces.ts";
import {
	hasArrivalReports,
	type RadioAddresses,
	type Snapshot,
	snapshotOf,
} from "./sender-links.ts";

/** The only sender calls the observer may make. */
export type SenderReadClient = Pick<
	ControlClient,
	"getStats" | "getCapabilities" | "close"
>;

export type SenderPortDeps = Readonly<{
	now(): number;
	/** The sender this backend launched, `null` when none runs. */
	owner(): OwnedSender | null;
	/** Open a client to `owner`'s socket, `null` when it is not that sender. */
	connect(owner: OwnedSender): Promise<SenderReadClient | null>;
	/** Every interface and its current source addresses. */
	interfaces(): readonly RadioAddresses[];
}>;

/** How every link of the last reply maps onto the interfaces. */
export type LinkMapping = Readonly<{
	/** Links that leave from no known interface. */
	unmapped: number;
	/** Links that match two interfaces, or share an interface with another link. */
	ambiguous: number;
	/** Links without per-link arrival counters. */
	uncounted: number;
}>;

/** What the observer can say about the sender, for the status file. */
export type SenderView = Readonly<{
	/** The last read got an answer from the owned sender. */
	reachable: boolean;
	/** Links report per-link arrival counters; `null` with no links. */
	arrivalReports: boolean | null;
	/** The sender offers `set_link_standby`; `null` when unknown. */
	standby: boolean | null;
	/** The last reply's link mapping; `null` without a reply. */
	mapping: LinkMapping | null;
}>;

export type SenderPort = Readonly<{
	poll(): Promise<void>;
	/** The latest mapped snapshot, `undefined` when there is none. */
	snapshot(): Snapshot | undefined;
	view(): SenderView;
	close(): void;
}>;

const UNKNOWN: SenderView = {
	reachable: false,
	arrivalReports: null,
	standby: null,
	mapping: null,
};

/** What makes two replies the same sample: every link's counters and age. */
function fingerprint(stats: SenderStats): string {
	return JSON.stringify(
		stats.links.map((l) => [
			l.conn_id,
			l.srtla_ack_epoch,
			l.data_packets_queued_total,
			l.srtla_ack_entries_total,
			l.last_srtla_ack_age_ms ?? null,
			l.connected,
			l.timed_out,
		]),
	);
}

/**
 * Map every link of a reply, with or without arrival counters, the way the
 * snapshot does (by `iface`, else by source address), and count what does not
 * map to exactly one interface of its own.
 */
export function linkMapping(
	links: readonly SenderLinkStats[],
	interfaces: readonly RadioAddresses[],
): LinkMapping {
	let unmapped = 0;
	let ambiguous = 0;
	const claims = new Map<string, number>();
	for (const link of links) {
		const owners = interfaces.filter((r) =>
			link.iface !== undefined
				? link.iface === r.ifname
				: link.ip !== undefined && r.addresses.includes(link.ip),
		);
		if (owners.length === 0) unmapped++;
		else if (owners.length > 1) ambiguous++;
		else {
			const name = (owners[0] as RadioAddresses).ifname;
			claims.set(name, (claims.get(name) ?? 0) + 1);
		}
	}
	for (const n of claims.values()) if (n > 1) ambiguous += n;
	return {
		unmapped,
		ambiguous,
		uncounted: links.filter((l) => !hasArrivalReports(l)).length,
	};
}

export function createSenderPort(deps: SenderPortDeps): SenderPort {
	let client: SenderReadClient | null = null;
	let clientLifetime: string | null = null;
	let latest: Snapshot | undefined;
	let lastPrint: string | null = null;
	let lastAt: number | null = null;
	let view: SenderView = UNKNOWN;
	let closed = false;

	const drop = () => {
		client?.close();
		client = null;
		clientLifetime = null;
		latest = undefined;
		lastPrint = null;
		view = UNKNOWN;
	};

	let inFlight: Promise<void> | null = null;

	const read = async () => {
		try {
			const owner = deps.owner();
			if (!owner) {
				drop();
				return;
			}
			if (client && clientLifetime !== owner.lifetime) drop();
			if (!client) {
				const opened = await deps.connect(owner);
				if (closed) {
					opened?.close();
					return;
				}
				if (!opened) {
					drop();
					return;
				}
				client = opened;
				clientLifetime = owner.lifetime;
				const doc = await client.getCapabilities();
				if (closed) return;
				view = {
					...view,
					standby: doc?.methods
						? doc.methods.includes("set_link_standby")
						: null,
				};
			}
			const stats = await client.getStats();
			if (closed) return;
			if (!stats) {
				drop();
				return;
			}
			const print = fingerprint(stats);
			const at = print === lastPrint && lastAt !== null ? lastAt : deps.now();
			lastPrint = print;
			lastAt = at;
			const interfaces = deps.interfaces();
			latest = snapshotOf(stats, interfaces, at);
			view = {
				...view,
				reachable: true,
				arrivalReports:
					stats.links.length === 0 ? null : stats.links.some(hasArrivalReports),
				mapping: linkMapping(stats.links, interfaces),
			};
		} catch (error) {
			logger.debug("wifi-roaming: sender read failed", { error });
			drop();
		}
	};

	return {
		poll() {
			if (closed) return Promise.resolve();
			inFlight ??= read().finally(() => {
				inFlight = null;
			});
			return inFlight;
		},
		snapshot: () => latest,
		view: () => view,
		close() {
			closed = true;
			drop();
		},
	};
}

/**
 * Each interface's source addresses as the sender's IP list writes them
 * (`ip ?? ipv6`, both kept), so a link maps to the interface it leaves from
 * and a link that maps to none is visible as such.
 */
export function interfaceAddressesOf(
	netif: Readonly<Record<string, { ip?: string; ipv6?: string } | undefined>>,
): RadioAddresses[] {
	return Object.entries(netif).map(([ifname, int]) => ({
		ifname,
		addresses: [int?.ip, int?.ipv6].filter((a): a is string => !!a),
	}));
}

/** The process start time field of `/proc/<pid>/stat`. */
export function startTimeOf(stat: string): string | undefined {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

export type OwnerCheckIo = Readonly<{
	readText(path: string): Promise<string>;
	socketOwner(path: string): Promise<{ socket: boolean; uid: number }>;
	uid(): number;
}>;

const ownerCheckIo: OwnerCheckIo = {
	readText: (path) => readFile(path, "utf8"),
	socketOwner: async (path) => {
		const st = await lstat(path);
		return { socket: st.isSocket(), uid: st.uid };
	},
	uid: () => process.getuid?.() ?? 0,
};

/**
 * The owned sender is still that process (same start time) and its socket is
 * a socket that belongs to this backend's user. Any read failing is "no".
 */
export async function isOwnedSenderSocket(
	owner: OwnedSender,
	io: OwnerCheckIo = ownerCheckIo,
): Promise<boolean> {
	try {
		const stat = await io.readText(`/proc/${owner.pid}/stat`);
		if (startTimeOf(stat) !== owner.startTime) return false;
		const sock = await io.socketOwner(owner.controlSocket);
		return sock.socket && sock.uid === io.uid();
	} catch {
		return false;
	}
}

/** The production dependencies: the owned sender's socket and the registry. */
export function defaultSenderPortDeps(
	now: () => number,
	connectTimeoutMs: number,
): SenderPortDeps {
	return {
		now,
		owner: ownedSenderLifetime,
		connect: async (owner) =>
			(await isOwnedSenderSocket(owner))
				? createControlClient({
						socketPath: owner.controlSocket,
						timeoutMs: connectTimeoutMs,
					})
				: null,
		interfaces: () => interfaceAddressesOf(getNetworkInterfaces()),
	};
}
