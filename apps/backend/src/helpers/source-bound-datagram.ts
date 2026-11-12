import { isIPv4, isIPv6 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parseIpv4, parseIpv6 } from "../modules/network/nat64.ts";
import { isSafeIfname } from "../modules/network/safe-ifname.ts";

export interface BoundDatagram {
	readonly device: string;
	readonly ifindex?: number;
	readonly source: string;
	readonly remote: string;
	readonly port: number;
	readonly payload: Uint8Array;
	readonly timeoutMs: number;
	readonly maxReplyBytes: number;
	readonly signal?: AbortSignal;
}
async function openSocketLibrary() {
	if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch))
		throw new Error("Source/device sockets are unavailable");
	const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
	const library = dlopen("libc.so.6", {
		socket: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
		setsockopt: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		bind: {
			args: [FFIType.i32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		connect: {
			args: [FFIType.i32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		send: {
			args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32],
			returns: FFIType.i64,
		},
		recv: {
			args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32],
			returns: FFIType.i64,
		},
		close: { args: [FFIType.i32], returns: FFIType.i32 },
		if_nametoindex: { args: [FFIType.ptr], returns: FFIType.u32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	return {
		library,
		ptr,
		errno: () => {
			const pointer = library.symbols.__errno_location();
			if (!pointer) throw new Error("Socket error unavailable");
			return read.i32(pointer);
		},
	};
}
let sockets: ReturnType<typeof openSocketLibrary> | undefined;
export function datagramSockaddr(
	address: string,
	port: number,
	scopeId = 0,
): Uint8Array {
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("Invalid datagram port");
	const v4 = isIPv4(address),
		bytes = v4
			? parseIpv4(address)
			: isIPv6(address)
				? parseIpv6(address)
				: undefined;
	if (!bytes) throw new Error("Datagram endpoint must be a literal address");
	const result = new Uint8Array(v4 ? 16 : 28),
		view = new DataView(result.buffer);
	view.setUint16(0, v4 ? 2 : 10, true);
	view.setUint16(2, port, false);
	result.set(bytes, v4 ? 4 : 8);
	if (!v4) view.setUint32(24, scopeId, true);
	return result;
}
/** One connected UDP socket, bound to BOTH the source and netdev. No resolver,
 * default-route fallback, retries, TCP fallback or unbounded receive loop.
 */
export async function exchangeSourceBoundDatagram(
	input: BoundDatagram,
): Promise<Uint8Array | undefined> {
	if (
		!isSafeIfname(input.device) ||
		(input.ifindex !== undefined &&
			(!Number.isInteger(input.ifindex) ||
				input.ifindex < 1 ||
				input.ifindex > 0x7fffffff)) ||
		!input.payload.length ||
		input.payload.length > 512 ||
		!Number.isInteger(input.maxReplyBytes) ||
		input.maxReplyBytes < 12 ||
		input.maxReplyBytes > 4096 ||
		!Number.isInteger(input.timeoutMs) ||
		input.timeoutMs < 1 ||
		input.timeoutMs > 5000 ||
		isIPv4(input.source) !== isIPv4(input.remote)
	)
		throw new Error("Invalid bound datagram limits");
	const local = datagramSockaddr(input.source, 0);
	if (input.signal?.aborted) return undefined;
	sockets ??= openSocketLibrary();
	const { library, ptr, errno } = await sockets,
		c = library.symbols;
	const device = Buffer.from(`${input.device}\0`),
		scope = c.if_nametoindex(ptr(device));
	if (!scope || (input.ifindex !== undefined && scope !== input.ifindex))
		throw new Error("Datagram device binding unavailable");
	const remote = datagramSockaddr(
		input.remote,
		input.port,
		isIPv6(input.remote) ? scope : 0,
	);
	const fd = c.socket(isIPv4(input.source) ? 2 : 10, 2 | 0x800 | 0x80000, 17);
	if (fd < 0) return undefined;
	try {
		// SO_BINDTOIFINDEX seals the observed kernel instance: an interface-name
		// replacement between lookup and setsockopt cannot acquire this socket.
		const binding = new Uint32Array([scope]);
		if (
			c.setsockopt(fd, 1, 62, ptr(binding), binding.byteLength) !== 0 ||
			c.bind(fd, ptr(local), local.length) !== 0
		)
			throw new Error("Datagram source/device binding unavailable");
		if (c.connect(fd, ptr(remote), remote.length) !== 0) return undefined;

		if (
			input.signal?.aborted ||
			Number(c.send(fd, ptr(input.payload), input.payload.length, 0)) !==
				input.payload.length
		)
			return undefined;
		const deadline = performance.now() + input.timeoutMs,
			reply = new Uint8Array(input.maxReplyBytes);
		while (performance.now() < deadline && !input.signal?.aborted) {
			// MSG_TRUNC returns the original datagram length, so truncation cannot look
			// like a complete, successful DNS answer.
			const length = Number(c.recv(fd, ptr(reply), reply.length, 0x20));
			if (length >= 0)
				return length > reply.length ? undefined : reply.slice(0, length);
			const error = errno();
			if (error !== 11 && error !== 4) return undefined;
			await delay(Math.min(20, Math.max(1, deadline - performance.now())));
		}
		return undefined;
	} finally {
		c.close(fd);
	}
}
