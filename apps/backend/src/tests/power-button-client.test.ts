import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PowerButtonClient } from "../modules/system/power-button-client.ts";

let server: Server;
let dir: string;
let peer: Socket;
afterEach(async () => {
	peer?.destroy();
	if (server) await new Promise<void>((r) => server.close(() => r()));
	if (dir) await rm(dir, { recursive: true, force: true });
});
async function fake(reply: (command: string, socket: Socket) => void) {
	dir = await mkdtemp(join(tmpdir(), "button-test-"));
	const path = join(dir, "control.sock");
	server = createServer((socket) => {
		peer = socket;
		socket.on("data", (data) => reply(data.toString(), socket));
	});
	await new Promise<void>((r) => server.listen(path, r));
	return new PowerButtonClient(path, 50);
}
test("READY admits a one-shot request, including fragmented frames", async () => {
	const client = await fake((command, socket) => {
		expect(command).toBe("CONFIRM 60\n");
		socket.write("REA");
		setTimeout(() => socket.write("DY\n"), 1);
	});
	const request = await client.confirm(60);
	expect(request).not.toBeNull();
	peer.write("CONFIRMED\n");
	expect(await request?.result).toBe("confirmed");
});
test("BUSY never admits a prompt", async () => {
	const client = await fake((_, socket) => socket.end("BUSY\n"));
	expect(await client.confirm(60)).toBeNull();
});
test("cancel closes the held socket and cannot confirm", async () => {
	const client = await fake((_, socket) => socket.write("READY\n"));
	const request = await client.confirm(1);
	request?.cancel();
	expect(await request?.result).toBe("cancelled");
});
test("timeout and broken connections fail closed", async () => {
	const client = await fake((_, socket) => socket.write("READY\nTIMEOUT\n"));
	expect(await (await client.confirm(1))?.result).toBe("timeout");
});
test("missing socket is an optional capability", async () => {
	const client = new PowerButtonClient("/nonexistent/button-test.sock", 10);
	expect(await client.confirm(60)).toBeNull();
	expect(await client.setLive(true)).toBe(false);
});
test("live publishes both states using separate connections", async () => {
	const commands: string[] = [];
	const client = await fake((command, socket) => {
		commands.push(command);
		socket.end("OK\n");
	});
	expect(await client.setLive(true)).toBe(true);
	expect(await client.setLive(false)).toBe(true);
	expect(commands).toEqual(["LIVE 1\n", "LIVE 0\n"]);
});
test("invalid timeout rejected before connecting", async () => {
	const client = new PowerButtonClient("/nonexistent/button-test.sock");
	await expect(client.confirm(0)).rejects.toThrow();
	await expect(client.confirm(61)).rejects.toThrow();
});
test("a silent handshake has a bounded deadline", async () => {
	const client = await fake(() => {});
	expect(await client.confirm(60)).toBeNull();
});

test("an unsolicited CONFIRMED before READY cannot authorize", async () => {
	const client = await fake((_, socket) => socket.end("CONFIRMED\n"));
	expect(await client.confirm(60)).toBeNull();
});
test("EOF after READY is never confirmation", async () => {
	const client = await fake((_, socket) => socket.end("READY\n"));
	expect(await (await client.confirm(60))?.result).toBe("unavailable");
});
