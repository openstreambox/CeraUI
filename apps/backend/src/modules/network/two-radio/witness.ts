import { randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo } from "node:dgram";

/** Optional separately provisioned witness. Never started by the device owner.
 * Nonces are receiver-issued, short lived, single-use and bound to a UDP peer. */
export function createWitness(now = Date.now, limit = 4096) {
	const socket = createSocket("udp4");
	const issued = new Map<string, { nonce: string; expires: number }>();
	const peerKey = (peer: RemoteInfo) => `${peer.address}:${peer.port}`;
	socket.on("error", () => socket.close());
	socket.on("message", (message, peer) => {
		if (message.length > 128) return;
		const text = message.toString("ascii");
		const time = now();
		for (const [key, entry] of issued)
			if (entry.expires <= time) issued.delete(key);
		const key = peerKey(peer);
		if (/^ISSUE [a-zA-Z0-9_-]{1,80}$/.test(text)) {
			if (issued.size >= limit && !issued.has(key)) return;
			const nonce = randomBytes(24).toString("hex");
			issued.set(key, { nonce, expires: time + 4000 });
			socket.send(nonce, peer.port, peer.address);
		} else {
			const entry = issued.get(key);
			if (!entry || text !== `PROBE ${entry.nonce}` || time >= entry.expires)
				return;
			issued.delete(key);
			socket.send(`ACK ${entry.nonce}`, peer.port, peer.address);
		}
	});
	return socket;
}

if (import.meta.main) {
	const host = process.env.WITNESS_BIND;
	const port = Number(process.env.WITNESS_PORT);
	if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Set WITNESS_BIND and WITNESS_PORT explicitly");
	createWitness().bind(port, host);
}
