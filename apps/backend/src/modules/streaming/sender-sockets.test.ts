import { expect, test } from "bun:test";
import { decodeProcAddress } from "./sender-sockets.ts";

test("decodes Linux IPv4, mapped IPv6, native IPv6 and rejects malformed addresses", () => {
	expect(decodeProcAddress("010200C0")).toBe("192.0.2.1");
	expect(decodeProcAddress("0000000000000000FFFF0000010200C0")).toBe(
		"192.0.2.1",
	);
	expect(decodeProcAddress("B80D0120000000000000000001000000")).toBe(
		"2001:db8::1",
	);
	expect(decodeProcAddress("no address")).toBeUndefined();
});
