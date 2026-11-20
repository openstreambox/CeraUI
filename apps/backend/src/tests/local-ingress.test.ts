import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type IngressLink,
	parseIngressPath,
	serveLocalIngress,
	startLocalIngress,
} from "../rpc/local-ingress.ts";

// The front door's AP listener: the box is 10.42.0.1/24 on the hotspot radio.
const links: IngressLink[] = [
	{ name: "lo", address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" },
	{
		name: "wlx02000000b83e",
		address: "10.42.0.1",
		netmask: "255.255.255.0",
		family: "IPv4",
	},
	{
		name: "eth0",
		address: "192.0.2.145",
		netmask: "255.255.255.0",
		family: "IPv4",
	},
];
const evidence = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		version: 1,
		peer: "10.42.0.13",
		interface: "wlx02000000b83e",
		local: "10.42.0.1",
		...overrides,
	});

describe("front door evidence", () => {
	test("a direct phone on the hotspot is accepted with its own address", () => {
		expect(parseIngressPath(evidence(), () => links)).toEqual({
			peer: "10.42.0.13",
			interface: "wlx02000000b83e",
			local: "10.42.0.1",
		});
	});
	for (const [name, header] of [
		["missing", null],
		["not JSON", "10.42.0.13"],
		["an array", "[1]"],
		["another version", evidence({ version: 2 })],
		["an IPv6 peer", evidence({ peer: "fe80::1" })],
		["a loopback peer", evidence({ peer: "127.0.0.1" })],
		[
			"a loopback path",
			evidence({ peer: "127.0.0.2", interface: "lo", local: "127.0.0.1" }),
		],
		["the box itself", evidence({ peer: "10.42.0.1" })],
		["a peer outside the subnet", evidence({ peer: "10.43.0.13" })],
		["an address on another interface", evidence({ interface: "eth0" })],
		["an address the box no longer has", evidence({ local: "10.42.0.2" })],
		["an unknown interface", evidence({ interface: "wlan9" })],
		["a malformed interface", evidence({ interface: "../wlan0" })],
		["oversized", evidence({ pad: "x".repeat(600) })],
	] as const)
		test(`evidence that is ${name} is refused`, () => {
			expect(parseIngressPath(header, () => links)).toBeNull();
		});
	test("a failing interface read refuses", () => {
		expect(
			parseIngressPath(evidence(), () => {
				throw new Error("no interfaces");
			}),
		).toBeNull();
	});
	test("a host-route address cannot vouch for any peer", () => {
		expect(
			parseIngressPath(evidence(), () => [
				{ ...(links[1] as IngressLink), netmask: "255.255.255.255" },
			]),
		).toBeNull();
	});
});

describe("private listener", () => {
	let dir: string | undefined;
	let server: ReturnType<typeof serveLocalIngress> | undefined;
	afterEach(() => {
		server?.stop(true);
		server = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});
	const request = async (socket: string, lines: string[]) => {
		const chunks: Uint8Array[] = [];
		const done = Promise.withResolvers<void>();
		const client = await Bun.connect({
			unix: socket,
			socket: {
				data: (_s, data) => {
					chunks.push(data);
					if (Buffer.concat(chunks).includes("\r\n\r\n")) done.resolve();
				},
				close: () => done.resolve(),
				error: () => done.resolve(),
			},
		});
		client.write(`${lines.join("\r\n")}\r\n\r\n`);
		await done.promise;
		client.end();
		return Buffer.concat(chunks).toString().split("\r\n")[0];
	};
	const upgrade = (path: string, header?: string) => [
		`GET ${path} HTTP/1.1`,
		"Host: ceralive.local",
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		...(header === undefined ? [] : [`X-Ceralive-Button-Path: ${header}`]),
	];
	test("only a /ws upgrade with valid evidence is accepted", async () => {
		dir = mkdtempSync(join(tmpdir(), "ingress-"));
		const socket = join(dir, "rpc.sock");
		server = serveLocalIngress(socket, () => links);
		expect(await request(socket, upgrade("/ws", evidence()))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		expect(await request(socket, upgrade("/ws"))).toBe(
			"HTTP/1.1 403 Forbidden",
		);
		expect(
			await request(socket, upgrade("/ws", evidence({ peer: "10.43.0.1" }))),
		).toBe("HTTP/1.1 403 Forbidden");
		expect(await request(socket, upgrade("/preview", evidence()))).toBe(
			"HTTP/1.1 404 Not Found",
		);
	});
	test("no runtime directory means no listener", () => {
		expect(
			startLocalIngress(join(tmpdir(), "absent-ingress-dir-x")),
		).toBeNull();
	});
	test("a directory that is not root-private is refused", () => {
		dir = mkdtempSync(join(tmpdir(), "ingress-"));
		expect(() => startLocalIngress(dir)).toThrow("root-owned");
	});
});
