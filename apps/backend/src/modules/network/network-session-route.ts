/**
 * The box's own route back to a UI session that has no arrival evidence.
 *
 * Remote sessions (a tailnet, a VPN, the front door's TCP proxy, a plain TCP
 * peer on an image without the front door) carry no trusted arrival interface,
 * so they count as "unknown" and can never confirm a change. Asking them to
 * "confirm within 90 s" promises an undo. The box can still tell them up front
 * which of its interfaces their session depends on: the interface its replies
 * leave through, or, when that is a tunnel or loopback, every uplink holding a
 * default route (the tunnel rides one of them and may move to another).
 *
 * This is a prediction from the routing table, not proof of anything. The
 * policy uses it only to make the ask-before prompt more specific ("this cuts
 * you via eth0"); it never skips a prompt and never confirms (see
 * network-change-policy.ts). Any doubt yields undefined: the prompt then falls
 * back to "may disconnect you".
 */

import { isIP } from "node:net";
import { run } from "../../helpers/run.ts";
import type { SessionRoute } from "./network-change-policy.ts";
import { isTailnetAddress } from "./network-reachability.ts";

export type RouteRunner = (bin: string, args: string[]) => Promise<string>;

/**
 * Interfaces that carry no session by themselves: loopback, tailnet, WireGuard,
 * generic tunnels and ZeroTier. A session over one of them depends on whichever
 * uplink the tunnel rides.
 */
const TUNNEL =
	/^(lo|tailscale[0-9]*|wg[A-Za-z0-9_.-]*|tun[0-9]*|tap[0-9]*|zt[A-Za-z0-9]*)$/;
const IFNAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}$/;

export function isTunnelInterface(name: string): boolean {
	return TUNNEL.test(name);
}

function normalize(address: string): string | undefined {
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
	const peer = mapped ? (mapped[1] as string) : address.toLowerCase();
	return isIP(peer) ? peer : undefined;
}

function isLoopback(peer: string): boolean {
	return peer === "::1" || /^127\./.test(peer);
}

function devices(json: string): string[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("Unexpected route output");
	const found: string[] = [];
	for (const entry of parsed) {
		const route = entry as { dev?: unknown; type?: unknown };
		if (route.type !== undefined && route.type !== "unicast") continue;
		if (typeof route.dev === "string" && IFNAME.test(route.dev))
			found.push(route.dev);
	}
	return found;
}

export function createSessionRouteLookup(runner: RouteRunner = run) {
	/** Every non-tunnel interface that holds a default route in any table. */
	async function uplinks(): Promise<string[]> {
		const found = new Set<string>();
		for (const family of ["-4", "-6"])
			for (const dev of devices(
				await runner("ip", [
					"-j",
					family,
					"route",
					"show",
					"default",
					"table",
					"all",
				]),
			))
				if (!isTunnelInterface(dev)) found.add(dev);
		return [...found].sort();
	}

	return {
		/**
		 * The route back to `address`, or undefined when the box can't tell
		 * (not an IP address, an unreadable routing table, no uplink at all).
		 */
		async lookup(address: string): Promise<SessionRoute | undefined> {
			const peer = normalize(address);
			if (!peer) return undefined;
			try {
				let dev: string | undefined;
				if (!isLoopback(peer)) {
					[dev] = devices(await runner("ip", ["-j", "route", "get", peer]));
					if (!dev) return undefined;
				}
				if (dev && !isTunnelInterface(dev))
					return { carriers: [dev], tunnel: false };
				// Loopback (the front door's proxy, a local relay agent) or a
				// tunnel: the session depends on whichever uplink carries it.
				const carriers = await uplinks();
				if (!carriers.length) return undefined;
				// A tailnet peer, answered through the tailnet interface: the one
				// transport whose path to the requester the box can test.
				const tailnetPeer =
					dev && /^tailscale[0-9]*$/.test(dev) && isTailnetAddress(peer)
						? peer
						: undefined;
				return {
					carriers,
					tunnel: true,
					...(tailnetPeer ? { tailnetPeer } : {}),
				};
			} catch {
				return undefined;
			}
		},
	};
}

export const sessionRouteLookup = createSessionRouteLookup();
