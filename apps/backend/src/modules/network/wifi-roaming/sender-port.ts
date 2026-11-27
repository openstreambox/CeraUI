/**
 * The sender as the roaming observer reads it: `get_stats` mapped onto the
 * box's interfaces, and what the sender can report or do (`get_capabilities`).
 * Read-only: the client is narrowed to those two calls and `close`.
 *
 * - `poll()` fetches one `get_stats` and keeps the mapped snapshot; one read at
 *   a time, so no client is opened twice and no older reply overwrites a newer
 *   snapshot. It never throws.
 * - `at` is on the caller's clock, stamped when the reply arrived, and advances
 *   only when the sender's state moved: a reply whose per-link counters, ages
 *   and epochs all equal the previous one is the same sample again, so a sender
 *   that hangs but keeps answering looks frozen.
 * - A failed read, an unreachable sender or a reply without arrival counters
 *   gives no snapshot.
 * - The capability document is read once per connection.
 */

import {
	type ControlClient,
	createControlClient,
	type SenderStats,
} from "@ceraui/srtla-send/control";
import { controlSocketPath } from "@ceraui/srtla-send/sender";
import { logger } from "../../../helpers/logger.ts";
import {
	SRTLA_CONTROL_CONNECT_TIMEOUT_MS,
	SRTLA_LISTEN_PORT,
} from "../../streaming/constants.ts";
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
	/** Open a control-socket client, `null` when the sender is not reachable. */
	connect(): Promise<SenderReadClient | null>;
	/** Every interface and its current source addresses. */
	interfaces(): readonly RadioAddresses[];
}>;

/** What the observer can say about the sender, for the status file. */
export type SenderView = Readonly<{
	/** The last read got an answer. */
	reachable: boolean;
	/** Links report per-link arrival counters; `null` with no links. */
	arrivalReports: boolean | null;
	/** The sender offers `set_link_standby`; `null` when unknown. */
	standby: boolean | null;
}>;

export type SenderPort = Readonly<{
	poll(): Promise<void>;
	/** The latest mapped snapshot, `undefined` when there is none. */
	snapshot(): Snapshot | undefined;
	view(): SenderView;
	close(): void;
}>;

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

export function createSenderPort(deps: SenderPortDeps): SenderPort {
	let client: SenderReadClient | null = null;
	let latest: Snapshot | undefined;
	let lastPrint: string | null = null;
	let lastAt: number | null = null;
	let view: SenderView = {
		reachable: false,
		arrivalReports: null,
		standby: null,
	};

	const drop = () => {
		client?.close();
		client = null;
		latest = undefined;
		lastPrint = null;
		view = { ...view, reachable: false };
	};

	let inFlight: Promise<void> | null = null;

	const read = async () => {
		try {
			if (!client) {
				client = await deps.connect();
				if (!client) {
					latest = undefined;
					view = { reachable: false, arrivalReports: null, standby: null };
					return;
				}
				const doc = await client.getCapabilities();
				view = {
					...view,
					standby: doc?.methods
						? doc.methods.includes("set_link_standby")
						: null,
				};
			}
			const stats = await client.getStats();
			if (!stats) {
				drop();
				return;
			}
			const print = fingerprint(stats);
			const at = print === lastPrint && lastAt !== null ? lastAt : deps.now();
			lastPrint = print;
			lastAt = at;
			latest = snapshotOf(stats, deps.interfaces(), at);
			view = {
				...view,
				reachable: true,
				arrivalReports:
					stats.links.length === 0 ? null : stats.links.some(hasArrivalReports),
			};
		} catch (error) {
			logger.debug("wifi-roaming: sender read failed", { error });
			drop();
		}
	};

	return {
		poll() {
			inFlight ??= read().finally(() => {
				inFlight = null;
			});
			return inFlight;
		},
		snapshot: () => latest,
		view: () => view,
		close: drop,
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

/** The production dependencies: the sender's control socket and the registry. */
export function defaultSenderPortDeps(now: () => number): SenderPortDeps {
	return {
		now,
		connect: () =>
			createControlClient({
				socketPath: controlSocketPath(SRTLA_LISTEN_PORT),
				timeoutMs: SRTLA_CONTROL_CONNECT_TIMEOUT_MS,
			}),
		interfaces: () => interfaceAddressesOf(getNetworkInterfaces()),
	};
}
