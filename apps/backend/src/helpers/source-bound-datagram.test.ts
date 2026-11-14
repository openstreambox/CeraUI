import { expect, test } from "bun:test";
import {
	datagramSockaddr,
	exchangeSourceBoundDatagram,
} from "./source-bound-datagram.ts";

test("socket addresses retain whole fields, network-order ports and IPv6 interface scope", () => {
	const v4 = datagramSockaddr("192.0.2.53", 53),
		v6 = datagramSockaddr("fe80::53", 53, 17);
	expect([...v4.slice(0, 8)]).toEqual([2, 0, 0, 53, 192, 0, 2, 53]);
	expect(v6.length).toBe(28);
	expect(new DataView(v6.buffer).getUint32(24, true)).toBe(17);
	expect(() => datagramSockaddr("resolver.example", 53)).toThrow();
});
test("invalid binding and receive limits dispatch no socket or resolver", async () => {
	const base = {
		device: "lo",
		source: "127.0.0.1",
		remote: "127.0.0.1",
		port: 53,
		payload: Uint8Array.of(1),
		timeoutMs: 10,
		maxReplyBytes: 4096,
	};
	await expect(
		exchangeSourceBoundDatagram({ ...base, maxReplyBytes: 65536 }),
	).rejects.toThrow();
	await expect(
		exchangeSourceBoundDatagram({ ...base, remote: "::1" }),
	).rejects.toThrow();
	const signal = AbortSignal.abort();
	expect(
		await exchangeSourceBoundDatagram({ ...base, signal }),
	).toBeUndefined();
});
