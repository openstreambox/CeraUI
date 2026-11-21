import { describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { decodeProcAddress, senderSocketSources } from "./sender-sockets.ts";

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

function bind(type: "udp4" | "udp6", address: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createSocket({ type });
		socket.once("error", reject);
		socket.bind(0, address, () => resolve(socket));
	});
}

// Reads this test process's own descriptors, so it needs no root and no
// namespace. Loopback addresses other than 127.0.0.1 stand in for link
// addresses; procfs exists only on Linux.
describe.skipIf(process.platform !== "linux")("senderSocketSources", () => {
	test("reports the PID's own bound UDP sources from both tables", async () => {
		const own = [
			await bind("udp4", "127.0.0.2"),
			await bind("udp6", "::ffff:127.0.0.3"),
			await bind("udp4", "127.0.0.1"),
			await bind("udp4", "0.0.0.0"),
		];
		// Another process's socket shares the namespace's tables, never our fds.
		const other = Bun.spawn(
			[
				process.execPath,
				"-e",
				"require('node:dgram').createSocket('udp4').bind(0,'127.0.0.4',()=>console.log('ready'));setInterval(()=>{},1000)",
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		try {
			const reader = other.stdout.getReader();
			await reader.read();
			reader.releaseLock();
			const sources = await senderSocketSources(process.pid);
			expect(sources).toContain("127.0.0.2");
			// A v4-mapped address on a udp6 socket comes back as plain IPv4.
			expect(sources).toContain("127.0.0.3");
			expect(sources).not.toContain("127.0.0.1");
			expect(sources).not.toContain("0.0.0.0");
			expect(sources).not.toContain("127.0.0.4");
			const otherSources = await senderSocketSources(other.pid);
			expect(otherSources).toEqual(["127.0.0.4"]);
		} finally {
			other.kill();
			await other.exited;
			for (const socket of own) socket.close();
		}
	});

	test("a missing process is an error for the caller to treat as unknown", async () => {
		const gone = Bun.spawn([process.execPath, "-e", ""]);
		await gone.exited;
		await expect(senderSocketSources(gone.pid)).rejects.toThrow();
	});
});
