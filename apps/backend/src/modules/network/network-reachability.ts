/**
 * The signal behind "keep it if I can still reach the box": a check of the
 * requesting person's own access path, made after the change, bound to the
 * transaction.
 *
 * "The box can reach some server on the internet" is not enough: a role flip
 * can cut the path a remote owner uses while another uplink still reaches an
 * unrelated endpoint. So the only transport eligible today is one where the
 * box can test the path to the requester's own device: a tailnet peer. The
 * session's peer address must be in Tailscale's ranges and routed through the
 * tailnet interface (network-session-route.ts); the transaction records that
 * peer, and after the change the box asks tailscaled for a TSMP ping to it.
 * A TSMP pong travels through WireGuard and the peer's tailscaled, so it shows
 * the encrypted path between the box and that device works again, in both
 * directions, over whatever uplink the tailnet now uses.
 *
 * The ping goes through tailscaled's LocalAPI on its root-only Unix socket,
 * not the `tailscale` CLI, so no new binary joins the runner's allowlist.
 * Without the socket, or for any other transport, there is no signal and the
 * answer is not offered.
 */

import { existsSync } from "node:fs";
import { isIP } from "node:net";

/** A transport the box can test end to end for the requesting session. */
export interface RemoteTransport {
	readonly kind: "tailnet-peer";
	readonly peer: string;
}

/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return a === 100 && b !== undefined && b >= 64 && b <= 127;
	}
	if (isIP(address) === 6) return /^fd7a:115c:a1e0:/i.test(address);
	return false;
}

export const TAILSCALED_SOCKETS = [
	"/var/run/tailscale/tailscaled.sock",
	"/run/tailscale/tailscaled.sock",
];

export type LocalApiFetch = (
	socket: string,
	path: string,
	timeoutMs: number,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const localApiFetch: LocalApiFetch = (socket, path, timeoutMs) =>
	fetch(`http://local-tailscaled.sock${path}`, {
		method: "POST",
		unix: socket,
		headers: { "Sec-Tailscale": "localapi" },
		signal: AbortSignal.timeout(timeoutMs),
	} as RequestInit);

export const PROBE_TIMEOUT_MS = 4_000;

export function createTailnetReachability(
	options: {
		readonly sockets?: readonly string[];
		readonly exists?: (path: string) => boolean;
		readonly fetch?: LocalApiFetch;
		readonly timeoutMs?: number;
	} = {},
) {
	const sockets = options.sockets ?? TAILSCALED_SOCKETS;
	const exists = options.exists ?? existsSync;
	const call = options.fetch ?? localApiFetch;
	const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const socket = () => sockets.find((path) => exists(path));
	const eligible = (transport: RemoteTransport) =>
		transport.kind === "tailnet-peer" && isTailnetAddress(transport.peer);
	return {
		/** Whether this transport can be tested here at all. */
		available(transport: RemoteTransport): boolean {
			return eligible(transport) && socket() !== undefined;
		},
		/** One TSMP ping to the peer; true only for a pong without an error. */
		async probe(transport: RemoteTransport): Promise<boolean> {
			const path = socket();
			if (!eligible(transport) || !path) return false;
			try {
				const response = await call(
					path,
					`/localapi/v0/ping?ip=${encodeURIComponent(transport.peer)}&type=TSMP`,
					timeout,
				);
				if (!response.ok) return false;
				const result = (await response.json()) as {
					Err?: unknown;
					LatencySeconds?: unknown;
				};
				return (
					(result.Err === undefined || result.Err === "") &&
					typeof result.LatencySeconds === "number" &&
					result.LatencySeconds > 0
				);
			} catch {
				return false;
			}
		},
	};
}
