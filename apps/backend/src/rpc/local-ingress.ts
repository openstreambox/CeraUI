/**
 * Private local ingress: the one listener for the image's front door.
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
 *
 * Consumers: a socket from this listener carries `ingressPath` (the validated
 * evidence), `ingressLifetime` (the interface's kernel ifindex and netif
 * incarnation when that evidence was accepted) and `ingressPathValid()`, which
 * rechecks that the local address is still on that interface with the peer
 * inside its subnet and that the interface is still the accepted lifetime, and
 * stays false once it failed. Consumers that act on the path call it before every action and
 * add their own checks (Wi-Fi sign-in requires the interface to be the current
 * hotspot AP; button confirmation adds its interface-kind rule). There is one
 * listener per process: the socket path refuses a second owner.
 *
 * Without the directory (development, older images) nothing listens and the
 * ordinary TCP path is unchanged.
 */
import { chmodSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import type { Server, WebSocketHandler } from "bun";

import { getNetworkInterfaceIncarnation } from "../modules/network/network-interfaces.ts";
import { createServerWebSocketHandler, initSocketData } from "./adapter.ts";
import { permitsE2eWorkerProxyRequest } from "./e2e-worker-admission.ts";
import type {
	IngressLifetime,
	IngressPath,
	ServerSocketData,
} from "./types.ts";

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

/** The kernel ifindex and netif incarnation an interface name has now. */
export const systemLifetime = (name: string): IngressLifetime => {
	let ifindex: number | undefined;
	try {
		const raw = readFileSync(`/sys/class/net/${name}/ifindex`, "ascii").trim();
		const value = Number(raw);
		ifindex =
			/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(value)
				? value
				: undefined;
	} catch {
		ifindex = undefined;
	}
	return { ifindex, incarnation: getNetworkInterfaceIncarnation(name) };
};

/** Every captured lifetime field still has its accepted value. */
export function ingressLifetimeHolds(
	accepted: IngressLifetime,
	current: IngressLifetime,
): boolean {
	return (
		(accepted.ifindex === undefined || accepted.ifindex === current.ifindex) &&
		(accepted.incarnation === undefined ||
			accepted.incarnation === current.incarnation)
	);
}

const ipv4Number = (address: string) =>
	address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

/**
 * The evidence still describes a current on-link path: the local address is on
 * the named interface and the peer is inside that address's subnet.
 */
export function ingressLinkHolds(
	path: IngressPath,
	links: () => readonly IngressLink[],
): boolean {
	let current: readonly IngressLink[];
	try {
		current = links();
	} catch {
		return false;
	}
	const link = current.find(
		(candidate) =>
			candidate.name === path.interface &&
			candidate.address === path.local &&
			(candidate.family === "IPv4" || candidate.family === "4") &&
			isIPv4(candidate.netmask),
	);
	if (!link) return false;
	const mask = ipv4Number(link.netmask);
	if (mask === 0) return false;
	return (
		(ipv4Number(path.peer) & mask) >>> 0 ===
		(ipv4Number(path.local) & mask) >>> 0
	);
}

/**
 * Validate the front door's evidence on one request. The front door never
 * passes forwarding metadata on this path, so its presence refuses.
 */
export function parseIngressPath(
	headers: Headers,
	links: () => readonly IngressLink[],
): IngressPath | null {
	for (const name of headers.keys())
		if (
			name === "forwarded" ||
			name === "via" ||
			name.startsWith("x-forwarded-")
		)
			return null;
	const header = headers.get(LOCAL_INGRESS_HEADER);
	if (!header || header.length > 512) return null;
	let evidence: unknown;
	try {
		evidence = JSON.parse(header);
	} catch {
		return null;
	}
	if (!evidence || typeof evidence !== "object") return null;
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
	const path = Object.freeze({ peer, interface: name, local });
	return ingressLinkHolds(path, links) ? path : null;
}

export interface LocalIngressOptions {
	links?: () => readonly IngressLink[];
	/** The proven interface's current lifetime; defaults to sysfs and netif. */
	lifetime?: (name: string) => IngressLifetime;
	/** Same transport admission as the TCP listener (E2E worker isolation). */
	workerSecret?: string | undefined;
	websocket?: WebSocketHandler<ServerSocketData>;
}

/** Separated listener construction for tests on a temporary Unix socket. */
export function serveLocalIngress(
	socket: string,
	options: LocalIngressOptions = {},
): Server<ServerSocketData> {
	const links = options.links ?? systemLinks;
	const lifetime = options.lifetime ?? systemLifetime;
	return Bun.serve<ServerSocketData>({
		unix: socket,
		fetch(request, server) {
			if (
				request.method !== "GET" ||
				new URL(request.url).pathname !== "/ws" ||
				request.headers.get("upgrade")?.toLowerCase() !== "websocket"
			)
				return new Response("Not found", { status: 404 });
			if (!permitsE2eWorkerProxyRequest(request, options.workerSecret))
				return new Response("Worker proxy admission required", {
					status: 403,
				});
			const ingressPath = parseIngressPath(request.headers, links);
			if (!ingressPath)
				return new Response("Direct path required", { status: 403 });
			// The lifetime is taken with the evidence, so a replacement or
			// re-registration of that name later never inherits this socket.
			const read = () => {
				try {
					return lifetime(ingressPath.interface);
				} catch {
					return { ifindex: undefined, incarnation: undefined };
				}
			};
			const ingressLifetime = Object.freeze(read());
			let holds = true;
			const ingressPathValid = () => {
				holds &&=
					ingressLinkHolds(ingressPath, links) &&
					ingressLifetimeHolds(ingressLifetime, read());
				return holds;
			};
			if (
				server.upgrade(request, {
					data: {
						...initSocketData(new URL(request.url)),
						ingressPath,
						ingressLifetime,
						ingressPathValid,
					},
				})
			)
				return undefined;
			return new Response("Upgrade failed", { status: 500 });
		},
		websocket: options.websocket ?? createServerWebSocketHandler(),
	});
}

export interface LocalIngressStartDeps {
	lstat(path: string): Stats;
	getuid(): number | undefined;
	chmod(path: string, mode: number): void;
	serve(socket: string): Server<ServerSocketData>;
}

const systemStartDeps: LocalIngressStartDeps = {
	lstat: (path) => lstatSync(path),
	getuid: () => process.getuid?.(),
	chmod: (path, mode) => chmodSync(path, mode),
	serve: (socket) =>
		serveLocalIngress(socket, {
			workerSecret: process.env.E2E_WORKER_PROXY_SECRET,
		}),
};

function refuse(reason: string): never {
	throw new Error(`Local ingress refused: ${reason}`);
}

/**
 * Start the private listener when the image provides its runtime directory.
 * Returns null when the directory is absent; throws when it is unsafe.
 */
export function startLocalIngress(
	directory = LOCAL_INGRESS_DIRECTORY,
	deps: LocalIngressStartDeps = systemStartDeps,
): Server<ServerSocketData> | null {
	let info: Stats;
	try {
		info = deps.lstat(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (info.isSymbolicLink()) refuse("directory is a symlink");
	if (!info.isDirectory()) refuse("not a directory");
	if (info.uid !== 0) refuse("directory not owned by root");
	if ((info.mode & 0o777) !== 0o700) refuse("directory mode not 0700");
	if (deps.getuid() !== 0) refuse("backend not running as root");
	// Never unlink an existing socket: the image's ExecStartPre removes a stale
	// one after the previous backend stopped, and a second backend must not
	// take over a running one's socket.
	const socket = `${directory}/rpc.sock`;
	let occupied = true;
	try {
		deps.lstat(socket);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		occupied = false;
	}
	if (occupied) refuse("socket path already exists");
	const server = deps.serve(socket);
	try {
		deps.chmod(socket, 0o600);
	} catch (error) {
		server.stop(true);
		throw error;
	}
	return server;
}
