import { afterEach, describe, expect, mock, test } from "bun:test";
import { call } from "@orpc/server";

import { AttemptBudget } from "../../modules/companion/budget.ts";
import { CompanionChannel } from "../../modules/companion/channel.ts";
import {
	buildAuth,
	buildClaim,
	buildJoin,
	newClientNonce,
	verifyHello,
} from "../../modules/companion/client.ts";
import { classifyCompanionIngress } from "../../modules/companion/ingress.ts";
import { generateP256 } from "../../modules/companion/keys.ts";
import type { CompanionWifiNetwork } from "../../modules/wifi/companion-wifi-input.ts";
import {
	BOX_BINDING,
	cleanupCompanionDirs,
	makeBox,
} from "../../tests/helpers/companion-fixture.ts";
import type { AppWebSocket, RPCContext, SocketData } from "../types.ts";
import { createCompanionProcedures } from "./companion-channel.procedure.ts";

afterEach(() => {
	cleanupCompanionDirs();
	mock.restore();
});

interface FakeSocket {
	ws: AppWebSocket;
	closed: { code: number; reason: string }[];
}

function socket(
	peer: string,
	data: Partial<SocketData>,
	sender?: string,
): FakeSocket & { context: RPCContext } {
	const closed: { code: number; reason: string }[] = [];
	const ws = {
		remoteAddress: peer,
		readyState: 1,
		data: { isAuthenticated: false, lastActive: 0, ...data },
		close(code: number, reason: string) {
			closed.push({ code, reason });
		},
	} as unknown as AppWebSocket;
	const context = {
		ws,
		getSenderId: () => sender,
	} as unknown as RPCContext;
	return { ws, closed, context };
}

const onHotspot = (peer = "192.0.2.2") =>
	socket("127.0.0.1", {
		ingressPath: { peer, interface: "ap0", local: "192.0.2.1" },
		ingressPathValid: () => true,
	});
const onEthernet = (peer = "198.51.100.5") =>
	socket("127.0.0.1", {
		ingressPath: { peer, interface: "eth0", local: "198.51.100.1" },
		ingressPathValid: () => true,
	});

function harness(
	options: {
		frontDoor?: boolean;
		enabled?: boolean;
		development?: boolean;
	} = {},
) {
	const box = makeBox();
	const saved: CompanionWifiNetwork[] = [];
	const procedures = createCompanionProcedures({
		enabled: () => options.enabled ?? true,
		createChannel: (onRevoked) =>
			new CompanionChannel({
				store: box.store,
				budget: new AttemptBudget(),
				onRevoked,
			}),
		ingress: (context) =>
			classifyCompanionIngress(context, {
				frontDoor: () => options.frontDoor ?? true,
				isSetupHotspot: (ifname) => ifname === "ap0",
				tlsBinding: () => BOX_BINDING,
				development: () => options.development ?? true,
			}),
		saveNetwork: async (network) => {
			saved.push(network);
			return { status: "saved", uuid: "00000000-0000-4000-8000-000000000001" };
		},
	});
	return { box, procedures, saved };
}

type Harness = ReturnType<typeof harness>;

async function helloOver(
	h: Harness,
	context: RPCContext,
	expect: { setup?: boolean; observedBinding?: string } = {},
) {
	const clientNonce = newClientNonce();
	const reply = await call(
		h.procedures.hello,
		{ client_nonce: clientNonce.toString("base64") },
		{ context },
	);
	return verifyHello(reply, {
		clientNonce,
		observedBinding: expect.observedBinding ?? BOX_BINDING,
		fingerprint: h.box.identity.fingerprint,
		...(expect.setup ? { setup: h.box.setup } : {}),
	});
}

async function claimOver(h: Harness, context: RPCContext) {
	const device = generateP256();
	const verified = await helloOver(h, context, { setup: true });
	const result = await call(
		h.procedures.claim,
		buildClaim(verified, h.box.setup, device, "Phone", "phone"),
		{ context },
	);
	return { device, result };
}

const network = {
	consent: true,
	network: { ssid: "Studio", security: "wpa-psk", password: "sample-only" },
};

describe("companion procedures: ingress", () => {
	test("flag off: every route answers disabled", async () => {
		const h = harness({ enabled: false });
		const s = onHotspot();
		expect(
			await call(
				h.procedures.hello,
				{ client_nonce: "" },
				{ context: s.context },
			),
		).toEqual({ status: "disabled" });
	});

	test("claim over the front door on the setup hotspot works; over Ethernet it is refused", async () => {
		const h = harness();
		const eth = onEthernet();
		const refused = await claimOver(h, eth.context);
		expect(refused.result).toEqual({ status: "refused" });
		const ap = onHotspot();
		const ok = await claimOver(h, ap.context);
		expect(ok.result.status).toBe("ok");
	});

	test("remote-control relay senders, stale interface evidence and proxied TCP are refused", async () => {
		const h = harness();
		const relay = socket(
			"127.0.0.1",
			{
				ingressPath: {
					peer: "192.0.2.2",
					interface: "ap0",
					local: "192.0.2.1",
				},
				ingressPathValid: () => true,
			},
			"sender-1",
		);
		const stale = socket("127.0.0.1", {
			ingressPath: {
				peer: "192.0.2.2",
				interface: "ap0",
				local: "192.0.2.1",
			},
			ingressPathValid: () => false,
		});
		// Behind the front door a TCP socket from loopback may be anyone.
		const proxied = socket("127.0.0.1", { companionLoopbackClient: true });
		for (const s of [relay, stale, proxied])
			expect(
				await call(
					h.procedures.hello,
					{ client_nonce: newClientNonce().toString("base64") },
					{ context: s.context },
				),
			).toEqual({ status: "refused" });
	});

	test("without the front door, a native loopback client is the development setup path", async () => {
		const h = harness({ frontDoor: false });
		const lan = socket("203.0.113.20", { companionLoopbackClient: true });
		expect(
			await call(
				h.procedures.hello,
				{ client_nonce: newClientNonce().toString("base64") },
				{ context: lan.context },
			),
		).toEqual({ status: "refused" });
		const browser = socket("127.0.0.1", {});
		expect(
			await call(
				h.procedures.hello,
				{ client_nonce: newClientNonce().toString("base64") },
				{ context: browser.context },
			),
		).toEqual({ status: "refused" });
		const native = socket("127.0.0.1", { companionLoopbackClient: true });
		const device = generateP256();
		const verified = await helloOver(h, native.context, {
			setup: true,
			observedBinding: "loopback",
		});
		expect(verified.reply.binding).toBe("loopback");
		const result = await call(
			h.procedures.claim,
			buildClaim(verified, h.box.setup, device, "Phone", "phone"),
			{ context: native.context },
		);
		expect(result.status).toBe("ok");
	});
});

describe("companion procedures: Wi-Fi import over the channel", () => {
	test("an unauthenticated socket cannot import", async () => {
		const h = harness();
		const s = onEthernet();
		expect(
			await call(h.procedures.wifiImport, network, { context: s.context }),
		).toEqual({ status: "not_authenticated" });
		expect(h.saved).toEqual([]);
	});

	test("an enrolled device imports from behind the front door, where the loopback-only route refuses", async () => {
		const h = harness();
		const owner = await claimOver(h, onHotspot().context);
		const s = onEthernet();
		const verified = await helloOver(h, s.context);
		expect(
			await call(h.procedures.auth, buildAuth(verified, owner.device), {
				context: s.context,
			}),
		).toMatchObject({ status: "ok", role: "owner" });
		expect(
			await call(h.procedures.wifiImport, network, { context: s.context }),
		).toEqual({
			status: "saved",
			uuid: "00000000-0000-4000-8000-000000000001",
		});
		expect(h.saved).toEqual([
			{ ssid: "Studio", security: "wpa-psk", password: "sample-only" },
		]);
		expect(
			await call(
				h.procedures.wifiImport,
				{ consent: false },
				{ context: s.context },
			),
		).toEqual({ status: "invalid" });
	});

	test("the import stops working the moment the interface evidence fails", async () => {
		const h = harness();
		const owner = await claimOver(h, onHotspot().context);
		let valid = true;
		const s = socket("127.0.0.1", {
			ingressPath: {
				peer: "198.51.100.5",
				interface: "eth0",
				local: "198.51.100.1",
			},
			ingressPathValid: () => valid,
		});
		const verified = await helloOver(h, s.context);
		await call(h.procedures.auth, buildAuth(verified, owner.device), {
			context: s.context,
		});
		valid = false;
		expect(
			await call(h.procedures.wifiImport, network, { context: s.context }),
		).toEqual({ status: "refused" });
	});

	test("revoking a device closes its open sockets with 4403 and ends its access", async () => {
		const h = harness();
		const ap = onHotspot();
		const owner = await claimOver(h, ap.context);
		const invite = await call(h.procedures.invite, {}, { context: ap.context });
		if (invite.status !== "ok") throw Error(invite.status);
		const deskOnHotspot = onHotspot("192.0.2.9");
		const deskKey = generateP256();
		const verified = await helloOver(h, deskOnHotspot.context);
		const joined = await call(
			h.procedures.join,
			buildJoin(
				verified,
				Buffer.from(invite.ticket, "base64"),
				deskKey,
				"Desk PC",
				"pc",
			),
			{ context: deskOnHotspot.context },
		);
		expect(joined.status).toBe("pending");
		if (joined.status !== "pending") return;
		expect(
			await call(
				h.procedures.allow,
				{ device: joined.device },
				{ context: ap.context },
			),
		).toMatchObject({ status: "ok" });
		const desk = onEthernet("198.51.100.9");
		const deskHello = await helloOver(h, desk.context);
		expect(
			await call(h.procedures.auth, buildAuth(deskHello, deskKey), {
				context: desk.context,
			}),
		).toMatchObject({ status: "ok" });
		const ownerId = owner.result.status === "ok" ? owner.result.device : "";
		expect(
			await call(
				h.procedures.revoke,
				{ device: ownerId },
				{ context: desk.context },
			),
		).toMatchObject({ status: "ok", revoked: ownerId });
		expect(ap.closed).toEqual([{ code: 4403, reason: "revoked" }]);
		expect(
			await call(h.procedures.wifiImport, network, { context: ap.context }),
		).toEqual({ status: "not_authenticated" });
	});
});
