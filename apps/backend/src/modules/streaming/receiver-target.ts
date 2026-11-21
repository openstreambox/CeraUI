/*
  One receiver address for the whole bond, and only one that answers.

  A receiver name can resolve to several addresses: a round-robin pool, a
  move between hosts, or a stale record left behind. Handing the sender the
  bare name lets it pick an answer on its own: the shipped sender takes the
  first answer per link, so a dead first answer means the bond never registers,
  and a resolver that rotates its answers splits the links across hosts. Once
  registered, neither the shipped sender nor upstream moves a bond off an
  address the name still lists, so a dead first answer stays an outage until
  the session is restarted onto another address.

  At each stream start (operator Start, autostart, restoration, automatic
  restart) the device therefore asks every compatible answer whether a bonding
  receiver is there, over every bond uplink, and hands the sender the first
  answer in DNS order that replied. Every link then dials that one address.

  The question is the sender's own pre-registration probe: a REG2 carrying a
  random group id. A bonding receiver answers that it has no such group
  (REG_NGP) and keeps no state; it needs no credentials and opens no session.
  Any registration reply from the probed address counts. Silence until the
  deadline is "not answering", never "down": a lost reply on a busy uplink
  looks the same.

  The probe never decides alone that the receiver is unreachable. When nothing
  answers (every uplink offline, a receiver that is still booting, a filtered
  network), the caller keeps its previous behaviour: the name for a live
  answer, a random cached address after a failed lookup. A single compatible
  answer is never probed, because there is nothing to choose.
*/

import { createSocket } from "node:dgram";
import { isIP } from "node:net";

import { logger } from "../../helpers/logger.ts";

export const SRTLA_TYPE_REG2 = 0x9201;
export const SRTLA_TYPE_REG3 = 0x9202;
export const SRTLA_TYPE_REG_ERR = 0x9210;
export const SRTLA_TYPE_REG_NGP = 0x9211;
export const SRTLA_TYPE_REG_NAK = 0x9212;
export const SRTLA_ID_LEN = 256;

/**
 * How long a start waits for receivers that have not answered yet. The start
 * returns as soon as the first answer in DNS order replies, so a healthy
 * first receiver costs one round trip; only a silent first answer costs the
 * whole deadline.
 */
export const RECEIVER_PROBE_DEADLINE_MS = 1_200;
/** A second REG2 this long after the first covers one lost packet. */
export const RECEIVER_PROBE_RESEND_MS = 400;

/** A REG2 with a fresh random group id that no receiver knows. */
export function receiverProbePacket(): Uint8Array {
	const packet = new Uint8Array(2 + SRTLA_ID_LEN);
	packet[0] = SRTLA_TYPE_REG2 >> 8;
	packet[1] = SRTLA_TYPE_REG2 & 0xff;
	crypto.getRandomValues(packet.subarray(2));
	return packet;
}

/**
 * What a bonding receiver sends back to a REG2 for a group it does not know:
 * a bare 2-byte REG_NGP, or REG_ERR / REG_NAK. An echo of the REG2 itself, or
 * anything longer, is not an answer.
 */
export function isReceiverProbeReply(message: Uint8Array): boolean {
	const [high, low] = message;
	if (message.length !== 2 || high === undefined || low === undefined)
		return false;
	const type = (high << 8) | low;
	return (
		type === SRTLA_TYPE_REG_NGP ||
		type === SRTLA_TYPE_REG_ERR ||
		type === SRTLA_TYPE_REG_NAK
	);
}

/** Canonical text form, so equivalent IPv6 spellings compare equal. */
export function canonicalIp(ip: string): string {
	if (isIP(ip) !== 6) return ip;
	try {
		return new URL(`udp://[${ip}]/`).hostname;
	} catch {
		return ip;
	}
}

/**
 * Ask one receiver address over one uplink. `source` undefined lets the kernel
 * pick the route (no bond uplink of that family). Resolves true on a
 * registration reply from that address, false on silence, a send error or
 * `signal` aborting; never rejects.
 */
export type ReceiverProbe = (request: {
	readonly address: string;
	readonly port: number;
	readonly source: string | undefined;
	readonly signal: AbortSignal;
}) => Promise<boolean>;

export const udpReceiverProbe: ReceiverProbe = ({
	address,
	port,
	source,
	signal,
}) =>
	new Promise<boolean>((resolve) => {
		if (signal.aborted) return resolve(false);
		const peer = canonicalIp(address);
		let socket: ReturnType<typeof createSocket> | undefined;
		let resend: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = (answered: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(resend);
			signal.removeEventListener("abort", onAbort);
			try {
				socket?.close();
			} catch {
				// Already closed by an error.
			}
			resolve(answered);
		};
		const onAbort = () => finish(false);
		// Every socket call can throw synchronously (a vanished source address,
		// a closed socket); all of them end the probe through `finish`.
		const guarded = (fn: () => void) => () => {
			try {
				fn();
			} catch {
				finish(false);
			}
		};
		const send = guarded(() => {
			if (settled) return;
			socket?.send(receiverProbePacket(), port, address, (error) => {
				if (error) finish(false);
			});
		});
		signal.addEventListener("abort", onAbort);
		guarded(() => {
			socket = createSocket(isIP(address) === 6 ? "udp6" : "udp4");
			socket.on("error", () => finish(false));
			socket.on("message", (message, rinfo) => {
				if (
					rinfo.port === port &&
					canonicalIp(rinfo.address) === peer &&
					isReceiverProbeReply(message)
				)
					finish(true);
			});
			socket.bind({ address: source, port: 0 }, () => {
				if (settled) return;
				send();
				// The second REG2 goes out only while this probe is still waiting.
				resend = setTimeout(send, RECEIVER_PROBE_RESEND_MS);
			});
		})();
	});

export type ReceiverAnswer = {
	readonly address: string;
	/** Bond sources that got a reply from this address. */
	readonly answeredVia: readonly string[];
};

export type ReceiverTargetChoice = {
	/** First address in DNS order that answered, or undefined if none did. */
	readonly target: string | undefined;
	readonly answers: readonly ReceiverAnswer[];
};

export type ReceiverTargetDeps = {
	readonly probe?: ReceiverProbe;
	readonly deadlineMs?: number;
};

/**
 * Probe every address over every source of its family and choose the first
 * address in DNS order with at least one reply. The choice is made as soon as
 * it cannot change: once an address has answered and every address before it
 * has finished without an answer. Remaining probes are aborted then.
 */
export async function chooseReceiverTarget(
	addresses: readonly string[],
	port: number,
	sources: readonly string[],
	deps: ReceiverTargetDeps = {},
): Promise<ReceiverTargetChoice> {
	const probe = deps.probe ?? udpReceiverProbe;
	const controller = new AbortController();
	const state = addresses.map((address) => ({
		address,
		answeredVia: [] as string[],
		pending: 0,
	}));
	const { promise: decided, resolve: decide } = Promise.withResolvers<void>();

	// Decided once some address answered and every address before it is done.
	const decidable = () => {
		for (const entry of state) {
			if (entry.answeredVia.length > 0) return true;
			if (entry.pending > 0) return false;
		}
		return true;
	};

	const plan = state.flatMap((entry) => {
		const family = isIP(entry.address);
		const familySources = sources.filter((ip) => isIP(ip) === family);
		const via = familySources.length > 0 ? familySources : [undefined];
		return via.map((source) => ({ entry, source }));
	});
	// Every pending count is set before any probe runs, so a probe that fails
	// synchronously cannot decide while later addresses are still uncounted.
	for (const { entry } of plan) entry.pending += 1;

	const probes = plan.map(async ({ entry, source }) => {
		let ok = false;
		try {
			ok = await probe({
				address: entry.address,
				port,
				source,
				signal: controller.signal,
			});
		} catch {
			ok = false;
		}
		entry.pending -= 1;
		// An unbound probe (no source of this family) is recorded as "".
		if (ok) entry.answeredVia.push(source ?? "");
		if (decidable()) decide();
	});

	const deadline = setTimeout(
		decide,
		deps.deadlineMs ?? RECEIVER_PROBE_DEADLINE_MS,
	);
	if (probes.length === 0) decide();
	await decided;
	clearTimeout(deadline);
	// Probes must settle on abort (the ReceiverProbe contract); the join below
	// relies on it so no socket outlives the choice.
	controller.abort();
	await Promise.all(probes);

	// Read after the abort: aborted probes add nothing, and a reply that raced
	// the deadline can only add an address that answered, which is still live.
	const answers: ReceiverAnswer[] = state.map((entry) => ({
		address: entry.address,
		answeredVia: [...entry.answeredVia],
	}));
	const target = answers.find((a) => a.answeredVia.length > 0)?.address;
	logger.info("receiver address probe", {
		target: target ?? null,
		answers: answers.map((a) => ({
			address: a.address,
			answeredVia: a.answeredVia.length,
		})),
	});
	return { target, answers };
}
