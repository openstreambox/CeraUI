import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function loadNetlink() {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		throw new Error("Indexed link control unavailable");
	const ffi = await import("bun:ffi"),
		{ FFIType: t } = ffi;
	const library = ffi.dlopen("libc.so.6", {
		socket: { args: [t.i32, t.i32, t.i32], returns: t.i32 },
		bind: { args: [t.i32, t.ptr, t.u32], returns: t.i32 },
		sendto: {
			args: [t.i32, t.ptr, t.u64, t.i32, t.ptr, t.u32],
			returns: t.i64,
		},
		recvfrom: {
			args: [t.i32, t.ptr, t.u64, t.i32, t.ptr, t.ptr],
			returns: t.i64,
		},
		close: { args: [t.i32], returns: t.i32 },
	});
	return { library, ffi };
}
let runtime: ReturnType<typeof loadNetlink> | undefined;
/** One RTM_NEWLINK request with only IFF_UP in the change mask. The kernel
 * target is an interface index, so a reused name never redirects the write.
 * Caller records the baseline durably and guards USB identity around this call.
 */
export async function setLinkUpByIndex(
	index: number,
	up: boolean,
): Promise<boolean> {
	if (!Number.isInteger(index) || index < 1 || index > 0x7fffffff)
		throw new Error("Invalid link index");
	runtime ??= loadNetlink();
	const { library, ffi } = await runtime,
		c = library.symbols;
	const fd = c.socket(16, 3 | 0x800 | 0x80000, 0);
	if (fd < 0) return false;
	try {
		const address = new Uint8Array(12),
			av = new DataView(address.buffer);
		av.setUint16(0, 16, true);
		if (c.bind(fd, ffi.ptr(address), address.length) !== 0) return false;
		const request = new Uint8Array(32),
			view = new DataView(request.buffer),
			seq = randomInt(1, 0x7fffffff);
		view.setUint32(0, request.length, true);
		view.setUint16(4, 16, true);
		view.setUint16(6, 1 | 4, true);
		view.setUint32(8, seq, true);
		view.setInt32(20, index, true);
		view.setUint32(24, up ? 1 : 0, true);
		view.setUint32(28, 1, true);
		if (
			Number(
				c.sendto(
					fd,
					ffi.ptr(request),
					request.length,
					0,
					ffi.ptr(address),
					address.length,
				),
			) !== request.length
		)
			return false;
		const reply = new Uint8Array(4096),
			sender = new Uint8Array(12),
			senderLength = new Uint32Array([12]),
			deadline = performance.now() + 1000;
		while (performance.now() < deadline) {
			senderLength[0] = 12;
			const length = Number(
				c.recvfrom(
					fd,
					ffi.ptr(reply),
					reply.length,
					0x20,
					ffi.ptr(sender),
					ffi.ptr(senderLength),
				),
			);
			if (length < 0) {
				await delay(5);
				continue;
			}
			if (
				length < 36 ||
				length > reply.length ||
				senderLength[0] !== 12 ||
				new DataView(sender.buffer).getUint32(4, true) !== 0
			)
				return false;
			const ack = new DataView(reply.buffer);
			if (
				ack.getUint32(0, true) > length ||
				ack.getUint32(0, true) < 36 ||
				ack.getUint16(4, true) !== 2 ||
				ack.getUint32(8, true) !== seq ||
				ack.getUint32(28, true) !== seq ||
				ack.getUint16(24, true) !== 16
			)
				return false;
			return ack.getInt32(16, true) === 0;
		}
		return false;
	} finally {
		c.close(fd);
	}
}
