/**
 * RPC Types - Bun WebSocket context types
 */
import type { ServerWebSocket } from "bun";

/**
 * Data attached to each WebSocket connection
 */
export interface SocketData {
	/** Whether the socket has been authenticated */
	isAuthenticated: boolean;
	/** Auth token if using persistent authentication */
	authToken?: string;
	/** Last activity timestamp for keepalive */
	lastActive: number;
	/** Sender ID for remote relay identification */
	senderId?: string;
	/**
	 * Dev only: this socket's upgrade carried the scenario driver secret, so it
	 * may call `dev.scenario.*` (rpc/scenario-driver-admission.ts).
	 */
	scenarioDriver?: boolean;
	/** The TCP upgrade came from a native client with Wi-Fi import enabled. */
	nativeTcpClient?: boolean;
	/**
	 * Set only on sockets accepted by the private local ingress listener
	 * (rpc/local-ingress.ts): the browser's on-link address as seen by the
	 * image's front door. Never derived from a TCP request's headers.
	 */
	ingressPath?: IngressPath;
	/**
	 * The proven interface's lifetime when the socket's evidence was accepted.
	 * Absent fields were unreadable then; consumers that need them refuse.
	 */
	ingressLifetime?: IngressLifetime;
	/**
	 * Rechecks the ingress path's link and, where captured, that the interface
	 * is still the lifetime it was accepted on; false once it failed.
	 */
	ingressPathValid?: () => boolean;
}

/** Kernel ifindex and netif incarnation of an ingress interface. */
export interface IngressLifetime {
	readonly ifindex: number | undefined;
	readonly incarnation: number | undefined;
}

/** The front door's validated evidence for one direct, on-link WebSocket. */
export interface IngressPath {
	readonly peer: string;
	readonly interface: string;
	readonly local: string;
}

/**
 * Data attached to a `/preview` proxy WebSocket. The upgrade forks on pathname
 * BEFORE the oRPC handler, so a preview socket carries the single-use token (the
 * proxy validates+consumes it on open) instead of the RPC auth flags. The `kind`
 * discriminant lets the shared Bun `websocket` handler route each socket.
 */
export interface PreviewSocketData {
	kind: "preview";
	token: string;
}

/** Every socket the single Bun server owns: an oRPC socket or a preview socket. */
export type ServerSocketData = SocketData | PreviewSocketData;

/**
 * Bun ServerWebSocket with our custom data
 */
export type AppWebSocket = ServerWebSocket<SocketData>;

/**
 * Context passed to each RPC procedure
 */
export interface RPCContext {
	/** The WebSocket connection */
	ws: AppWebSocket;
	/** Check if connection is authenticated */
	isAuthenticated: () => boolean;
	/** Authenticate the connection */
	authenticate: (token?: string) => void;
	/** Deauthenticate the connection */
	deauthenticate: () => void;
	/** Update last activity timestamp */
	markActive: () => void;
	/** Get last activity timestamp */
	getLastActive: () => number;
	/** Set sender ID for relay */
	setSenderId: (id: string) => void;
	/** Get sender ID */
	getSenderId: () => string | undefined;
	/** Clear sender ID */
	clearSenderId: () => void;
}

/**
 * Event types for subscription broadcasts
 */
export type BroadcastEvent =
	| { type: "status"; data: unknown }
	| { type: "sensors"; data: unknown }
	| { type: "netif"; data: unknown }
	| { type: "uplinks"; data: unknown }
	| { type: "modems"; data: unknown }
	| { type: "config"; data: unknown }
	| { type: "wifi"; data: unknown }
	| { type: "notifications"; data: unknown }
	| { type: "auth"; data: unknown }
	| { type: "bitrate"; data: unknown }
	| { type: "log"; data: unknown };
