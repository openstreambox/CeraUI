/**
 * RPC Context - Creates context for each WebSocket message
 */

import { randomUUID } from "node:crypto";
import { bootClock } from "../helpers/boot-clock.ts";
import type { AppWebSocket, RPCContext } from "./types.ts";

const closedSockets = new WeakSet<AppWebSocket>();
const sessions = new WeakMap<AppWebSocket, AbortController>();
const inactiveSession = AbortSignal.abort();
const clients = new Set<AppWebSocket>();

export function addClient(ws: AppWebSocket): void {
	clients.add(ws);
}

export function removeClient(ws: AppWebSocket): void {
	clients.delete(ws);
}

export function getClients(): Set<AppWebSocket> {
	return clients;
}

export function getAuthenticatedClients(): AppWebSocket[] {
	return Array.from(clients).filter((ws) => ws.data.isAuthenticated);
}

export function socketSessionSignal(ws: AppWebSocket): AbortSignal {
	if (!ws.data.isAuthenticated || closedSockets.has(ws)) return inactiveSession;
	const current = sessions.get(ws);
	if (current) return current.signal;
	const session = new AbortController();
	sessions.set(ws, session);
	return session.signal;
}

export function closeSocketSession(ws: AppWebSocket): void {
	closedSockets.add(ws);
	createContext(ws).deauthenticate();
}

/**
 * Create an RPC context from a WebSocket connection
 */
export function createContext(ws: AppWebSocket): RPCContext {
	return {
		ws,

		isAuthenticated: () => ws.data.isAuthenticated,

		authenticate: (token?: string) => {
			if (closedSockets.has(ws)) return;
			if (token !== undefined && token !== ws.data.authToken) {
				sessions.get(ws)?.abort();
				sessions.delete(ws);
			}
			ws.data.isAuthenticated = true;
			if (token) {
				ws.data.authToken = token;
			}
			ws.data.lastActive = Date.now();
		},

		deauthenticate: () => {
			ws.data.isAuthenticated = false;
			delete ws.data.authToken;
			sessions.get(ws)?.abort();
			sessions.delete(ws);
		},

		markActive: () => {
			ws.data.lastActive = Date.now();
		},

		getLastActive: () => ws.data.lastActive,

		setSenderId: (id: string) => {
			ws.data.senderId = id;
		},

		getSenderId: () => ws.data.senderId,

		clearSenderId: () => {
			delete ws.data.senderId;
		},
	};
}

/** A header kept on the socket: bounded, lowercased, absent when empty. */
function uiHeader(request: Request | undefined, name: string) {
	const value = request?.headers.get(name)?.trim().toLowerCase();
	return value && value.length <= 512 ? value : undefined;
}

/**
 * Initialize socket data for a new connection. With the upgrade request, the
 * socket also keeps the UI address the browser used (`Origin`, `Host`): a
 * protected network change is confirmed only from a new connection to the
 * same address.
 */
export function initSocketData(
	request?: Request,
): import("./types.ts").SocketData {
	const now = Date.now();
	const openedClock = bootClock();
	const uiOrigin = uiHeader(request, "origin");
	const uiHost = uiHeader(request, "host");
	return {
		isAuthenticated: false,
		lastActive: now,
		sessionId: randomUUID(),
		openedAt: now,
		...(openedClock === undefined ? {} : { openedClock }),
		...(uiOrigin ? { uiOrigin } : {}),
		...(uiHost ? { uiHost } : {}),
	};
}
