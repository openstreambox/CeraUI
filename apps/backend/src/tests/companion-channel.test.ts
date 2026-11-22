import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	AttemptBudget,
	ingressBudgetKey,
} from "../modules/companion/budget.ts";
import {
	type ChannelSession,
	provisionSetup,
	resetOwnership,
} from "../modules/companion/channel.ts";
import {
	buildAuth,
	buildClaim,
	buildJoin,
	CompanionClientError,
	newClientNonce,
	verifyHello,
} from "../modules/companion/client.ts";
import { generateP256 } from "../modules/companion/keys.ts";
import {
	formatSetupLink,
	newSetupSecret,
	parseSetupLink,
} from "../modules/companion/setup-link.ts";
import { CompanionStoreError } from "../modules/companion/store.ts";
import {
	authenticate,
	BOX_BINDING,
	claimOwner,
	cleanupCompanionDirs,
	hello,
	localIngress,
	MITM_BINDING,
	makeBox,
	setupIngress,
	verifierFor,
} from "./helpers/companion-fixture.ts";

afterEach(cleanupCompanionDirs);

function expectClientError(run: () => unknown, code: string) {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(CompanionClientError);
		expect((error as CompanionClientError).code).toBe(code as never);
		return;
	}
	throw Error(`expected ${code}`);
}

describe("companion channel: first contact", () => {
	test("a companion with the QR claims the box and signs in again later", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		expect(box.store.read().setup).toBeNull();
		expect(box.store.read().devices).toHaveLength(1);
		const again = authenticate(box, owner.device);
		expect(again.result).toMatchObject({
			status: "ok",
			device: owner.id,
			role: "owner",
		});
		expect(box.channel.authorized(again.session)?.id).toBe(owner.id);
	});

	test("the setup link round-trips and rejects malformed input", () => {
		const secret = newSetupSecret();
		const link = formatSetupLink({ ...secret, fingerprint: "c".repeat(64) });
		expect(link.startsWith("osb-box://claim#")).toBe(true);
		expect(parseSetupLink(link)).toEqual({
			...secret,
			fingerprint: "c".repeat(64),
		});
		expect(parseSetupLink(`${link}&s=again`)).toBeUndefined();
		expect(parseSetupLink(link.replace("v=1", "v=2"))).toBeUndefined();
		expect(parseSetupLink("osb-box://claim?v=1")).toBeUndefined();
	});

	test("MITM: a relay that terminates TLS with its own key is caught by the companion", () => {
		const box = makeBox();
		// The relay forwards the real box's hello, but the companion saw the
		// relay's TLS key.
		expectClientError(
			() =>
				hello(box, {}, setupIngress(), {
					setup: box.setup,
					fingerprint: box.setup.fingerprint,
					observedBinding: MITM_BINDING,
				}),
			"binding_mismatch",
		);
	});

	test("MITM: a claim signed over the relay's binding is refused and setup stays open", () => {
		const box = makeBox();
		const session: ChannelSession = {};
		const ingress = setupIngress();
		const clientNonce = newClientNonce();
		const reply = box.channel.hello(
			session,
			{ client_nonce: clientNonce.toString("base64") },
			ingress,
		);
		// A careless client that skipped the binding check signs what it saw.
		const tampered = { ...(reply as object), binding: MITM_BINDING };
		const forged = {
			reply: tampered as never,
			clientNonce,
			boxNonce: Buffer.from(
				(reply as { box_nonce: string }).box_nonce,
				"base64",
			),
			identityFingerprint: box.identity.fingerprint,
		};
		const claim = buildClaim(
			forged,
			box.setup,
			generateP256(),
			"Relay",
			"phone",
		);
		expect(box.channel.claim(session, claim, ingress)).toEqual({
			status: "refused",
		});
		expect(box.store.read().setup).not.toBeNull();
		expect(box.store.read().devices).toHaveLength(0);
		claimOwner(box);
	});

	test("an impostor box without this box's setup material is refused before anything is sent", () => {
		const real = makeBox();
		const impostor = makeBox();
		// Card path: the QR carries no fingerprint, so the setup proof decides.
		const cardQr = { setupId: real.setup.setupId, secret: real.setup.secret };
		expectClientError(
			() => hello(impostor, {}, setupIngress(), { setup: cardQr }),
			"not_this_setup",
		);
		// Pinned path: the fingerprint decides.
		expectClientError(
			() =>
				hello(impostor, {}, setupIngress(), {
					fingerprint: real.identity.fingerprint,
				}),
			"wrong_box",
		);
	});

	test("replayed QR: a second phone with the same code cannot claim a claimed box", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		expectClientError(
			() => hello(box, {}, setupIngress(), { setup: box.setup }),
			"already_claimed",
		);
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress());
		const claim = buildClaim(
			verified,
			box.setup,
			generateP256(),
			"Late",
			"phone",
		);
		expect(box.channel.claim(session, claim, setupIngress())).toEqual({
			status: "already_claimed",
		});
		expect(authenticate(box, owner.device).result.status).toBe("ok");
	});

	test("replayed claim message: the same signed claim never works twice", () => {
		const box = makeBox();
		const device = generateP256();
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress(), { setup: box.setup });
		const claim = buildClaim(verified, box.setup, device, "Phone", "phone");
		// Captured and replayed on a new hello before the owner sends it.
		const attacker: ChannelSession = {};
		hello(box, attacker, setupIngress("192.0.2.9"), { setup: box.setup });
		expect(
			box.channel.claim(attacker, claim, setupIngress("192.0.2.9")),
		).toEqual({ status: "refused" });
		// The owner's own attempt still works, once.
		expect(box.channel.claim(session, claim, setupIngress()).status).toBe("ok");
		expect(box.channel.claim(session, claim, setupIngress()).status).toBe(
			"refused",
		);
	});

	test("two phones racing with the same QR: one wins, the other is told the box is taken", () => {
		const box = makeBox();
		const a: ChannelSession = {};
		const b: ChannelSession = {};
		const ha = hello(box, a, setupIngress("192.0.2.2"), { setup: box.setup });
		const hb = hello(box, b, setupIngress("192.0.2.3"), { setup: box.setup });
		const ca = buildClaim(ha, box.setup, generateP256(), "A", "phone");
		const cb = buildClaim(hb, box.setup, generateP256(), "B", "phone");
		expect(box.channel.claim(a, ca, setupIngress("192.0.2.2")).status).toBe(
			"ok",
		);
		expect(box.channel.claim(b, cb, setupIngress("192.0.2.3")).status).toBe(
			"already_claimed",
		);
	});

	test("a wrong secret is refused and counts against the budget", () => {
		const box = makeBox();
		const wrong = { ...box.setup, secret: Buffer.alloc(16, 7) };
		for (let attempt = 0; attempt < 5; attempt++) {
			const session: ChannelSession = {};
			const verified = hello(box, session, setupIngress());
			const claim = buildClaim(verified, wrong, generateP256(), "X", "phone");
			expect(box.channel.claim(session, claim, setupIngress()).status).toBe(
				"refused",
			);
		}
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress());
		const claim = buildClaim(verified, box.setup, generateP256(), "X", "phone");
		const busy = box.channel.claim(session, claim, setupIngress());
		expect(busy.status).toBe("busy");
		// Another peer on the same AP is unaffected.
		const other: ChannelSession = {};
		const otherHello = hello(box, other, setupIngress("192.0.2.77"), {
			setup: box.setup,
		});
		expect(
			box.channel.claim(
				other,
				buildClaim(otherHello, box.setup, generateP256(), "Y", "phone"),
				setupIngress("192.0.2.77"),
			).status,
		).toBe("ok");
	});

	test("claim is only accepted on the setup ingress", () => {
		const box = makeBox();
		const session: ChannelSession = {};
		const verified = hello(box, session, localIngress(), { setup: box.setup });
		const claim = buildClaim(verified, box.setup, generateP256(), "X", "phone");
		expect(box.channel.claim(session, claim, localIngress())).toEqual({
			status: "refused",
		});
	});

	test("a hello expires after 30 seconds and is good for one attempt", () => {
		let now = 1_000_000;
		const box = makeBox({ now: () => now });
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress(), { setup: box.setup });
		now += 30_001;
		const claim = buildClaim(verified, box.setup, generateP256(), "X", "phone");
		expect(box.channel.claim(session, claim, setupIngress()).status).toBe(
			"refused",
		);
	});
});

describe("companion channel: devices and revocation", () => {
	function addSecondOwner(
		box: ReturnType<typeof makeBox>,
		ownerSession: ChannelSession,
	) {
		const invite = box.channel.invite(ownerSession);
		if (invite.status !== "ok") throw Error(invite.status);
		const device = generateP256();
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress("192.0.2.9"), {
			fingerprint: invite.fingerprint,
		});
		const ticket = Buffer.from(invite.ticket, "base64");
		const joined = box.channel.join(
			session,
			buildJoin(verified, ticket, device, "Desk PC", "pc"),
			setupIngress("192.0.2.9"),
		);
		if (joined.status !== "pending") throw Error(joined.status);
		const allowed = box.channel.allow(ownerSession, { device: joined.device });
		if (allowed.status !== "ok") throw Error(allowed.status);
		// Signs in from its desk on Ethernet once allowed.
		const signedIn = authenticate(box, device, localIngress("198.51.100.9"));
		if (signedIn.result.status !== "ok") throw Error(signedIn.result.status);
		return {
			device,
			session: signedIn.session,
			id: joined.device,
			ticket,
			verified,
		};
	}

	test("an owner invites a second device; the ticket works once", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const second = addSecondOwner(box, owner.session);
		const list = box.channel.devices(second.session);
		expect(list.status).toBe("ok");
		if (list.status === "ok")
			expect(list.devices.map((d) => d.name)).toEqual([
				"Test phone",
				"Desk PC",
			]);
		const replay: ChannelSession = {};
		const verified = hello(box, replay, setupIngress("192.0.2.10"));
		expect(
			box.channel.join(
				replay,
				buildJoin(verified, second.ticket, generateP256(), "Copy", "phone"),
				setupIngress("192.0.2.10"),
			).status,
		).toBe("refused");
	});

	test("stolen phone: another owner revokes it; its sessions end and it cannot sign in", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const second = addSecondOwner(box, owner.session);
		const before = box.store.read().access_seq;
		expect(
			box.channel.revoke(second.session, { device: owner.id }),
		).toMatchObject({
			status: "ok",
			revoked: owner.id,
		});
		expect(box.revoked).toEqual([owner.id]);
		expect(box.store.read().access_seq).toBe(before + 1);
		expect(box.channel.authorized(owner.session)).toBeUndefined();
		expect(authenticate(box, owner.device).result.status).toBe("refused");
		expect(
			box.channel.revoke(owner.session, { device: second.id }).status,
		).toBe("not_authenticated");
	});

	test("the last owner cannot be revoked", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		expect(box.channel.revoke(owner.session, { device: owner.id })).toEqual({
			status: "last_owner",
		});
	});

	test("invites made by a revoked device close with it", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const second = addSecondOwner(box, owner.session);
		const invite = box.channel.invite(owner.session);
		if (invite.status !== "ok") throw Error(invite.status);
		box.channel.revoke(second.session, { device: owner.id });
		const session: ChannelSession = {};
		const verified = hello(box, session, setupIngress("192.0.2.11"));
		expect(
			box.channel.join(
				session,
				buildJoin(
					verified,
					Buffer.from(invite.ticket, "base64"),
					generateP256(),
					"Late",
					"phone",
				),
				setupIngress("192.0.2.11"),
			).status,
		).toBe("refused");
	});

	test("a companion that saw a newer access record notices a restored box", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const seen = box.store.read();
		// A stale copy of the data partition comes back.
		box.store.write({ ...seen, access_seq: seen.access_seq - 1 });
		expectClientError(
			() =>
				hello(box, {}, localIngress(), {
					fingerprint: box.identity.fingerprint,
					minGeneration: seen.generation,
					minAccessSeq: seen.access_seq,
				}),
			"rolled_back",
		);
		expect(owner.id).toMatch(/^dev-/);
	});
});

describe("companion channel: reset and storage", () => {
	test("physical reset forgets every device, advances the generation and never revives the old code", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const pending: ChannelSession = {};
		hello(box, pending, localIngress());
		const fresh = newSetupSecret();
		const next = resetOwnership(box.store, verifierFor(fresh));
		expect(next.generation).toBe(2);
		expect(next.devices).toEqual([]);
		expect(box.channel.authorized(owner.session)).toBeUndefined();
		// A hello from before the reset is stale.
		expect(
			box.channel.auth(
				pending,
				{
					device: "0".repeat(64),
					signature: Buffer.alloc(64).toString("base64"),
				},
				localIngress(),
			).status,
		).toBe("stale");
		expect(authenticate(box, owner.device).result.status).toBe("refused");
		// The first code is retired for good, even after another reset.
		resetOwnership(box.store);
		expect(() => provisionSetup(box.store, verifierFor(box.setup))).toThrow(
			CompanionStoreError,
		);
	});

	test("a malformed store makes the channel unavailable and never reopens setup", () => {
		const box = makeBox();
		claimOwner(box);
		writeFileSync(join(box.store.dir, "state.json"), "{not json");
		const reply = box.channel.hello(
			{},
			{ client_nonce: newClientNonce().toString("base64") },
			setupIngress(),
		);
		expect(reply).toEqual({ status: "unavailable" });
	});

	test("provisioning refuses a claimed box", () => {
		const box = makeBox();
		claimOwner(box);
		expect(() =>
			provisionSetup(box.store, verifierFor(newSetupSecret())),
		).toThrow(CompanionStoreError);
	});

	test("bad hello input is rejected without touching the store", () => {
		const box = makeBox();
		expect(
			box.channel.hello({}, { client_nonce: "short" }, setupIngress()),
		).toEqual({
			status: "invalid",
		});
		expect(BOX_BINDING.startsWith("tls-spki:")).toBe(true);
	});

	test("a forged signature on auth is refused", () => {
		const box = makeBox();
		const owner = claimOwner(box);
		const session: ChannelSession = {};
		const verified = hello(box, session, localIngress());
		const auth = buildAuth(verified, generateP256());
		expect(
			box.channel.auth(
				session,
				{ ...auth, device: buildAuth(verified, owner.device).device },
				localIngress(),
			).status,
		).toBe("refused");
	});
});

describe("attempt budget", () => {
	test("backs off per key with bounded memory and no global lockout", () => {
		let now = 0;
		const budget = new AttemptBudget({ now: () => now, maxKeys: 3 });
		for (let i = 0; i < 5; i++) budget.fail("a");
		expect(budget.retryAfter("a")).toBe(30_000);
		budget.fail("a");
		expect(budget.retryAfter("a")).toBe(60_000);
		now += 60_000;
		expect(budget.retryAfter("a")).toBe(0);
		for (const key of ["b", "c", "d", "e"]) budget.fail(key);
		expect(budget.size).toBe(3);
		expect(budget.retryAfter("z")).toBe(0);
	});

	test("an IPv6 peer counts by its /64", () => {
		expect(ingressBudgetKey("ap0", "fe80::1:2:3:4")).toBe(
			ingressBudgetKey("ap0", "fe80::9:9:9:9"),
		);
		expect(ingressBudgetKey("ap0", "2001:db8:1:2::5")).not.toBe(
			ingressBudgetKey("ap0", "2001:db8:1:3::5"),
		);
		expect(ingressBudgetKey("ap0", "::ffff:192.0.2.2")).toBe("ap0|192.0.2.2");
	});

	test("verifyHello refuses a reply that is not a hello", () => {
		expectClientError(
			() =>
				verifyHello(
					{ status: "refused" },
					{ clientNonce: newClientNonce(), observedBinding: BOX_BINDING },
				),
			"bad_hello",
		);
	});
});
