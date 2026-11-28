import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_BUILD_PARAM } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import type { Server, ServerWebSocket } from "bun";
import { createContext } from "../rpc/context.ts";
import { E2E_WORKER_PROXY_SECRET_HEADER } from "../rpc/e2e-worker-admission.ts";
import {
	type IngressLink,
	ingressLinkHolds,
	type LocalIngressStartDeps,
	parseIngressPath,
	serveLocalIngress,
	startLocalIngress,
} from "../rpc/local-ingress.ts";
import { createCaptivePortalProcedure } from "../rpc/procedures/captive-portal.procedure.ts";
import { upgradeTcpRequest } from "../rpc/server.ts";
import type {
	AppWebSocket,
	ServerSocketData,
	SocketData,
} from "../rpc/types.ts";

// The front door's AP listener: the box is 10.42.0.1/24 on the hotspot radio.
const AP = "wlx02000000b83e";
const links: IngressLink[] = [
	{ name: "lo", address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" },
	{ name: AP, address: "10.42.0.1", netmask: "255.255.255.0", family: "IPv4" },
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
		interface: AP,
		local: "10.42.0.1",
		...overrides,
	});
const headersWith = (header: string | null, extra: [string, string][] = []) => {
	const headers = new Headers(extra);
	if (header !== null) headers.set("X-Ceralive-Button-Path", header);
	return headers;
};

describe("front door evidence", () => {
	test("a direct phone on the hotspot is accepted with its own address", () => {
		expect(parseIngressPath(headersWith(evidence()), () => links)).toEqual({
			peer: "10.42.0.13",
			interface: AP,
			local: "10.42.0.1",
		});
	});
	for (const [name, header] of [
		["missing", null],
		["not JSON", "10.42.0.13"],
		["JSON null", "null"],
		["an array", "[1]"],
		["another version", evidence({ version: 2 })],
		["an IPv6 peer", evidence({ peer: "fe80::1" })],
		["a peer that is not dotted IPv4", evidence({ peer: "10.42.0.1e1" })],
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
		["a numeric interface", evidence({ interface: 3 })],
		["oversized", evidence({ pad: "x".repeat(600) })],
	] as const)
		test(`evidence that is ${name} is refused`, () => {
			expect(parseIngressPath(headersWith(header), () => links)).toBeNull();
		});
	for (const name of ["Forwarded", "Via", "X-Forwarded-For", "x-forwarded-"])
		test(`forwarding metadata (${name}) refuses even valid evidence`, () => {
			expect(
				parseIngressPath(headersWith(evidence(), [[name, "x"]]), () => links),
			).toBeNull();
		});
	test("a failing interface read refuses", () => {
		expect(
			parseIngressPath(headersWith(evidence()), () => {
				throw new Error("no interfaces");
			}),
		).toBeNull();
	});
	// Link tables the OS would not normally report, so each rule is shown to
	// matter on its own.
	test("a malformed interface name refuses even when a link carries it", () => {
		const odd = "a b";
		expect(
			parseIngressPath(headersWith(evidence({ interface: odd })), () => [
				{ ...(links[1] as IngressLink), name: odd },
			]),
		).toBeNull();
	});
	test("a 0/8 peer refuses even inside a 0/8 link", () => {
		expect(
			parseIngressPath(
				headersWith(evidence({ peer: "0.0.0.7", local: "0.0.0.1" })),
				() => [{ ...(links[1] as IngressLink), address: "0.0.0.1" }],
			),
		).toBeNull();
	});
	for (const [name, link, peer] of [
		["an IPv6 entry", { family: "IPv6" }, "10.42.0.13"],
		["a non-IPv4 netmask", { netmask: "ffff:ffff::" }, "198.51.100.9"],
		["a zero netmask", { netmask: "0.0.0.0" }, "198.51.100.9"],
	] as const)
		test(`a link with ${name} vouches for no peer`, () => {
			expect(
				parseIngressPath(headersWith(evidence({ peer })), () => [
					{ ...(links[1] as IngressLink), ...link },
				]),
			).toBeNull();
		});
	test("a path that stopped holding stays invalid", () => {
		const path = parseIngressPath(headersWith(evidence()), () => links);
		if (!path) throw new Error("fixture evidence refused");
		let current = links;
		let holds = true;
		const recheck = () => {
			holds &&= ingressLinkHolds(path, () => current);
			return holds;
		};
		expect(recheck()).toBe(true);
		current = links.filter((link) => link.name !== AP);
		expect(recheck()).toBe(false);
		current = links;
		expect(recheck()).toBe(false);
	});
});

type Captured = {
	data?: ServerSocketData;
	ws?: ServerWebSocket<ServerSocketData>;
};
const capturing = (captured: Captured) => ({
	open(ws: ServerWebSocket<ServerSocketData>) {
		captured.data = ws.data;
		captured.ws = ws;
	},
	message() {},
});
const upgradeLines = (path: string, extra: string[] = [], method = "GET") => [
	`${method} ${path} HTTP/1.1`,
	"Host: ceralive.local",
	"Upgrade: websocket",
	"Connection: Upgrade",
	"Sec-WebSocket-Version: 13",
	"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
	...extra,
];
const statusLine = async (
	target: { unix: string } | { hostname: string; port: number },
	lines: string[],
) => {
	const chunks: Uint8Array[] = [];
	const done = Promise.withResolvers<void>();
	const client = await Bun.connect({
		...target,
		socket: {
			data: (_s, data) => {
				chunks.push(data);
				if (Buffer.concat(chunks).includes("\r\n\r\n")) done.resolve();
			},
			close: () => done.resolve(),
			error: () => done.resolve(),
		},
	} as Parameters<typeof Bun.connect>[0]);
	client.write(`${lines.join("\r\n")}\r\n\r\n`);
	await done.promise;
	client.end();
	return Buffer.concat(chunks).toString().split("\r\n")[0];
};
const header = (value = evidence()) => `X-Ceralive-Button-Path: ${value}`;

describe("transports", () => {
	let dir: string | undefined;
	let server: Server<ServerSocketData> | undefined;
	afterEach(() => {
		server?.stop(true);
		server = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});
	const unix = (options: Parameters<typeof serveLocalIngress>[1] = {}) => {
		dir = mkdtempSync(join(tmpdir(), "ingress-"));
		const socket = join(dir, "rpc.sock");
		server = serveLocalIngress(socket, { links: () => links, ...options });
		return { unix: socket };
	};

	test("the private listener upgrades only GET /ws with valid evidence", async () => {
		const target = unix();
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		for (const lines of [
			upgradeLines("/ws"),
			upgradeLines("/ws", [header(evidence({ peer: "10.43.0.1" }))]),
			upgradeLines("/ws", [header(), "Via: 1.1 proxy"]),
		])
			expect(await statusLine(target, lines)).toBe("HTTP/1.1 403 Forbidden");
		for (const lines of [
			upgradeLines("/preview", [header()]),
			upgradeLines("/ws", [header()], "POST"),
			upgradeLines("/ws", [header()]).filter((l) => !l.startsWith("Upgrade")),
		])
			expect(await statusLine(target, lines)).toBe("HTTP/1.1 404 Not Found");
	});

	test("the private listener applies the TCP listener's worker admission", async () => {
		const secret = "a".repeat(64);
		const target = unix({ workerSecret: secret });
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 403 Forbidden",
		);
		expect(
			await statusLine(
				target,
				upgradeLines("/ws", [
					header(),
					`${E2E_WORKER_PROXY_SECRET_HEADER}: ${secret}`,
				]),
			),
		).toBe("HTTP/1.1 101 Switching Protocols");
	});

	test("TCP never turns the front-door header into socket data", async () => {
		const captured: Captured = {};
		server = Bun.serve<ServerSocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, s) =>
				upgradeTcpRequest(request, s) ?? new Response(null, { status: 101 }),
			websocket: capturing(captured),
		});
		expect(
			await statusLine(
				{ hostname: "127.0.0.1", port: server.port as number },
				upgradeLines("/ws", [header()]),
			),
		).toBe("HTTP/1.1 101 Switching Protocols");
		await Bun.sleep(20);
		const data = captured.data as SocketData;
		expect(data.isAuthenticated).toBe(false);
		expect(data.ingressPath).toBeUndefined();
		expect(data.ingressPathValid).toBeUndefined();
	});

	test("a private-path socket records the UI build its page announced, as TCP does", async () => {
		const captured: Captured = {};
		const target = unix({ websocket: capturing(captured) });
		expect(
			await statusLine(
				target,
				upgradeLines(`/ws?${UI_BUILD_PARAM}=fixture-build-7`, [header()]),
			),
		).toBe("HTTP/1.1 101 Switching Protocols");
		await Bun.sleep(20);
		expect((captured.data as SocketData).uiBuild).toBe("fixture-build-7");
		// A page that names no build is recorded as naming none.
		captured.data = undefined;
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		await Bun.sleep(20);
		expect((captured.data as SocketData | undefined)?.uiBuild).toBeNull();
	});

	test("a private-path socket rechecks its link and stays invalid once it failed", async () => {
		const captured: Captured = {};
		let current = links;
		const target = unix({
			links: () => current,
			websocket: capturing(captured),
		});
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		await Bun.sleep(20);
		const valid = (captured.data as SocketData).ingressPathValid;
		expect(valid?.()).toBe(true);
		current = links.filter((link) => link.name !== AP);
		expect(valid?.()).toBe(false);
		current = links;
		expect(valid?.()).toBe(false);
	});

	// The socket comes from a real Unix upgrade and the procedure is the real
	// one; authentication is set on the socket directly (no login over the
	// socket), which shows the auth gate applies before and after.
	test("a private-path socket is refused until authenticated, then names its phone and AP", async () => {
		const captured: Captured = {};
		const target = unix({ websocket: capturing(captured) });
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		await Bun.sleep(20);
		const data = captured.data as SocketData;
		expect(data.isAuthenticated).toBe(false);
		expect(data.ingressPath).toEqual({
			peer: "10.42.0.13",
			interface: AP,
			local: "10.42.0.1",
		});
		const start = mock(async () => ({ phase: "signing_in" }));
		const procedure = createCaptivePortalProcedure({
			owner: async () => ({
				start,
				status: () => ({ phase: "idle" }),
				finish: async () => ({ phase: "idle" }),
				refresh: async () => ({ phase: "idle" }),
			}),
			settings: async () => ({
				getConfig: () => ({ captive_portal_enabled: true }),
				saveConfig: () => undefined,
				broadcastConfig: () => undefined,
			}),
		});
		const context = createContext(captured.ws as unknown as AppWebSocket);
		await expect(
			call(
				procedure,
				{ action: "start", radio: 2, incarnation: "venue-incarnation" },
				{ context },
			),
		).rejects.toThrow("Authentication required");
		expect(start).not.toHaveBeenCalled();
		data.isAuthenticated = true;
		await call(
			procedure,
			{ action: "start", radio: 2, incarnation: "venue-incarnation" },
			{ context },
		);
		expect(start).toHaveBeenCalledWith(
			"10.42.0.13",
			"2",
			"venue-incarnation",
			AP,
			data.ingressLifetime,
		);
	});

	test("a private-path socket carries its interface's accepted lifetime and fails once it changes", async () => {
		const captured: Captured = {};
		let current = { ifindex: 7 as number | undefined, incarnation: 41 };
		const seen: string[] = [];
		const target = unix({
			lifetime: (name) => {
				seen.push(name);
				return current;
			},
			websocket: capturing(captured),
		});
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		await Bun.sleep(20);
		const data = captured.data as SocketData;
		expect(data.ingressLifetime).toEqual({ ifindex: 7, incarnation: 41 });
		expect(seen).toEqual([AP]);
		expect(data.ingressPathValid?.()).toBe(true);
		// Replaced under its name: same link and subnet, a new kernel interface.
		current = { ifindex: 8, incarnation: 41 };
		expect(data.ingressPathValid?.()).toBe(false);
		current = { ifindex: 7, incarnation: 41 };
		expect(data.ingressPathValid?.()).toBe(false);
	});

	test("a re-registered interface also invalidates the socket's path", async () => {
		const captured: Captured = {};
		let incarnation = 41;
		const target = unix({
			lifetime: () => ({ ifindex: 7, incarnation }),
			websocket: capturing(captured),
		});
		expect(await statusLine(target, upgradeLines("/ws", [header()]))).toBe(
			"HTTP/1.1 101 Switching Protocols",
		);
		await Bun.sleep(20);
		const valid = (captured.data as SocketData).ingressPathValid;
		expect(valid?.()).toBe(true);
		incarnation = 42;
		expect(valid?.()).toBe(false);
	});
});

describe("startup guards", () => {
	const directory = "/run/test-ingress";
	const stats = (overrides: Partial<Record<string, unknown>> = {}) =>
		({
			isSymbolicLink: () => false,
			isDirectory: () => true,
			uid: 0,
			mode: 0o40700,
			...overrides,
		}) as unknown as Stats;
	const enoent = () =>
		Object.assign(new Error("ENOENT"), { code: "ENOENT" as const });
	const deps = (
		dir: Stats | Error,
		socket: Stats | Error = enoent(),
		uid: number | undefined = 0,
	) => {
		const stop = mock(() => undefined);
		const served = { stop } as unknown as Server<ServerSocketData>;
		const serve = mock(() => served);
		const chmod = mock((_path: string, _mode: number) => undefined);
		const d: LocalIngressStartDeps = {
			lstat: (path) => {
				const value = path === directory ? dir : socket;
				if (value instanceof Error) throw value;
				return value;
			},
			getuid: () => uid,
			chmod,
			serve,
		};
		return { d, stop, served, serve, chmod };
	};
	test("an absent directory starts nothing", () => {
		const { d, serve } = deps(enoent());
		expect(startLocalIngress(directory, d)).toBeNull();
		expect(serve).not.toHaveBeenCalled();
	});
	test("an unreadable directory is an error, not absence", () => {
		const { d } = deps(Object.assign(new Error("EACCES"), { code: "EACCES" }));
		expect(() => startLocalIngress(directory, d)).toThrow("EACCES");
	});
	for (const [reason, dir, uid] of [
		["directory is a symlink", stats({ isSymbolicLink: () => true }), 0],
		["not a directory", stats({ isDirectory: () => false }), 0],
		["directory not owned by root", stats({ uid: 1000 }), 0],
		["directory mode not 0700", stats({ mode: 0o40755 }), 0],
		["backend not running as root", stats(), 1000],
	] as const)
		test(`refuses: ${reason}`, () => {
			const { d, serve } = deps(dir, enoent(), uid);
			expect(() => startLocalIngress(directory, d)).toThrow(reason);
			expect(serve).not.toHaveBeenCalled();
		});
	test("an occupied socket path is never taken over", () => {
		const { d, serve } = deps(stats(), stats({ isDirectory: () => false }));
		expect(() => startLocalIngress(directory, d)).toThrow(
			"socket path already exists",
		);
		expect(serve).not.toHaveBeenCalled();
	});
	test("an unreadable socket path is an error", () => {
		const { d, serve } = deps(
			stats(),
			Object.assign(new Error("EACCES"), { code: "EACCES" }),
		);
		expect(() => startLocalIngress(directory, d)).toThrow("EACCES");
		expect(serve).not.toHaveBeenCalled();
	});
	test("a safe directory starts one listener with a 0600 socket", () => {
		const { d, served, serve, chmod } = deps(stats());
		expect(startLocalIngress(directory, d)).toBe(served);
		expect(serve).toHaveBeenCalledWith(`${directory}/rpc.sock`);
		expect(chmod).toHaveBeenCalledWith(`${directory}/rpc.sock`, 0o600);
	});
	test("a failed chmod stops the listener again", () => {
		const { d, stop } = deps(stats());
		d.chmod = () => {
			throw new Error("EPERM");
		};
		expect(() => startLocalIngress(directory, d)).toThrow("EPERM");
		expect(stop).toHaveBeenCalledWith(true);
	});
});
