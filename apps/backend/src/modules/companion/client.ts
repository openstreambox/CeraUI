import { type KeyObject, randomBytes } from "node:crypto";

import {
	authFields,
	claimFields,
	type DeviceKind,
	type HelloReply,
	helloFields,
	joinFields,
	ticketDigest,
} from "./channel.ts";
import {
	deriveClaimKey,
	deriveSetupProofKey,
	importP256,
	signEd25519,
	signP256,
	verifyMac,
	verifyP256,
} from "./keys.ts";
import type { SetupLink } from "./setup-link.ts";
import { decodeBase64, keyFingerprint, transcript } from "./transcript.ts";

/**
 * The companion side of `osb-companion/1`: what a native app (or the stub)
 * checks before it sends anything that matters. Shared by the stub and the
 * tests so both exercise the same checks.
 */

export class CompanionClientError extends Error {
	constructor(
		readonly code:
			| "bad_hello"
			| "wrong_box"
			| "binding_mismatch"
			| "not_this_setup"
			| "rolled_back"
			| "already_claimed",
		message: string,
	) {
		super(message);
	}
}

export interface VerifiedHello {
	reply: HelloReply;
	clientNonce: Buffer;
	boxNonce: Buffer;
	identityFingerprint: string;
}

export interface HelloExpectations {
	clientNonce: Buffer;
	/** What this client saw: `tls-spki:<hex>` of the server key, or `loopback`. */
	observedBinding: string;
	/** A pinned identity fingerprint, from the QR or an earlier pairing. */
	fingerprint?: string;
	/** Present while claiming: the box must prove it holds this setup. */
	setup?: SetupLink;
	/** The highest generation and access sequence this client has seen. */
	minGeneration?: number;
	minAccessSeq?: number;
}

export function newClientNonce(): Buffer {
	return randomBytes(32);
}

export function verifyHello(
	raw: unknown,
	expect: HelloExpectations,
): VerifiedHello {
	const reply = raw as HelloReply;
	const identity = decodeBase64(reply?.identity, 59, 128);
	const boxNonce = decodeBase64(reply?.box_nonce, 32);
	const signature = decodeBase64(reply?.signature, 64);
	const identityKey = identity && importP256(identity);
	if (
		reply?.status !== "ok" ||
		reply.v !== 1 ||
		!identityKey ||
		!identity ||
		!boxNonce ||
		!signature ||
		!Number.isSafeInteger(reply.generation) ||
		!Number.isSafeInteger(reply.access_seq) ||
		typeof reply.binding !== "string" ||
		typeof reply.claimed !== "boolean"
	)
		throw new CompanionClientError("bad_hello", "The box sent a bad hello.");
	const identityFingerprint = keyFingerprint(identity);
	const fields = helloFields(
		reply,
		expect.clientNonce,
		boxNonce,
		identityFingerprint,
	);
	if (!verifyP256(identityKey, transcript("box-hello", fields), signature))
		throw new CompanionClientError("bad_hello", "The box sent a bad hello.");
	if (expect.fingerprint && expect.fingerprint !== identityFingerprint)
		throw new CompanionClientError(
			"wrong_box",
			"This is not the box you paired with.",
		);
	// The identity endorses the TLS key the box serves. A different key here
	// means someone else terminated this connection.
	if (reply.binding !== expect.observedBinding)
		throw new CompanionClientError(
			"binding_mismatch",
			"The connection is not end to end with the box.",
		);
	if (expect.setup) {
		const proof = decodeBase64(reply.setup_proof, 32);
		if (reply.claimed)
			throw new CompanionClientError(
				"already_claimed",
				"This box already has an owner.",
			);
		if (
			reply.setup_id !== expect.setup.setupId ||
			!proof ||
			!verifyMac(
				deriveSetupProofKey(expect.setup.secret, expect.setup.setupId),
				transcript("box-setup", fields),
				proof,
			)
		)
			throw new CompanionClientError(
				"not_this_setup",
				"This box does not hold the setup code you scanned.",
			);
	}
	if (
		reply.generation < (expect.minGeneration ?? 0) ||
		reply.access_seq < (expect.minAccessSeq ?? 0)
	)
		throw new CompanionClientError(
			"rolled_back",
			"The box reports older access records than you saw before.",
		);
	return {
		reply,
		clientNonce: expect.clientNonce,
		boxNonce,
		identityFingerprint,
	};
}

export interface DeviceKey {
	privateKey: KeyObject;
	publicKey: Buffer;
}

export function buildClaim(
	hello: VerifiedHello,
	setup: SetupLink,
	device: DeviceKey,
	name: string,
	kind: DeviceKind,
) {
	const message = transcript(
		"claim",
		claimFields(
			hello.clientNonce,
			hello.boxNonce,
			hello.identityFingerprint,
			hello.reply.binding,
			hello.reply.generation,
			setup.setupId,
			keyFingerprint(device.publicKey),
			name,
			kind,
		),
	);
	const claimKey = deriveClaimKey(setup.secret, setup.setupId);
	return {
		device_key: device.publicKey.toString("base64"),
		name,
		kind,
		claim_signature: signEd25519(claimKey.privateKey, message).toString(
			"base64",
		),
		device_signature: signP256(device.privateKey, message).toString("base64"),
	};
}

export function buildJoin(
	hello: VerifiedHello,
	ticket: Buffer,
	device: DeviceKey,
	name: string,
	kind: DeviceKind,
) {
	const message = transcript(
		"join",
		joinFields(
			hello.clientNonce,
			hello.boxNonce,
			hello.identityFingerprint,
			hello.reply.binding,
			hello.reply.generation,
			ticketDigest(ticket),
			keyFingerprint(device.publicKey),
			name,
			kind,
		),
	);
	return {
		ticket: ticket.toString("base64"),
		device_key: device.publicKey.toString("base64"),
		name,
		kind,
		device_signature: signP256(device.privateKey, message).toString("base64"),
	};
}

export function buildAuth(hello: VerifiedHello, device: DeviceKey) {
	const fingerprint = keyFingerprint(device.publicKey);
	const message = transcript(
		"auth",
		authFields(
			hello.clientNonce,
			hello.boxNonce,
			hello.identityFingerprint,
			hello.reply.binding,
			hello.reply.generation,
			fingerprint,
		),
	);
	return {
		device: fingerprint,
		signature: signP256(device.privateKey, message).toString("base64"),
	};
}
