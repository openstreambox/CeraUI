import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { call } from "@orpc/server";
import type { Server } from "bun";

import { AttemptBudget } from "../modules/companion/budget.ts";
import { CompanionChannel } from "../modules/companion/channel.ts";
import {
	buildAuth,
	buildClaim,
	CompanionClientError,
	newClientNonce,
	verifyHello,
} from "../modules/companion/client.ts";
import {
	classifyCompanionIngress,
	tlsBindingFromCertificate,
} from "../modules/companion/ingress.ts";
import { generateP256 } from "../modules/companion/keys.ts";
import {
	type CompanionConnection,
	connectCompanion,
} from "../modules/companion/stub-transport.ts";
import { createCompanionProcedures } from "../rpc/procedures/companion-channel.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import { cleanupCompanionDirs, makeBox } from "./helpers/companion-fixture.ts";

/**
 * End to end over real TLS: the companion reads the server key from the same
 * connection that carries its calls, and a TLS-terminating relay with its own
 * certificate is caught before the claim is sent. Needs the openssl CLI to
 * mint throwaway certificates; skipped without it.
 */
const openssl = Bun.which("openssl");
const dir = mkdtempSync(join(tmpdir(), "companion-tls-"));

function mintCertificate(name: string) {
	const key = join(dir, `${name}.key`);
	const cert = join(dir, `${name}.crt`);
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
		key,
		"-out",
		cert,
		"-days",
		"1",
		"-subj",
		`/CN=${name}.local`,
	]);
	if (run.exitCode !== 0) throw Error("openssl failed");
	return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

let box: ReturnType<typeof makeBox>;
let server: Server<unknown> | undefined;
let relay: tls.Server | undefined;
let boxPort = 0;
let relayPort = 0;
let peerInterface = "ap0";

beforeAll(async () => {
	if (!openssl) return;
	const boxCert = mintCertificate("box");
	const relayCert = mintCertificate("relay");
	box = makeBox();
	const procedures = createCompanionProcedures({
		enabled: () => true,
		createChannel: (onRevoked) =>
			new CompanionChannel({
				store: box.store,
				budget: new AttemptBudget(),
				onRevoked,
			}),
		// Stands in for the front door's interface evidence; the binding is the
		// real certificate this server presents.
		ingress: (context) =>
			classifyCompanionIngress(context, {
				frontDoor: () => true,
				isSetupHotspot: (ifname) => ifname === "ap0",
				tlsBinding: () => tlsBindingFromCertificate(boxCert.certPath),
			}),
		saveNetwork: async () => ({ status: "saved", uuid: "u" }),
	});
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		tls: { key: boxCert.key, cert: boxCert.cert },
		fetch(req, srv) {
			return srv.upgrade(req, {
				data: { lastActive: 0, isAuthenticated: false },
			})
				? undefined
				: new Response("no", { status: 400 });
		},
		websocket: {
			async message(ws, raw) {
				const { id, path, input } = JSON.parse(String(raw));
				const data = ws.data as Record<string, unknown>;
				data.ingressPath = {
					peer: "192.0.2.2",
					interface: peerInterface,
					local: "192.0.2.1",
				};
				data.ingressPathValid = () => true;
				const context = {
					ws: ws as unknown as AppWebSocket,
					getSenderId: () => undefined,
				} as unknown as RPCContext;
				const procedure = (procedures as Record<string, unknown>)[path[1]];
				const result = await call(procedure as never, input, { context });
				ws.send(JSON.stringify({ id, result }));
			},
		},
	});
	boxPort = server.port ?? 0;
	// A relay that terminates TLS with its own certificate and forwards the
	// decrypted bytes to the real box.
	relay = tls.createServer(
		{ key: relayCert.key, cert: relayCert.cert },
		(client) => {
			const upstream = tls.connect({
				host: "127.0.0.1",
				port: boxPort,
				rejectUnauthorized: false,
			});
			client.pipe(upstream).pipe(client);
			client.on("error", () => upstream.destroy());
			upstream.on("error", () => client.destroy());
		},
	);
	await new Promise<void>((resolve) => relay?.listen(0, "127.0.0.1", resolve));
	relayPort = (relay.address() as { port: number }).port;
});

afterAll(() => {
	server?.stop(true);
	relay?.close();
	cleanupCompanionDirs();
	rmSync(dir, { recursive: true, force: true });
});

async function helloOver(connection: CompanionConnection, setup: boolean) {
	const clientNonce = newClientNonce();
	const reply = await connection.rpc(["companion", "hello"], {
		client_nonce: clientNonce.toString("base64"),
	});
	return verifyHello(reply, {
		clientNonce,
		observedBinding: connection.binding,
		fingerprint: box.identity.fingerprint,
		...(setup ? { setup: box.setup } : {}),
	});
}

describe.skipIf(!openssl)("companion channel over real TLS", () => {
	test("a relay with its own certificate is caught; the direct connection claims and signs in", async () => {
		const viaRelay = await connectCompanion(
			new URL(`wss://127.0.0.1:${relayPort}/ws`),
		);
		try {
			await helloOver(viaRelay, true);
			throw Error("the relay was not detected");
		} catch (error) {
			expect(error).toBeInstanceOf(CompanionClientError);
			expect((error as CompanionClientError).code).toBe("binding_mismatch");
		} finally {
			viaRelay.close();
		}
		expect(box.store.read().devices).toHaveLength(0);

		const device = generateP256();
		const direct = await connectCompanion(
			new URL(`wss://127.0.0.1:${boxPort}/ws`),
		);
		try {
			const verified = await helloOver(direct, true);
			const claimed = await direct.rpc(
				["companion", "claim"],
				buildClaim(verified, box.setup, device, "Phone", "phone"),
			);
			expect(claimed).toMatchObject({ status: "ok" });
		} finally {
			direct.close();
		}

		peerInterface = "eth0";
		const later = await connectCompanion(
			new URL(`wss://127.0.0.1:${boxPort}/ws`),
		);
		try {
			const verified = await helloOver(later, false);
			expect(
				await later.rpc(["companion", "auth"], buildAuth(verified, device)),
			).toMatchObject({ status: "ok", role: "owner" });
			expect(
				await later.rpc(["companion", "wifiImport"], {
					consent: true,
					qr: "WIFI:T:WPA;S:Studio;P:sample-only;;",
				}),
			).toEqual({ status: "saved", uuid: "u" });
		} finally {
			later.close();
		}
	});
});
