/**
 * Private local ingress.
 *
 * On images with the device-bound browser front door, every browser reaches
 * the backend through that front door, so the TCP peer of every WebSocket is
 * 127.0.0.1. For a direct, on-link WebSocket the front door instead connects to
 * a Unix socket in a root-only runtime directory and adds an
 * `X-Ceralive-Button-Path` header with the accepted peer, the listener's
 * interface and the local address it accepted on.
 *
 * The header is read ONLY on that Unix listener. Only root can connect there
 * (the directory is root:root 0700, the socket 0600), so the header cannot be
 * forged by a network client; a TCP request carrying it is never consulted.
 * The evidence is still checked against the interface addresses at upgrade.
 * Without the directory (development, older images) nothing listens and the
 * ordinary TCP path is unchanged.
 */
import { chmodSync, lstatSync } from "node:fs";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import type { Server } from "bun";

import { createServerWebSocketHandler, initSocketData } from "./adapter.ts";
import type { IngressPath, ServerSocketData } from "./types.ts";

export const LOCAL_INGRESS_DIRECTORY = "/run/ceralive-button-ingress";
export const LOCAL_INGRESS_HEADER = "X-Ceralive-Button-Path";
const IFNAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}$/;

export interface IngressLink {
	name: string;
	address: string;
	netmask: string;
	family: string;
}

export const systemLinks = (): IngressLink[] =>
	Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
		(addresses ?? []).map(({ address, netmask, family }) => ({
			name,
			address,
			netmask,
			family: String(family),
		})),
	);

const ipv4Number = (address: string) =>
	address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

/**
 * Validate the front door's evidence. Returns the path only when the local
 * address is currently on the named interface and the peer is inside that
 * address's subnet; anything else is null.
 */
export function parseIngressPath(
	header: string | null,
	links: () => readonly IngressLink[],
): IngressPath | null {
	if (!header || header.length > 512) return null;
	let evidence: unknown;
	try {
		evidence = JSON.parse(header);
	} catch {
		return null;
	}
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
		return null;
	const {
		version,
		peer,
		interface: name,
		local,
	} = evidence as Record<string, unknown>;
	if (
		version !== 1 ||
		typeof peer !== "string" ||
		typeof name !== "string" ||
		typeof local !== "string" ||
		!IFNAME.test(name) ||
		!isIPv4(peer) ||
		!isIPv4(local) ||
		peer === local ||
		peer.startsWith("127.") ||
		peer.startsWith("0.")
	)
		return null;
	let current: readonly IngressLink[];
	try {
		current = links();
	} catch {
		return null;
	}
	const link = current.find(
		(candidate) =>
			candidate.name === name &&
			candidate.address === local &&
			(candidate.family === "IPv4" || candidate.family === "4") &&
			isIPv4(candidate.netmask),
	);
	if (!link) return null;
	const mask = ipv4Number(link.netmask);
	if ((ipv4Number(peer) & mask) >>> 0 !== (ipv4Number(local) & mask) >>> 0)
		return null;
	return Object.freeze({ peer, interface: name, local });
}

/** Separated listener construction for tests on a temporary Unix socket. */
export function serveLocalIngress(
	socket: string,
	links: () => readonly IngressLink[] = systemLinks,
): Server<ServerSocketData> {
	return Bun.serve<ServerSocketData>({
		unix: socket,
		fetch(request, server) {
			if (
				request.method !== "GET" ||
				new URL(request.url).pathname !== "/ws" ||
				request.headers.get("upgrade")?.toLowerCase() !== "websocket"
			)
				return new Response("Not found", { status: 404 });
			const ingressPath = parseIngressPath(
				request.headers.get(LOCAL_INGRESS_HEADER),
				links,
			);
			if (!ingressPath)
				return new Response("Direct path required", { status: 403 });
			if (
				server.upgrade(request, { data: { ...initSocketData(), ingressPath } })
			)
				return undefined;
			return new Response("Upgrade failed", { status: 500 });
		},
		websocket: createServerWebSocketHandler(),
	});
}

/**
 * Start the private listener when the image provides its runtime directory.
 * Returns null when the directory is absent; throws when it is unsafe.
 */
export function startLocalIngress(
	directory = LOCAL_INGRESS_DIRECTORY,
): Server<ServerSocketData> | null {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== 0 ||
		(info.mode & 0o777) !== 0o700 ||
		process.getuid?.() !== 0
	)
		throw new Error("Local ingress needs a root-owned private directory");
	// Never unlink an existing socket: the image's ExecStartPre removes a stale
	// one after the previous backend stopped, and a second backend must not
	// take over a running one's socket.
	const socket = `${directory}/rpc.sock`;
	try {
		lstatSync(socket);
		throw new Error("Local ingress socket already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const server = serveLocalIngress(socket);
	try {
		chmodSync(socket, 0o600);
	} catch (error) {
		server.stop(true);
		throw error;
	}
	return server;
}
