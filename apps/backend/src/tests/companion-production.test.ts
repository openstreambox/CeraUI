import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

import { logger } from "../helpers/logger.ts";
import {
	buildAuth,
	buildClaim,
	newClientNonce,
	verifyHello,
} from "../modules/companion/client.ts";
import {
	lazySetupHotspotCheck,
	setupHotspotInterface,
	tlsBindingFromCertificate,
} from "../modules/companion/ingress.ts";
import { generateP256 } from "../modules/companion/keys.ts";
import { connectCompanion } from "../modules/companion/stub-transport.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import { handleORPCMessage } from "../rpc/adapter.ts";
import { type IngressLink, serveLocalIngress } from "../rpc/local-ingress.ts";
import { companionProcedures } from "../rpc/procedures/companion-channel.procedure.ts";
import { logRpcCall } from "../rpc/rpc-logging.ts";
import type { AppWebSocket, ServerSocketData } from "../rpc/types.ts";
import {
	claimOwner,
	cleanupCompanionDirs,
	makeBox,
} from "./helpers/companion-fixture.ts";

/**
 * The companion routes as the image runs them: the production adapter and
 * router, the production procedure instance, and the front door's private
 * ingress listener. Only the store, the certificate path and the flag come
 * from the environment.
 */
const ROUTES = [
	"hello",
	"claim",
	"auth",
	"invite",
	"join",
	"allow",
	"devices",
	"revoke",
	"wifiImport",
] as const;
const openssl = Bun.which("openssl");
const root = mkdtempSync(join(tmpdir(), "companion-prod-"));
const saved = {
	flag: process.env.CERAUI_EXPERIMENTAL_COMPANION_CHANNEL,
	dir: process.env.CERAUI_COMPANION_STATE_DIR,
	cert: process.env.CERAUI_COMPANION_TLS_CERT,
};

afterAll(() => {
	for (const [key, value] of [
		["CERAUI_EXPERIMENTAL_COMPANION_CHANNEL", saved.flag],
		["CERAUI_COMPANION_STATE_DIR", saved.dir],
		["CERAUI_COMPANION_TLS_CERT", saved.cert],
	] as const)
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	cleanupCompanionDirs();
	rmSync(root, { recursive: true, force: true });
});

function fakeSocket(frames: string[], data: Record<string, unknown> = {}) {
	return {
		remoteAddress: "127.0.0.1",
		readyState: 1,
		data: { isAuthenticated: false, lastActive: 0, ...data },
		send: (frame: string) => frames.push(frame),
		close() {},
	} as unknown as AppWebSocket;
}

describe("flag off", () => {
	test("every companion route answers disabled through the production adapter and touches no state", async () => {
		delete process.env.CERAUI_EXPERIMENTAL_COMPANION_CHANNEL;
		const dir = join(root, "never-created");
		process.env.CERAUI_COMPANION_STATE_DIR = dir;
		for (const route of ROUTES) {
			const frames: string[] = [];
			await handleORPCMessage(fakeSocket(frames), {
				id: route,
				path: ["companion", route],
				input: { client_nonce: newClientNonce().toString("base64") },
			});
			expect(frames).toEqual([
				JSON.stringify({ id: route, result: { status: "disabled" } }),
			]);
		}
		expect(existsSync(dir)).toBe(false);
	});
});

describe("secret-free debug and error paths", () => {
	test("refused calls carrying secrets leave nothing in replies, logs or traces", async () => {
		const box = makeBox();
		process.env.CERAUI_EXPERIMENTAL_COMPANION_CHANNEL = "1";
		process.env.CERAUI_COMPANION_STATE_DIR = box.store.dir;
		const secretText = box.setup.secret.toString("base64url");
		const logged: unknown[] = [];
		const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
			spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
				logged.push(args);
				return logger;
			}) as never),
		);
		try {
			const frames: string[] = [];
			const ws = fakeSocket(frames, {
				ingressPath: {
					peer: "198.51.100.5",
					interface: "eth0",
					local: "198.51.100.1",
				},
				ingressPathValid: () => true,
			});
			const clientNonce = newClientNonce();
			await handleORPCMessage(ws, {
				id: "h",
				path: ["companion", "hello"],
				input: { client_nonce: clientNonce.toString("base64") },
			});
			// No certificate configured: the front-door path is refused.
			expect(JSON.parse(frames[0] ?? "{}").result).toEqual({
				status: "refused",
			});
			const forged = buildClaim(
				{
					reply: {
						status: "ok",
						v: 1,
						box_nonce: "",
						identity: "",
						generation: 1,
						access_seq: 0,
						setup_id: box.setup.setupId,
						claimed: false,
						binding: "x",
						signature: "",
					},
					clientNonce,
					boxNonce: Buffer.alloc(32),
					identityFingerprint: box.identity.fingerprint,
				},
				box.setup,
				generateP256(),
				"Phone",
				"phone",
			);
			const wifi = {
				consent: true,
				network: {
					ssid: "Studio",
					security: "wpa-psk",
					password: "sample-only",
				},
			};
			for (const [route, input] of [
				["claim", forged],
				["wifiImport", wifi],
				["claim", "not an object"],
			] as const) {
				await handleORPCMessage(ws, {
					id: route,
					path: ["companion", route],
					input,
				});
				const trace: unknown[] = [];
				logRpcCall(
					{
						path: ["companion", route],
						input,
						ok: false,
						latencyMs: 1,
						cid: "t",
					},
					{
						sink: { debug: (_m, meta) => trace.push(meta) },
						now: () => 0,
						genCorrelationId: () => "t",
						isEnabled: () => true,
					},
				);
				expect(trace).toHaveLength(1);
				expect(trace[0]).not.toHaveProperty("args");
			}
			const everything = JSON.stringify([frames, logged]);
			for (const secret of [
				secretText,
				forged.claim_signature,
				forged.device_signature,
				"sample-only",
			])
				expect(everything).not.toContain(secret);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("setup ingress is the hotspot profile only", () => {
	const row = (fields: Record<string, unknown>) =>
		({
			ifname: "wlan0",
			hotspot: { conn: "hotspot-uuid" },
			...fields,
		}) as unknown as WifiInterface;

	test("an AP-mode connection that is not the hotspot profile is not the setup ingress", () => {
		expect(
			setupHotspotInterface([row({ conn: "hotspot-uuid" })], "wlan0"),
		).toBe(true);
		expect(
			setupHotspotInterface(
				[row({ conn: "other", activeMode: "ap" })],
				"wlan0",
			),
		).toBe(false);
		expect(
			setupHotspotInterface(
				[
					row({
						conn: "station",
						concurrentHotspot: { ifname: "ap0", activeConn: "hotspot-uuid" },
					}),
				],
				"ap0",
			),
		).toBe(true);
		expect(
			setupHotspotInterface(
				[
					row({ conn: "hotspot-uuid" }),
					row({ ifname: "wlan0", conn: "hotspot-uuid" }),
				],
				"wlan0",
			),
		).toBe(false);
	});

	test("the Wi-Fi modules load only when the check is first used", async () => {
		let loads = 0;
		const check = lazySetupHotspotCheck(async () => {
			loads += 1;
			return () => true;
		});
		expect(loads).toBe(0);
		expect(check("wlan0")).toBe(false);
		await Bun.sleep(0);
		expect(loads).toBe(1);
		expect(check("wlan0")).toBe(true);
		expect(loads).toBe(1);
	});
});

describe.skipIf(!openssl)(
	"real front-door ingress through the production adapter",
	() => {
		let server: Server<ServerSocketData> | undefined;
		let socketPath = "";
		let certPath = "";
		const links: IngressLink[] = [
			{
				name: "lo",
				address: "127.0.0.1",
				netmask: "255.0.0.0",
				family: "IPv4",
			},
			{
				name: "eth0",
				address: "198.51.100.1",
				netmask: "255.255.255.0",
				family: "IPv4",
			},
		];

		beforeAll(() => {
			certPath = join(root, "box.crt");
			const run = Bun.spawnSync([
				openssl ?? "openssl",
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:P-256",
				"-nodes",
				"-keyout",
				join(root, "box.key"),
				"-out",
				certPath,
				"-days",
				"1",
				"-subj",
				"/CN=box.local",
			]);
			if (run.exitCode !== 0) throw Error("openssl failed");
			socketPath = join(root, "rpc.sock");
			server = serveLocalIngress(socketPath, { links: () => links });
		});
		afterAll(() => server?.stop(true));

		test("hello carries the served certificate's binding; claim is refused on Ethernet; an owner signs in; closing forgets the socket", async () => {
			const box = makeBox();
			const owner = claimOwner(box);
			process.env.CERAUI_EXPERIMENTAL_COMPANION_CHANNEL = "1";
			process.env.CERAUI_COMPANION_STATE_DIR = box.store.dir;
			process.env.CERAUI_COMPANION_TLS_CERT = certPath;
			const binding = tlsBindingFromCertificate(certPath);
			const evidence = JSON.stringify({
				version: 1,
				peer: "198.51.100.5",
				interface: "eth0",
				local: "198.51.100.1",
			});
			const connection = await connectCompanion(new URL("ws://127.0.0.1/ws"), {
				connect: () => net.connect({ path: socketPath }),
				headers: [`X-Ceralive-Button-Path: ${evidence}`],
			});
			try {
				const hello = async () => {
					const clientNonce = newClientNonce();
					const reply = await connection.rpc(["companion", "hello"], {
						client_nonce: clientNonce.toString("base64"),
					});
					// The front door terminates TLS with this certificate.
					return verifyHello(reply, {
						clientNonce,
						observedBinding: binding ?? "",
						fingerprint: box.identity.fingerprint,
					});
				};
				const first = await hello();
				expect(first.reply.binding).toBe(binding as string);
				expect(
					await connection.rpc(
						["companion", "claim"],
						buildClaim(first, box.setup, generateP256(), "Late", "phone"),
					),
				).toEqual({ status: "refused" });
				const second = await hello();
				expect(
					await connection.rpc(
						["companion", "auth"],
						buildAuth(second, owner.device),
					),
				).toMatchObject({ status: "ok", role: "owner" });
				const list = (await connection.rpc(["companion", "devices"], {})) as {
					status: string;
				};
				expect(list.status).toBe("ok");
				expect(companionProcedures.trackedSockets()).toBe(1);
			} finally {
				connection.close();
			}
			await connection.closed;
			await Bun.sleep(50);
			expect(companionProcedures.trackedSockets()).toBe(0);
			expect(readFileSync(join(box.store.dir, "state.json"), "utf8")).toContain(
				owner.id,
			);
		});
	},
);
