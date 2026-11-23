/**
 * The real `senderLinks()` and `encoderRate()` ports for the roaming
 * coordinator: the sender's `get_stats` mapped onto the radios, and the
 * encoder's applied bitrate.
 *
 * The coordinator's ports are synchronous, a sender read is not. So `poll()`
 * fetches one `get_stats` and keeps the snapshot; `senderLinks()` hands out the
 * latest one. The boot wiring calls `poll()` before each coordinator round.
 *
 * The port contract (README, "Proof and swap"):
 * - `at` is on the caller's clock (`now`, the coordinator's `ports.now()`),
 *   stamped when the reply arrived, never the sender's own time.
 * - `at` advances only when the sender's state moved: a reply whose per-link
 *   counters, ages and epochs all equal the previous one is the same sample
 *   again. A sender that hangs but keeps answering therefore looks frozen,
 *   and the coordinator pauses after 3 s without a new sample.
 * - A failed read, an unreachable sender or a reply without arrival counters
 *   is `undefined`: the coordinator pauses at once.
 *
 * Created by the boot wiring (`runtime.ts`), which polls it once per round.
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
import { getEngineBitrateStatus } from "../../streaming/engine-bitrate-status.ts";
import { getNetworkInterfaces } from "../network-interfaces.ts";
import {
	type RadioAddresses,
	type Snapshot,
	snapshotOf,
} from "./sender-links.ts";

export type SenderPortDeps = Readonly<{
	/** The coordinator's clock (`ports.now()`). */
	now(): number;
	/** Open a control-socket client, `null` when the sender is not reachable. */
	connect(): Promise<Pick<ControlClient, "getStats" | "close"> | null>;
	/** The coordinated radios and their current source addresses. */
	radios(): readonly RadioAddresses[];
	/** The encoder's applied bitrate in kbit/s, `null` when unknown. */
	appliedKbps(): number | null;
}>;

export type SenderPort = Readonly<{
	/** Fetch one `get_stats`; never throws. */
	poll(): Promise<void>;
	/** The latest mapped snapshot, `undefined` when there is none to give. */
	senderLinks(): Snapshot | undefined;
	/** What the encoder is producing, bits/s, `null` when unknown. */
	encoderRate(): number | null;
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
	let client: Pick<ControlClient, "getStats" | "close"> | null = null;
	let latest: Snapshot | undefined;
	let lastPrint: string | null = null;
	let lastAt: number | null = null;

	const drop = () => {
		client?.close();
		client = null;
		latest = undefined;
		lastPrint = null;
	};

	// One read at a time: overlapping callers share it, so no client is opened
	// twice and no older reply can overwrite a newer snapshot.
	let inFlight: Promise<void> | null = null;

	const read = async () => {
		try {
			client ??= await deps.connect();
			if (!client) {
				latest = undefined;
				return;
			}
			const stats = await client.getStats();
			if (!stats) {
				drop();
				return;
			}
			const print = fingerprint(stats);
			// The same state again is the same sample: keep its time, so a
			// sender that hangs but answers looks frozen to the coordinator.
			const at = print === lastPrint && lastAt !== null ? lastAt : deps.now();
			lastPrint = print;
			lastAt = at;
			latest = snapshotOf(stats, deps.radios(), at);
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
		senderLinks: () => latest,
		encoderRate() {
			const kbps = deps.appliedKbps();
			return kbps !== null && Number.isFinite(kbps) && kbps > 0
				? kbps * 1_000
				: null;
		},
		close: drop,
	};
}

/**
 * Each radio's source addresses as the sender's IP list writes them. The bond
 * enters a link by `ip ?? ipv6` (`isBondCandidate`), so an IPv6-only radio's
 * link carries its IPv6 address; without it that link would land in `others`
 * and count as a carrying, independent path.
 */
export function radioAddressesOf(
	netif: Readonly<Record<string, { ip?: string; ipv6?: string } | undefined>>,
	radios: readonly string[],
): RadioAddresses[] {
	return radios.map((ifname) => {
		const { ip, ipv6 } = netif[ifname] ?? {};
		return {
			ifname,
			addresses: [ip, ipv6].filter((a): a is string => !!a),
		};
	});
}

/**
 * The production dependencies: the sender's control socket, the radios'
 * current addresses from the network registry (IPv4 and IPv6), and the
 * engine's applied bitrate. `now` is the coordinator's clock.
 */
export function defaultSenderPortDeps(
	radios: () => readonly string[],
	now: () => number,
): SenderPortDeps {
	return {
		now,
		connect: () =>
			createControlClient({
				socketPath: controlSocketPath(SRTLA_LISTEN_PORT),
				timeoutMs: SRTLA_CONTROL_CONNECT_TIMEOUT_MS,
			}),
		radios: () => radioAddressesOf(getNetworkInterfaces(), radios()),
		appliedKbps: () => getEngineBitrateStatus()?.applied_kbps ?? null,
	};
}
