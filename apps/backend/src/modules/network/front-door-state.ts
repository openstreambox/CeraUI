/**
 * Whether this process's front-door listener (rpc/local-ingress.ts) actually
 * started. The runtime directory existing is not enough: the listener refuses
 * an unsafe directory or a stale socket, and then no session has arrival
 * evidence. Kept free of imports so the network-change modules can read it
 * without the server graph.
 */
let listening = false;

export function markFrontDoorListening(value = true): void {
	listening = value;
}

export function frontDoorListening(): boolean {
	return listening;
}
