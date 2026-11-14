import WebSocket from "ws";

/**
 * The only place the backend opens a client `ws` socket. Bun ships `ws` as a
 * builtin that a test or development harness cannot wrap, so the harness
 * registers a check under this symbol instead; production never sets it.
 */
const OUTBOUND_CHECK = Symbol.for("ceraui.outboundCheck");

export function openOutboundWebSocket(
	url: string | URL,
	options?: WebSocket.ClientOptions,
): WebSocket {
	const check = (globalThis as Record<symbol, unknown>)[OUTBOUND_CHECK];
	if (typeof check === "function") check(String(url), WebSocket);
	return options ? new WebSocket(url, options) : new WebSocket(url);
}
