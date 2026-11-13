import { createSocket } from "node:dgram";
import { writeFile } from "node:fs/promises";

const [certificate, key, receipt] = process.argv.slice(2);
if (!certificate || !key || !receipt)
	throw new Error("Provider arguments missing");
const seen: { kind: "dns" | "https"; source: string }[] = [];
let pending: Promise<void> = Promise.resolve();
function record(kind: "dns" | "https", source: string) {
	seen.push({ kind, source });
	pending = pending.then(() => writeFile(receipt, JSON.stringify(seen)));
}
const socket = createSocket("udp4");
socket.on("message", (question, peer) => {
	if (
		question.length < 12 ||
		question.length > 4096 ||
		question.readUInt16BE(4) !== 1
	)
		return;
	record("dns", peer.address);
	const reply = Buffer.from(question);
	reply.writeUInt16BE(0x8180, 2);
	for (const offset of [6, 8, 10]) reply.writeUInt16BE(0, offset);
	socket.send(reply, peer.port, peer.address);
});
await new Promise<void>((resolve, reject) => {
	socket.once("error", reject);
	socket.bind(53, "192.0.2.53", resolve);
});
const server = Bun.serve({
	hostname: "1.1.1.1",
	port: 443,
	tls: { cert: Bun.file(certificate), key: Bun.file(key) },
	fetch: (request, server) => {
		const peer = server.requestIP(request);
		if (!peer) return new Response(null, { status: 500 });
		record("https", peer.address);
		return new Response(null, {
			status: request.method === "HEAD" ? 204 : 405,
		});
	},
});
await writeFile(`${receipt}.ready`, "ready");
async function stop() {
	socket.close();
	await server.stop(true);
	await pending;
	process.exit(0);
}
process.on("SIGTERM", () => {
	void stop();
});
process.on("SIGINT", () => {
	void stop();
});
