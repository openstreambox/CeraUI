/**
 * The box's own outside reachability, for "keep it if the box can still
 * reach the internet" changes.
 *
 * A remote owner reaches the box through connections the box opens itself:
 * the relay socket, the device-control channel, the tailnet's coordination
 * and relay servers. If the box can still open a fresh connection to one of
 * those endpoints after a network change, the owner's way back exists; if it
 * cannot, NetworkManager's checkpoint undoes the change at the deadline.
 *
 * Each probe is a fresh TCP connect (no reuse of a socket that may have
 * survived the change by luck), bounded by a short timeout, to every known
 * endpoint at once; one success is enough. With no endpoint known (no remote
 * access configured) there is nothing to probe, and the answer is not offered.
 */

import { connect } from "node:net";

export interface ReachabilityTarget {
	readonly host: string;
	readonly port: number;
}

export type TcpConnector = (
	target: ReachabilityTarget,
	timeoutMs: number,
) => Promise<boolean>;

export const PROBE_TIMEOUT_MS = 3_000;

export const tcpConnect: TcpConnector = (target, timeoutMs) =>
	new Promise((resolve) => {
		const socket = connect({ host: target.host, port: target.port });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});

/** host[:port] or a ws(s)/http(s) URL; anything else is ignored. */
export function parseTarget(value: string | undefined): ReachabilityTarget[] {
	if (!value) return [];
	const text = value.trim();
	if (!text) return [];
	try {
		const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `tcp://${text}`);
		const secure = url.protocol === "wss:" || url.protocol === "https:";
		const port = url.port ? Number(url.port) : secure ? 443 : 80;
		if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535)
			return [];
		return [{ host: url.hostname.replace(/^\[|\]$/g, ""), port }];
	} catch {
		return [];
	}
}

export function createReachability(options: {
	readonly targets: () =>
		| readonly ReachabilityTarget[]
		| Promise<readonly ReachabilityTarget[]>;
	readonly connector?: TcpConnector;
	readonly timeoutMs?: number;
}) {
	const connector = options.connector ?? tcpConnect;
	const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const unique = async () => {
		const seen = new Map<string, ReachabilityTarget>();
		let listed: readonly ReachabilityTarget[] = [];
		try {
			listed = await options.targets();
		} catch {
			listed = [];
		}
		for (const target of listed)
			seen.set(`${target.host}:${target.port}`, target);
		return [...seen.values()];
	};
	return {
		async available(): Promise<boolean> {
			return (await unique()).length > 0;
		},
		async probe(): Promise<boolean> {
			const targets = await unique();
			if (!targets.length) return false;
			const results = await Promise.all(
				targets.map((target) => connector(target, timeout).catch(() => false)),
			);
			return results.some(Boolean);
		},
	};
}
