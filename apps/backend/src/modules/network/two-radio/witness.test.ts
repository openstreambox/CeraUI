import { expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import { createWitness } from "./witness.ts";

async function receive(
	socket: Socket,
	action: () => void,
): Promise<string | null> {
	let timer: ReturnType<typeof setTimeout>;
	const result = new Promise<string | null>((resolve) => {
		const listener = (data: Buffer) => {
			clearTimeout(timer);
			resolve(data.toString());
		};
		socket.once("message", listener);
		timer = setTimeout(() => {
			socket.off("message", listener);
			resolve(null);
		}, 100);
	});
	action();
	return result;
}
test("receiver nonces reject wrong peer, expiry, replay and invalid controls", async () => {
	let now = 0;
	const server = createWitness(() => now),
		a = createSocket("udp4"),
		b = createSocket("udp4");
	try {
		server.bind(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address();
		const send = (s: Socket, text: string) => s.send(text, port, "127.0.0.1");
		const nonce = await receive(a, () => send(a, "ISSUE request"));
		expect(nonce).toMatch(/^[a-f0-9]{48}$/);
		expect(await receive(b, () => send(b, `PROBE ${nonce}`))).toBeNull();
		expect(await receive(a, () => send(a, "PROBE invalid"))).toBeNull();
		expect(await receive(a, () => send(a, `PROBE ${nonce}`))).toBe(
			`ACK ${nonce}`,
		);
		expect(await receive(a, () => send(a, `PROBE ${nonce}`))).toBeNull();
		const expired = await receive(a, () => send(a, "ISSUE next"));
		now = 4000;
		expect(await receive(a, () => send(a, `PROBE ${expired}`))).toBeNull();
	} finally {
		server.close();
		a.close();
		b.close();
	}
});
