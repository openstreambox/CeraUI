import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { tlsBindingFromPeer } from "./ingress.ts";

/**
 * The companion stub's transport: one WebSocket (RFC 6455) over a TLS or, for
 * a loopback development URL only, a plain TCP socket. It exists because the
 * runtime's WebSocket client does not expose the server certificate, and the
 * channel binding must come from the same connection that carries the calls.
 *
 * Certificate chains are not checked: the box's certificate is self-signed.
 * Trust comes from the box identity key endorsing this TLS key in its hello
 * (modules/companion/client.ts). Native apps do the same with their platform
 * TLS stack and a pinning hook.
 */
export interface CompanionConnection {
	/** `tls-spki:<hex>` of the key this connection was served, or `loopback`. */
	binding: string;
	rpc(path: readonly string[], input: unknown): Promise<unknown>;
	close(): void;
	closed: Promise<number>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function checkCompanionUrl(url: URL): void {
	const loopback = LOOPBACK.has(url.hostname);
	if (
		(url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) ||
		url.pathname !== "/ws" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw Error("Use a wss: URL at /ws, or ws: on loopback for development");
}

export function connectCompanion(
	url: URL,
	timeoutMs = 8000,
): Promise<CompanionConnection> {
	checkCompanionUrl(url);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const secure = url.protocol === "wss:";
	const port = Number(url.port || (secure ? 443 : 80));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.destroy();
			reject(Error("Connection timed out"));
		}, timeoutMs);
		let binding = "loopback";
		const socket: net.Socket = secure
			? tls.connect({
					host,
					port,
					rejectUnauthorized: false,
					minVersion: "TLSv1.2",
					...(net.isIP(host) ? {} : { servername: host }),
				})
			: net.connect({ host, port });
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		const key = randomBytes(16).toString("base64");
		const start = () => {
			if (secure) {
				const cert = (socket as tls.TLSSocket).getPeerX509Certificate();
				if (!cert) {
					socket.destroy();
					reject(Error("The box sent no certificate"));
					return;
				}
				binding = tlsBindingFromPeer(cert);
			}
			socket.write(
				`GET /ws HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			);
		};
		socket.once(secure ? "secureConnect" : "connect", start);

		let buffer = Buffer.alloc(0);
		let upgraded = false;
		let fragments: Buffer[] = [];
		const waiting = new Map<string, (value: unknown) => void>();
		let resolveClosed: (code: number) => void = () => undefined;
		const closed = new Promise<number>((done) => {
			resolveClosed = done;
		});
		socket.on("close", () => resolveClosed(1006));

		const send = (opcode: number, payload: Buffer) => {
			const mask = randomBytes(4);
			const length = payload.length;
			const header =
				length < 126
					? Buffer.from([0x80 | opcode, 0x80 | length])
					: length < 65536
						? Buffer.from([
								0x80 | opcode,
								0x80 | 126,
								length >> 8,
								length & 255,
							])
						: (() => {
								const h = Buffer.alloc(10);
								h[0] = 0x80 | opcode;
								h[1] = 0x80 | 127;
								h.writeBigUInt64BE(BigInt(length), 2);
								return h;
							})();
			const masked = Buffer.from(payload);
			for (let i = 0; i < masked.length; i++)
				masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
			socket.write(Buffer.concat([header, mask, masked]));
		};
		const onText = (text: string) => {
			let message: { id?: string; result?: unknown; type?: string };
			try {
				message = JSON.parse(text);
			} catch {
				return;
			}
			if (message.type === "ping") {
				send(1, Buffer.from(JSON.stringify({ pong: true })));
				return;
			}
			if (typeof message.id === "string") {
				waiting.get(message.id)?.(message.result);
				waiting.delete(message.id);
			}
		};
		const parseFrames = () => {
			while (buffer.length >= 2) {
				const first = buffer[0] ?? 0;
				const second = buffer[1] ?? 0;
				if (second & 0x80) {
					socket.destroy();
					return;
				}
				let length = second & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < 4) return;
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.length < 10) return;
					const big = buffer.readBigUInt64BE(2);
					if (big > 16n * 1024n * 1024n) {
						socket.destroy();
						return;
					}
					length = Number(big);
					offset = 10;
				}
				if (buffer.length < offset + length) return;
				const payload = buffer.subarray(offset, offset + length);
				buffer = buffer.subarray(offset + length);
				const opcode = first & 0x0f;
				const fin = (first & 0x80) !== 0;
				if (opcode === 8) {
					const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
					resolveClosed(code);
					socket.end();
					return;
				}
				if (opcode === 9) send(10, Buffer.from(payload));
				if (opcode === 1 || opcode === 0) {
					fragments.push(Buffer.from(payload));
					if (fin) {
						onText(Buffer.concat(fragments).toString("utf8"));
						fragments = [];
					}
				}
			}
		};
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!upgraded) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const head = buffer.subarray(0, end).toString("latin1");
				buffer = buffer.subarray(end + 4);
				const accept = createHash("sha1")
					.update(key + GUID)
					.digest("base64");
				const lines = head.split("\r\n");
				const ok =
					/^HTTP\/1\.1 101 /.test(lines[0] ?? "") &&
					lines.some(
						(line) =>
							line.toLowerCase() ===
							`sec-websocket-accept: ${accept.toLowerCase()}`,
					);
				clearTimeout(timer);
				if (!ok) {
					socket.destroy();
					reject(Error("The box refused the WebSocket upgrade"));
					return;
				}
				upgraded = true;
				resolve({
					binding,
					closed,
					close: () => {
						send(8, Buffer.from([0x03, 0xe8]));
						socket.end();
					},
					rpc: (path, input) =>
						new Promise((done, fail) => {
							const id = randomBytes(8).toString("hex");
							const timeout = setTimeout(() => {
								waiting.delete(id);
								fail(Error("The box did not answer"));
							}, timeoutMs);
							waiting.set(id, (value) => {
								clearTimeout(timeout);
								done(value);
							});
							send(1, Buffer.from(JSON.stringify({ id, path, input })));
						}),
				});
			}
			parseFrames();
		});
	});
}
