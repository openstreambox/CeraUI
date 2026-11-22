import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttemptBudget } from "../../modules/companion/budget.ts";
import {
	type ChannelIngress,
	type ChannelSession,
	CompanionChannel,
	provisionSetup,
} from "../../modules/companion/channel.ts";
import {
	buildAuth,
	buildClaim,
	type DeviceKey,
	newClientNonce,
	type VerifiedHello,
	verifyHello,
} from "../../modules/companion/client.ts";
import {
	deriveClaimKey,
	deriveSetupProofKey,
	generateP256,
} from "../../modules/companion/keys.ts";
import {
	newSetupSecret,
	type SetupLink,
} from "../../modules/companion/setup-link.ts";
import { CompanionStore } from "../../modules/companion/store.ts";

/** Synthetic TLS bindings: what the box serves and what an attacker serves. */
export const BOX_BINDING = `tls-spki:${"a".repeat(64)}`;
export const MITM_BINDING = `tls-spki:${"b".repeat(64)}`;

export const setupIngress = (peer = "192.0.2.2"): ChannelIngress => ({
	kind: "setup",
	key: `ap0|${peer}`,
	binding: BOX_BINDING,
});
export const localIngress = (peer = "198.51.100.5"): ChannelIngress => ({
	kind: "local",
	key: `eth0|${peer}`,
	binding: BOX_BINDING,
});

const dirs: string[] = [];
export function cleanupCompanionDirs() {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

export function verifierFor(setup: SetupLink) {
	return {
		setupId: setup.setupId,
		claimKey: deriveClaimKey(setup.secret, setup.setupId).publicKey,
		proofKey: deriveSetupProofKey(setup.secret, setup.setupId),
	};
}

/** A box with a fresh store and provisioned setup material. */
export function makeBox(options: { now?: () => number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "companion-"));
	dirs.push(dir);
	const store = new CompanionStore(join(dir, "companion"));
	const secret = newSetupSecret();
	const identity = store.identity();
	const setup: SetupLink = { ...secret, fingerprint: identity.fingerprint };
	provisionSetup(store, verifierFor(setup));
	const revoked: string[] = [];
	const now = options.now ?? Date.now;
	const channel = new CompanionChannel({
		store,
		now,
		budget: new AttemptBudget({ now }),
		onRevoked: (id) => revoked.push(id),
	});
	return { dir, store, setup, channel, revoked, identity };
}

export type Box = ReturnType<typeof makeBox>;

export function hello(
	box: Box,
	session: ChannelSession,
	ingress: ChannelIngress,
	expect: Omit<
		Parameters<typeof verifyHello>[1],
		"clientNonce" | "observedBinding"
	> & {
		observedBinding?: string;
	} = {},
): VerifiedHello {
	const clientNonce = newClientNonce();
	const reply = box.channel.hello(
		session,
		{ client_nonce: clientNonce.toString("base64") },
		ingress,
	);
	return verifyHello(reply, {
		clientNonce,
		observedBinding: expect.observedBinding ?? ingress.binding,
		...expect,
	});
}

export function claimOwner(box: Box, name = "Test phone") {
	const device: DeviceKey = generateP256();
	const session: ChannelSession = {};
	const ingress = setupIngress();
	const verified = hello(box, session, ingress, {
		setup: box.setup,
		fingerprint: box.identity.fingerprint,
	});
	const result = box.channel.claim(
		session,
		buildClaim(verified, box.setup, device, name, "phone"),
		ingress,
	);
	if (result.status !== "ok") throw Error(`claim failed: ${result.status}`);
	return { device, session, id: result.device };
}

export function authenticate(
	box: Box,
	device: DeviceKey,
	ingress = localIngress(),
	session: ChannelSession = {},
) {
	const verified = hello(box, session, ingress, {
		fingerprint: box.identity.fingerprint,
	});
	return {
		session,
		result: box.channel.auth(session, buildAuth(verified, device), ingress),
	};
}
