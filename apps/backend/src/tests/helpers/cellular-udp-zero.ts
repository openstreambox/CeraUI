import { createSocket } from "node:dgram";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { datagramSockaddr } from "../../helpers/source-bound-datagram.ts";
import {
	parseIpv4,
	parseIpv6,
	parseNat64Prefix,
	synthesizeNat64,
} from "../../modules/network/nat64.ts";

function checksum(parts: readonly Uint8Array[]): number {
	let sum = 0;
	for (const bytes of parts) {
		for (let at = 0; at < bytes.length; at += 2)
			sum += ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
		while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
	}
	return ~sum & 0xffff;
}
function udp(
	source: number,
	target: number,
	payload = new Uint8Array(2),
): Uint8Array {
	const bytes = new Uint8Array(10),
		view = new DataView(bytes.buffer);
	view.setUint16(0, source);
	view.setUint16(2, target);
	view.setUint16(4, 10);
	bytes.set(payload, 8);
	return bytes;
}
async function sendRaw(
	index: number,
	source: string,
	remote: string,
	payload: Uint8Array,
) {
	const { dlopen, FFIType: t, ptr } = await import("bun:ffi"),
		library = dlopen("libc.so.6", {
			socket: { args: [t.i32, t.i32, t.i32], returns: t.i32 },
			setsockopt: { args: [t.i32, t.i32, t.i32, t.ptr, t.u32], returns: t.i32 },
			sendto: {
				args: [t.i32, t.ptr, t.u64, t.i32, t.ptr, t.u32],
				returns: t.i64,
			},
			close: { args: [t.i32], returns: t.i32 },
		}),
		c = library.symbols,
		src = parseIpv4(source),
		dst = parseIpv4(remote);
	if (!src || !dst) {
		library.close();
		throw new Error("Invalid raw fixture address");
	}
	const packet = new Uint8Array(30),
		view = new DataView(packet.buffer),
		datagram = udp(19001, 19000, payload);
	const check = checksum([src, dst, Uint8Array.of(0, 17, 0, 10), datagram]);
	new DataView(datagram.buffer).setUint16(6, check || 0xffff);
	packet[0] = 0x45;
	view.setUint16(2, 30);
	packet[8] = 64;
	packet[9] = 17;
	packet.set(src, 12);
	packet.set(dst, 16);
	packet.set(datagram, 20);
	view.setUint16(10, checksum([packet.subarray(0, 20)]));
	const fd = c.socket(2, 3 | 0x800 | 0x80000, 255);
	try {
		const binding = new Uint32Array([index]),
			hdr = new Uint32Array([1]),
			target = datagramSockaddr(remote, 0);
		if (
			fd < 0 ||
			c.setsockopt(fd, 1, 62, ptr(binding), 4) !== 0 ||
			c.setsockopt(fd, 0, 3, ptr(hdr), 4) !== 0 ||
			Number(
				c.sendto(fd, ptr(packet), packet.length, 0, ptr(target), target.length),
			) !== packet.length
		)
			throw new Error("Bound raw fixture packet unavailable");
	} finally {
		if (fd >= 0) c.close(fd);
		library.close();
	}
}
async function capture(name: string, path: string, family: 4 | 6) {
	const child = Bun.spawn(
		[
			"tcpdump",
			"-n",
			"-Z",
			"root",
			"-U",
			"-s",
			"256",
			"-c",
			"4",
			"-i",
			name,
			"-w",
			path,
			family === 4 ? "ip" : "ip6",
			"and",
			"udp",
			"and",
			"port",
			"19000",
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	const close = async () => {
		if (child.exitCode === null) child.kill("SIGINT");
		await Promise.race([child.exited, Bun.sleep(750)]);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	};
	for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
		const bytes = await readFile(path).catch(() => new Uint8Array());
		if (bytes.length >= 24) return { child, close };
		await Bun.sleep(10);
	}
	await close();
	throw new Error(
		`Fixture capture unavailable: ${await new Response(child.stderr).text()}`,
	);
}
function packets(bytes: Uint8Array): Uint8Array[] {
	if (bytes.length < 24 || bytes.length > 8192)
		throw new Error("Unknown fixture pcap size");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		magic = view.getUint32(0),
		little = magic === 0xd4c3b2a1;
	if (!little && magic !== 0xa1b2c3d4)
		throw new Error("Unknown fixture pcap format");
	const type = view.getUint32(20, little),
		frames: Uint8Array[] = [];
	if (![1, 101, 228, 229].includes(type))
		throw new Error(`Unknown fixture datalink ${type}`);
	for (let at = 24; at < bytes.length; ) {
		if (at + 16 > bytes.length) throw new Error("Short fixture record");
		const length = view.getUint32(at + 8, little),
			original = view.getUint32(at + 12, little);
		at += 16;
		if (length !== original || length > 256 || at + length > bytes.length)
			throw new Error("Truncated fixture packet");
		frames.push(bytes.slice(at + (type === 1 ? 14 : 0), at + length));
		at += length;
	}
	if (frames.length !== 4)
		throw new Error(`Expected four fixture packets, got ${frames.length}`);
	return frames;
}
/** Actual pinned translator data, with a crafted valid IPv4 UDP request whose
 * IPv6 result computes to zero, then a second request whose return IPv4 result
 * computes to zero. Wire capture must contain 0xffff in both directions.
 */
export async function proveCellularUdpZero(input: {
	readonly index: number;
	readonly tun: string;
	readonly physical: string;
	readonly source: string;
	readonly remote: string;
	readonly mapped: string;
	readonly nat64: string;
}): Promise<void> {
	const src4 = parseIpv4(input.source),
		dst4 = parseIpv4(input.remote),
		src6 = parseIpv6(input.mapped),
		prefix = parseNat64Prefix(input.nat64),
		dst6 = prefix && parseIpv6(synthesizeNat64(prefix, input.remote) ?? "");
	if (!src4 || !dst4 || !src6 || !dst6)
		throw new Error("Invalid zero-checksum fixture mapping");
	const outbound = checksum([
			src6,
			dst6,
			Uint8Array.of(0, 0, 0, 10, 0, 0, 0, 17),
			udp(19001, 19000),
		]),
		inbound = checksum([
			dst4,
			src4,
			Uint8Array.of(0, 17, 0, 10),
			udp(19000, 19001),
		]),
		payloads = [outbound, inbound].map((value) => {
			const p = new Uint8Array(2);
			new DataView(p.buffer).setUint16(0, value);
			return p;
		});
	const root = await mkdtemp(join(tmpdir(), "cellular-udp-zero-")),
		receiver = createSocket("udp4");
	let first: Awaited<ReturnType<typeof capture>> | undefined,
		second: Awaited<ReturnType<typeof capture>> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			receiver.once("error", reject);
			receiver.bind(19001, input.source, resolve);
		});
		first = await capture(input.physical, join(root, "v6.pcap"), 6);
		second = await capture(input.tun, join(root, "v4.pcap"), 4);
		for (const payload of payloads) {
			const reply = new Promise<Uint8Array>((resolve, reject) => {
				const onMessage = (
						data: Buffer,
						peer: { address: string; port: number },
					) => {
						clearTimeout(timer);
						receiver.off("message", onMessage);
						if (peer.address !== input.remote || peer.port !== 19000)
							reject(new Error("Wrong zero fixture responder"));
						else resolve(data);
					},
					timer = setTimeout(() => {
						receiver.off("message", onMessage);
						reject(new Error("Zero fixture reply timeout"));
					}, 2000);
				receiver.on("message", onMessage);
			});
			await sendRaw(input.index, input.source, input.remote, payload);
			const bytes = await reply;
			if (Buffer.compare(Buffer.from(bytes), Buffer.from(payload)) !== 0)
				throw new Error("Zero fixture payload changed");
		}
		for (const process of [first, second]) {
			await Promise.race([process.child.exited, Bun.sleep(1500)]);
			if (process.child.exitCode !== 0) {
				await process.close();
				throw new Error(
					`Zero fixture capture incomplete: ${await new Response(process.child.stderr).text()}`,
				);
			}
		}
		const v6 = packets(await readFile(join(root, "v6.pcap"))),
			v4 = packets(await readFile(join(root, "v4.pcap")));
		const check = (
			frames: Uint8Array[],
			version: number,
			sourcePort: number,
			payload: Uint8Array,
		) => {
			const found = frames.filter((packet) => {
				const offset = version === 6 ? 40 : ((packet[0] ?? 0) % 16) * 4;
				return (
					(packet[0] ?? 0) >>> 4 === version &&
					packet.length === offset + 10 &&
					new DataView(packet.buffer, packet.byteOffset).getUint16(offset) ===
						sourcePort &&
					Buffer.compare(
						Buffer.from(packet.subarray(offset + 8)),
						Buffer.from(payload),
					) === 0
				);
			});
			if (found.length !== 1)
				throw new Error("Zero fixture packet missing or repeated");
			const packet = found[0];
			if (!packet) throw new Error("Zero fixture packet unavailable");
			const at = version === 6 ? 40 : ((packet[0] ?? 0) % 16) * 4;
			if (
				new DataView(packet.buffer, packet.byteOffset).getUint16(at + 6) !==
				0xffff
			)
				throw new Error(
					`UDP computed-zero translation omitted 0xffff for IPv${version}`,
				);
		};
		check(v6, 6, 19001, payloads[0] ?? new Uint8Array());
		check(v4, 4, 19000, payloads[1] ?? new Uint8Array());
	} finally {
		await first?.close();
		await second?.close();
		await new Promise<void>((resolve) => receiver.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}
