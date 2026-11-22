import { afterEach, describe, expect, test } from "bun:test";

import {
	type ChannelSession,
	provisionSetup,
} from "../modules/companion/channel.ts";
import {
	advancePin,
	buildClaim,
	buildJoin,
	CompanionClientError,
	joinCode,
	observedBinding,
} from "../modules/companion/client.ts";
import {
	classifyCompanionIngress,
	companionLoopbackAdmission,
} from "../modules/companion/ingress.ts";
import { generateP256 } from "../modules/companion/keys.ts";
import { newSetupSecret } from "../modules/companion/setup-link.ts";
import { keyFingerprint } from "../modules/companion/transcript.ts";
import type { RPCContext } from "../rpc/types.ts";
import {
	authenticate,
	BOX_BINDING,
	claimOwner,
	cleanupCompanionDirs,
	hello,
	localIngress,
	makeBox,
	setupIngress,
	verifierFor,
} from "./helpers/companion-fixture.ts";

afterEach(cleanupCompanionDirs);

type Box = ReturnType<typeof makeBox>;

function invite(box: Box, owner: ChannelSession) {
	const opened = box.channel.invite(owner);
	if (opened.status !== "ok") throw Error(opened.status);
	return { ...opened, ticket: Buffer.from(opened.ticket, "base64") };
}

function joinWith(
	box: Box,
	ticket: Buffer,
	ingress = setupIngress("192.0.2.9"),
	device = generateP256(),
) {
	const session: ChannelSession = {};
	const verified = hello(box, session, ingress, {
		fingerprint: box.identity.fingerprint,
	});
	const body = buildJoin(verified, ticket, device, "Desk PC", "pc");
	return {
		device,
		session,
		verified,
		result: box.channel.join(session, body, ingress),
	};
}

describe("invites: a ticket alone never makes an owner", () => {
	test("join from Ethernet or venue Wi-Fi is refused", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const { ticket } = invite(box, owner.session);
		expect(joinWith(box, ticket, localIngress("203.0.113.9")).result).toEqual({
			status: "refused",
		});
	});

	test("a joiner waits for the owner's Allow and cannot act or revoke before it", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const { ticket } = invite(box, owner.session);
		const joined = joinWith(box, ticket);
		expect(joined.result.status).toBe("pending");
		if (joined.result.status !== "pending") return;
		// The joiner's screen and the owner's list show the same short code.
		expect(joined.result.code).toBe(
			joinCode(joined.verified, ticket, joined.device, "Desk PC", "pc"),
		);
		expect(box.channel.authorized(joined.session)).toBeUndefined();
		expect(
			box.channel.revoke(joined.session, { device: owner.id }).status,
		).toBe("not_authenticated");
		expect(authenticate(box, joined.device).result).toEqual({
			status: "pending",
		});
		const list = box.channel.devices(owner.session);
		if (list.status !== "ok") throw Error(list.status);
		expect(
			list.devices.find((d) => d.id === joined.result.device),
		).toMatchObject({ pending: true, code: joined.result.code });
		// The owner allows; now the device signs in as a co-owner.
		const allowed = box.channel.allow(owner.session, {
			device: joined.result.device,
		});
		expect(allowed).toMatchObject({
			status: "ok",
			device: joined.result.device,
		});
		expect(authenticate(box, joined.device).result).toMatchObject({
			status: "ok",
			role: "owner",
		});
	});

	test("the owner can turn a pending device away", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const joined = joinWith(box, invite(box, owner.session).ticket);
		if (joined.result.status !== "pending") throw Error(joined.result.status);
		expect(
			box.channel.revoke(owner.session, { device: joined.result.device })
				.status,
		).toBe("ok");
		expect(
			box.channel.allow(owner.session, { device: joined.result.device }).status,
		).toBe("invalid");
		expect(authenticate(box, joined.device).result.status).toBe("refused");
	});

	test("a device ID that collides with an enrolled one is refused", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const device = generateP256();
		const state = box.store.read();
		const fp = keyFingerprint(device.publicKey);
		const first = state.devices[0];
		if (!first) throw Error("no owner");
		box.store.write({
			...state,
			devices: [
				...state.devices,
				{
					...first,
					id: `dev-${fp.slice(0, 16)}`,
					fingerprint: `${fp.slice(0, 16)}${"0".repeat(48)}`,
				},
			],
		});
		const { ticket } = invite(box, owner.session);
		expect(
			joinWith(box, ticket, setupIngress("192.0.2.9"), device).result,
		).toEqual({ status: "invalid" });
	});
});

describe("setup material and hello", () => {
	test("a replaced, unused setup code is retired and never claims", () => {
		const box = makeBox();
		provisionSetup(box.store, verifierFor(newSetupSecret()));
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress());
		const claim = buildClaim(
			verified,
			box.setup,
			generateP256(),
			"Old",
			"phone",
		);
		expect(box.channel.claim(session, claim, setupIngress()).status).toBe(
			"refused",
		);
		expect(() => provisionSetup(box.store, verifierFor(box.setup))).toThrow();
	});

	test("hello is rate-limited per interface and peer", () => {
		const box = makeBox();
		const statuses: string[] = [];
		for (let i = 0; i < 25; i++)
			statuses.push(
				String(
					(
						box.channel.hello(
							{},
							{ client_nonce: Buffer.alloc(32, i).toString("base64") },
							localIngress("198.51.100.20"),
						) as { status: string }
					).status,
				),
			);
		expect(statuses.slice(0, 20).every((s) => s === "ok")).toBe(true);
		expect(statuses.at(-1)).toBe("busy");
		expect(
			(
				box.channel.hello(
					{},
					{ client_nonce: Buffer.alloc(32, 1).toString("base64") },
					localIngress("198.51.100.21"),
				) as { status: string }
			).status,
		).toBe("ok");
	});
});

describe("access sequence is persisted by the companion after every write", () => {
	test("claim, allow and revoke return the new access sequence; a restore right after is caught", () => {
		const box = makeBox();
		const before = box.store.read();
		const owner = claimOwner(box);
		expect(owner.reply).toMatchObject({
			access_seq: box.store.read().access_seq,
			generation: box.store.read().generation,
		});
		let pin = advancePin(
			{
				fingerprint: box.identity.fingerprint,
				generation: 1,
				access_seq: 0,
				device: keyFingerprint(owner.device.publicKey),
			},
			owner.reply,
		);
		expect(pin.access_seq).toBe(box.store.read().access_seq);
		const joined = joinWith(box, invite(box, owner.session).ticket);
		if (joined.result.status !== "pending") throw Error(joined.result.status);
		const allowed = box.channel.allow(owner.session, {
			device: joined.result.device,
		});
		pin = advancePin(pin, allowed);
		expect(pin.access_seq).toBe(box.store.read().access_seq);
		const revoked = box.channel.revoke(owner.session, {
			device: joined.result.device,
		});
		pin = advancePin(pin, revoked);
		expect(pin.access_seq).toBe(box.store.read().access_seq);
		// A copy of the data partition from before the claim comes back.
		box.store.write(before);
		try {
			hello(box, {}, localIngress(), {
				fingerprint: pin.fingerprint,
				minGeneration: pin.generation,
				minAccessSeq: pin.access_seq,
			});
			throw Error("restore not detected");
		} catch (error) {
			expect((error as CompanionClientError).code).toBe("rolled_back");
		}
	});

	test("a pin never moves backwards", () => {
		const pin = {
			fingerprint: "a".repeat(64),
			generation: 2,
			access_seq: 9,
			device: "b".repeat(64),
		};
		expect(
			advancePin(pin, { status: "ok", access_seq: 3, generation: 1 }),
		).toEqual(pin);
		expect(advancePin(pin, { status: "refused" })).toEqual(pin);
	});
});

describe("binding contract on the companion", () => {
	test("a companion only ever reports `loopback` for a loopback ws: URL", () => {
		expect(observedBinding(new URL("ws://127.0.0.1:8080/ws"), undefined)).toBe(
			"loopback",
		);
		expect(observedBinding(new URL("wss://box.local/ws"), BOX_BINDING)).toBe(
			BOX_BINDING,
		);
		expect(() =>
			observedBinding(new URL("wss://box.local/ws"), undefined),
		).toThrow(CompanionClientError);
		expect(() =>
			observedBinding(new URL("wss://box.local/ws"), "loopback"),
		).toThrow(CompanionClientError);
		expect(() =>
			observedBinding(new URL("ws://192.0.2.1/ws"), undefined),
		).toThrow(CompanionClientError);
	});
});

describe("development loopback path", () => {
	const loopbackContext = {
		ws: {
			remoteAddress: "127.0.0.1",
			data: {
				isAuthenticated: false,
				lastActive: 0,
				companionLoopbackClient: true,
			},
		},
		getSenderId: () => undefined,
	} as unknown as RPCContext;
	const deps = (development: boolean) => ({
		frontDoor: () => false,
		isSetupHotspot: () => false,
		tlsBinding: () => BOX_BINDING,
		development: () => development,
	});

	test("the upgrade never marks a socket outside a development runtime", () => {
		const plain = new Headers({ host: "127.0.0.1" });
		const admit = (development: boolean, headers = plain) =>
			companionLoopbackAdmission(headers, {
				enabled: true,
				development,
				frontDoor: () => false,
			});
		expect(admit(false)).toBe(false);
		expect(admit(true)).toBe(true);
		expect(admit(true, new Headers({ origin: "http://x" }))).toBe(false);
		expect(admit(true, new Headers({ "x-real-ip": "198.51.100.7" }))).toBe(
			false,
		);
		expect(
			companionLoopbackAdmission(plain, {
				enabled: true,
				development: true,
				frontDoor: () => true,
			}),
		).toBe(false);
	});

	test("is refused outside a development runtime", () => {
		expect(
			classifyCompanionIngress(loopbackContext, deps(false)),
		).toBeUndefined();
		expect(classifyCompanionIngress(loopbackContext, deps(true))).toMatchObject(
			{
				kind: "setup",
				binding: "loopback",
			},
		);
	});
});
