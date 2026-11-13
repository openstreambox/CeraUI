import { expect, test } from "bun:test";
import { ingressAdmission } from "../modules/system/button-ingress.ts";

const link = { name: "eth0", address: "192.168.2.1", netmask: "255.255.255.0" };
function request(overrides = {}, headers = {}) {
	return new Request("http://localhost/ws", {
		headers: {
			"X-Ceralive-Button-Path": JSON.stringify({
				version: 1,
				peer: "192.168.2.4",
				interface: "eth0",
				local: link.address,
				...overrides,
			}),
			...headers,
		},
	});
}
test("dedicated ingress accepts direct LAN and hotspot clients only", () => {
	expect(ingressAdmission(request(), () => [link])?.()).toBe(true);
	const ap = { ...link, name: "ap0" };
	expect(ingressAdmission(request({ interface: "ap0" }), () => [ap])?.()).toBe(
		true,
	);
	expect(
		ingressAdmission(request({ interface: "tun0" }), () => [link]),
	).toBeNull();
	expect(ingressAdmission(request({ peer: "::1" }), () => [link])).toBeNull();
});
test("LAN proxy headers remain denied even through trusted ingress", () => {
	for (const header of [
		"Forwarded",
		"Via",
		"X-Forwarded-For",
		"X-Forwarded-Other",
	])
		expect(
			ingressAdmission(request({}, { [header]: "" }), () => [link]),
		).toBeNull();
});
test("an address change revokes a session permanently, including after address restoration", () => {
	let links = [link];
	const check = ingressAdmission(request(), () => links);
	if (!check) throw new Error("Expected admission");
	expect(check()).toBe(true);
	links = [{ ...link, address: "192.168.3.1" }];
	expect(check()).toBe(false);
	links = [link];
	expect(check()).toBe(false);
});
test("missing, malformed, repeated and unknown-version metadata fails closed", () => {
	for (const raw of [
		"",
		"{}",
		"null",
		"[]",
		"bad",
		'{"version":2}',
		'{"version":1},{}',
	]) {
		expect(
			ingressAdmission(
				new Request("http://localhost/ws", {
					headers: { "X-Ceralive-Button-Path": raw },
				}),
				() => [link],
			),
		).toBeNull();
	}
});

test("real Unix upgrade accepts helper evidence and rejects forwarded or missing evidence", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { connect } = await import("node:net");
	const { serveButtonIngress } = await import(
		"../rpc/button-ingress-server.ts"
	);
	const directory = mkdtempSync(`${tmpdir()}/button-ingress-`);
	const socket = `${directory}/rpc.sock`;
	const server = serveButtonIngress(socket, () => [link]);
	async function upgrade(headers: Headers) {
		return new Promise<string>((resolve, reject) => {
			const client = connect(socket);
			client.setTimeout(2000, () =>
				client.destroy(new Error("upgrade timeout")),
			);
			client.on("error", reject);
			client.on("connect", () =>
				client.write(
					"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
						[...headers]
							.map(([key, value]) => `${key}: ${value}\r\n`)
							.join("") +
						"\r\n",
				),
			);
			client.once("data", (data) => {
				resolve(data.toString().split("\r\n")[0] ?? "");
				client.destroy();
			});
		});
	}
	try {
		expect(await upgrade(request().headers)).toContain("101");
		expect(
			await upgrade(request({}, { Forwarded: "for=198.51.100.1" }).headers),
		).toContain("403");
		expect(await upgrade(new Headers())).toContain("403");
		expect(await upgrade(request({ interface: "tun0" }).headers)).toContain(
			"403",
		);
	} finally {
		server.stop(true);
		rmSync(directory, { recursive: true, force: true });
	}
});
