import { createHash, randomBytes } from "node:crypto";

import { AttemptBudget, HelloRate } from "./budget.ts";
import {
	importEd25519,
	importP256,
	mac,
	signP256,
	verifyEd25519,
	verifyP256,
} from "./keys.ts";
import {
	type CompanionState,
	type CompanionStore,
	CompanionStoreError,
	type DeviceRecord,
} from "./store.ts";
import { decodeBase64, keyFingerprint, transcript } from "./transcript.ts";

/**
 * The box side of the paired companion channel (`osb-companion/1`).
 *
 * Transport-agnostic: the RPC layer decides which ingress a socket arrived on
 * and what channel binding it has, and keeps one `ChannelSession` per socket.
 *
 * 1. hello: the companion sends a fresh nonce. The box answers with its own
 *    nonce, its identity key, the ownership generation and access sequence,
 *    the channel binding (the SHA-256 of the TLS key the companion should have
 *    seen) and a signature over all of it with the identity key. While setup
 *    material is present it adds a MAC with the setup proof key.
 * 2. claim (setup ingress only): the companion proves the setup secret by
 *    signing the transcript with the derived claim key and enrolls its own
 *    P-256 device key, signing the same transcript with it. The box commits
 *    the owner and retires the claim key before it answers.
 * 3. auth: an enrolled device signs a transcript over a fresh hello.
 *
 * Every hello is good for one claim or auth attempt within 30 seconds.
 */

export type IngressKind = "setup" | "local";

export interface ChannelIngress {
	kind: IngressKind;
	/** Attempt-budget key: interface and peer. */
	key: string;
	/** `tls-spki:<hex>` behind TLS, `loopback` on the development path. */
	binding: string;
}

interface PendingHello {
	clientNonce: Buffer;
	boxNonce: Buffer;
	binding: string;
	generation: number;
	accessSeq: number;
	setupId: string;
	expires: number;
	used: boolean;
}

export interface ChannelSession {
	hello?: PendingHello | undefined;
	device?: { id: string; generation: number } | undefined;
}

export type Refusal =
	| { status: "unavailable" }
	| { status: "invalid" }
	| { status: "refused" }
	| { status: "busy"; retry_after_ms: number }
	| { status: "already_claimed" }
	| { status: "stale" }
	| { status: "not_authenticated" }
	| { status: "last_owner" }
	| { status: "too_many" }
	| { status: "pending" };

/** What every write returns, so a companion can raise its rollback floor. */
export interface AccessRecord {
	access_seq: number;
	generation: number;
}

export interface HelloReply {
	status: "ok";
	v: 1;
	box_nonce: string;
	identity: string;
	generation: number;
	access_seq: number;
	setup_id: string | null;
	claimed: boolean;
	binding: string;
	signature: string;
	setup_proof?: string;
}

export type DeviceKind = DeviceRecord["kind"];
const KINDS: readonly DeviceKind[] = ["phone", "pc", "companion"];
const NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,64}$/u;
const HELLO_TTL_MS = 30_000;
const INVITE_TTL_MS = 5 * 60_000;
const MAX_INVITES = 8;
const MAX_DEVICES = 64;
/** Retired claim keys kept; the oldest are dropped past this many. */
export const RETIRED_LIMIT = 1024;

export interface CompanionChannelOptions {
	store: CompanionStore;
	budget?: AttemptBudget;
	helloRate?: HelloRate;
	now?: () => number;
	/** Called after a revocation is durable, to close that device's sockets. */
	onRevoked?: (deviceId: string) => void;
}

export function helloFields(
	reply: Pick<
		HelloReply,
		"generation" | "access_seq" | "setup_id" | "claimed" | "binding"
	>,
	clientNonce: Uint8Array,
	boxNonce: Uint8Array,
	identityFingerprint: string,
) {
	return [
		clientNonce,
		boxNonce,
		identityFingerprint,
		reply.binding,
		reply.generation,
		reply.access_seq,
		reply.setup_id ?? "",
		reply.claimed,
	];
}

export function claimFields(
	clientNonce: Uint8Array,
	boxNonce: Uint8Array,
	identityFingerprint: string,
	binding: string,
	generation: number,
	setupId: string,
	deviceFingerprint: string,
	name: string,
	kind: string,
) {
	return [
		clientNonce,
		boxNonce,
		identityFingerprint,
		binding,
		generation,
		setupId,
		deviceFingerprint,
		name,
		kind,
	];
}

export function joinFields(
	clientNonce: Uint8Array,
	boxNonce: Uint8Array,
	identityFingerprint: string,
	binding: string,
	generation: number,
	ticketDigest: string,
	deviceFingerprint: string,
	name: string,
	kind: string,
) {
	return [
		clientNonce,
		boxNonce,
		identityFingerprint,
		binding,
		generation,
		ticketDigest,
		deviceFingerprint,
		name,
		kind,
	];
}

export const ticketDigest = (ticket: Uint8Array) =>
	createHash("sha256").update(ticket).digest("hex");

export function authFields(
	clientNonce: Uint8Array,
	boxNonce: Uint8Array,
	identityFingerprint: string,
	binding: string,
	generation: number,
	deviceFingerprint: string,
) {
	return [
		clientNonce,
		boxNonce,
		identityFingerprint,
		binding,
		generation,
		deviceFingerprint,
	];
}

/** Enrolled and not revoked; includes devices waiting for an owner's Allow. */
const enrolledDevices = (state: CompanionState) =>
	state.devices.filter((device) => device.revoked_at === undefined);
/** Enrolled, not revoked and allowed: the devices that hold authority. */
const activeDevices = (state: CompanionState) =>
	enrolledDevices(state).filter((device) => device.pending !== true);

/**
 * The six-digit code both screens show for a join: the joiner computes it from
 * its own transcript, the owner sees the box's copy before Allow. A second
 * device that used a photographed invite shows a different code.
 */
export function joinCodeFor(joinTranscript: Uint8Array): string {
	const digest = createHash("sha256")
		.update("osb-companion/1 join-code")
		.update(joinTranscript)
		.digest();
	return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

const access = (state: CompanionState): AccessRecord => ({
	access_seq: state.access_seq,
	generation: state.generation,
});

export class CompanionChannel {
	readonly #store: CompanionStore;
	readonly #budget: AttemptBudget;
	readonly #helloRate: HelloRate;
	readonly #now: () => number;
	readonly #onRevoked: (deviceId: string) => void;
	/** Open invites by ticket digest. Memory only: a restart closes them. */
	readonly #invites = new Map<
		string,
		{ expires: number; by: string; generation: number }
	>();

	constructor(options: CompanionChannelOptions) {
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		this.#budget = options.budget ?? new AttemptBudget({ now: this.#now });
		this.#helloRate = options.helloRate ?? new HelloRate({ now: this.#now });
		this.#onRevoked = options.onRevoked ?? (() => undefined);
	}

	#read(): CompanionState | undefined {
		try {
			return this.#store.read();
		} catch (error) {
			if (error instanceof CompanionStoreError) return undefined;
			throw error;
		}
	}

	#busy(ingress: ChannelIngress): Refusal | undefined {
		const wait = this.#budget.retryAfter(ingress.key);
		return wait > 0 ? { status: "busy", retry_after_ms: wait } : undefined;
	}

	#fail(ingress: ChannelIngress, refusal: Refusal = { status: "refused" }) {
		this.#budget.fail(ingress.key);
		return refusal;
	}

	/** Takes the session's pending hello for one attempt, or explains why not. */
	#spend(
		session: ChannelSession,
		ingress: ChannelIngress,
		state: CompanionState,
	): PendingHello | Refusal {
		const hello = session.hello;
		session.hello = undefined;
		if (!hello || hello.used || hello.expires <= this.#now())
			return this.#fail(ingress);
		hello.used = true;
		if (hello.binding !== ingress.binding) return this.#fail(ingress);
		if (hello.generation !== state.generation)
			return this.#fail(ingress, { status: "stale" });
		return hello;
	}

	hello(
		session: ChannelSession,
		input: unknown,
		ingress: ChannelIngress,
	): HelloReply | Refusal {
		const clientNonce = decodeBase64(
			(input as { client_nonce?: unknown } | null)?.client_nonce,
			32,
		);
		if (!clientNonce) return { status: "invalid" };
		// Each hello costs a signature and a store read; budget it per peer.
		const wait = this.#helloRate.take(ingress.key);
		if (wait > 0) return { status: "busy", retry_after_ms: wait };
		const state = this.#read();
		if (!state) return { status: "unavailable" };
		const identity = this.#identity();
		if (!identity) return { status: "unavailable" };
		const boxNonce = randomBytes(32);
		const reply: HelloReply = {
			status: "ok",
			v: 1,
			box_nonce: boxNonce.toString("base64"),
			identity: identity.publicKey.toString("base64"),
			generation: state.generation,
			access_seq: state.access_seq,
			setup_id: state.setup?.setup_id ?? null,
			claimed: activeDevices(state).length > 0,
			binding: ingress.binding,
			signature: "",
		};
		const fields = helloFields(
			reply,
			clientNonce,
			boxNonce,
			identity.fingerprint,
		);
		reply.signature = signP256(
			identity.privateKey,
			transcript("box-hello", fields),
		).toString("base64");
		if (state.setup) {
			const proofKey = Buffer.from(state.setup.proof_key, "base64");
			reply.setup_proof = mac(
				proofKey,
				transcript("box-setup", fields),
			).toString("base64");
		}
		session.hello = {
			clientNonce,
			boxNonce,
			binding: ingress.binding,
			generation: state.generation,
			accessSeq: state.access_seq,
			setupId: state.setup?.setup_id ?? "",
			expires: this.#now() + HELLO_TTL_MS,
			used: false,
		};
		return reply;
	}

	#identity() {
		try {
			return this.#store.identity();
		} catch (error) {
			if (error instanceof CompanionStoreError) return undefined;
			throw error;
		}
	}

	claim(
		session: ChannelSession,
		input: unknown,
		ingress: ChannelIngress,
	): ({ status: "ok"; device: string } & AccessRecord) | Refusal {
		if (ingress.kind !== "setup") return { status: "refused" };
		const busy = this.#busy(ingress);
		if (busy) return busy;
		const state = this.#read();
		const identity = this.#identity();
		if (!state || !identity) return { status: "unavailable" };
		const hello = this.#spend(session, ingress, state);
		if ("status" in hello) return hello;
		const body = (input ?? {}) as Record<string, unknown>;
		const deviceKeyBytes = decodeBase64(body.device_key, 59, 128);
		const claimSignature = decodeBase64(body.claim_signature, 64);
		const deviceSignature = decodeBase64(body.device_signature, 64);
		const name = typeof body.name === "string" ? body.name : "";
		const kind = body.kind as DeviceKind;
		if (
			!deviceKeyBytes ||
			!claimSignature ||
			!deviceSignature ||
			!NAME.test(name) ||
			!KINDS.includes(kind)
		)
			return this.#fail(ingress, { status: "invalid" });
		const deviceKey = importP256(deviceKeyBytes);
		if (!deviceKey) return this.#fail(ingress, { status: "invalid" });
		if (enrolledDevices(state).length > 0 || !state.setup)
			return this.#fail(ingress, { status: "already_claimed" });
		if (state.setup.setup_id !== hello.setupId) return this.#fail(ingress);
		const claimKeyBytes = Buffer.from(state.setup.claim_key, "base64");
		const claimKey = importEd25519(claimKeyBytes);
		if (!claimKey) return { status: "unavailable" };
		const deviceFingerprint = keyFingerprint(deviceKeyBytes);
		const message = transcript(
			"claim",
			claimFields(
				hello.clientNonce,
				hello.boxNonce,
				identity.fingerprint,
				hello.binding,
				hello.generation,
				hello.setupId,
				deviceFingerprint,
				name,
				kind,
			),
		);
		if (
			!verifyEd25519(claimKey, message, claimSignature) ||
			!verifyP256(deviceKey, message, deviceSignature)
		)
			return this.#fail(ingress);

		// No await from the store read above to the durable write below, so two
		// claims cannot both pass the "unclaimed" check.
		const device: DeviceRecord = {
			id: `dev-${deviceFingerprint.slice(0, 16)}`,
			key: deviceKeyBytes.toString("base64"),
			fingerprint: deviceFingerprint,
			name,
			kind,
			role: "owner",
			added_at: new Date(this.#now()).toISOString(),
			added_by: "claim",
		};
		const next: CompanionState = {
			...state,
			access_seq: state.access_seq + 1,
			setup: null,
			retired_claims: [
				...state.retired_claims,
				keyFingerprint(claimKeyBytes),
			].slice(-RETIRED_LIMIT),
			devices: [...state.devices, device],
		};
		this.#store.write(next);
		this.#budget.succeed(ingress.key);
		session.device = { id: device.id, generation: next.generation };
		return { status: "ok", device: device.id, ...access(next) };
	}

	auth(
		session: ChannelSession,
		input: unknown,
		ingress: ChannelIngress,
	):
		| ({ status: "ok"; device: string; role: "owner" } & AccessRecord)
		| Refusal {
		const busy = this.#busy(ingress);
		if (busy) return busy;
		const state = this.#read();
		const identity = this.#identity();
		if (!state || !identity) return { status: "unavailable" };
		const hello = this.#spend(session, ingress, state);
		if ("status" in hello) return hello;
		const body = (input ?? {}) as Record<string, unknown>;
		const fingerprint =
			typeof body.device === "string" && /^[0-9a-f]{64}$/.test(body.device)
				? body.device
				: undefined;
		const signature = decodeBase64(body.signature, 64);
		if (!fingerprint || !signature)
			return this.#fail(ingress, { status: "invalid" });
		const device = enrolledDevices(state).find(
			(entry) => entry.fingerprint === fingerprint,
		);
		const key = device && importP256(Buffer.from(device.key, "base64"));
		const message = transcript(
			"auth",
			authFields(
				hello.clientNonce,
				hello.boxNonce,
				identity.fingerprint,
				hello.binding,
				hello.generation,
				fingerprint,
			),
		);
		if (!device || !key || !verifyP256(key, message, signature))
			return this.#fail(ingress);
		this.#budget.succeed(ingress.key);
		// A proven key that still waits for an owner's Allow gets no session.
		if (device.pending === true) return { status: "pending" };
		session.device = { id: device.id, generation: state.generation };
		return {
			status: "ok",
			device: device.id,
			role: device.role,
			...access(state),
		};
	}

	/**
	 * An owner opens a one-time invite for another device. The owner's screen
	 * shows the ticket and the box fingerprint as a QR; the ticket works once,
	 * for five minutes. Only the digest is kept.
	 */
	invite(session: ChannelSession):
		| {
				status: "ok";
				ticket: string;
				fingerprint: string;
				expires_at: string;
		  }
		| Refusal {
		const self = this.authorized(session);
		if (self?.role !== "owner") return { status: "not_authenticated" };
		const identity = this.#identity();
		const state = this.#read();
		if (!identity || !state) return { status: "unavailable" };
		const now = this.#now();
		for (const [digest, invite] of this.#invites)
			if (invite.expires <= now) this.#invites.delete(digest);
		if (this.#invites.size >= MAX_INVITES) return { status: "too_many" };
		const ticket = randomBytes(16);
		const expires = now + INVITE_TTL_MS;
		this.#invites.set(ticketDigest(ticket), {
			expires,
			by: self.id,
			generation: state.generation,
		});
		return {
			status: "ok",
			ticket: ticket.toString("base64"),
			fingerprint: identity.fingerprint,
			expires_at: new Date(expires).toISOString(),
		};
	}

	join(
		session: ChannelSession,
		input: unknown,
		ingress: ChannelIngress,
	): { status: "pending"; device: string; code: string } | Refusal {
		// Joining is a next-to-the-box step, like claiming: on the hotspot only.
		if (ingress.kind !== "setup") return { status: "refused" };
		const busy = this.#busy(ingress);
		if (busy) return busy;
		const state = this.#read();
		const identity = this.#identity();
		if (!state || !identity) return { status: "unavailable" };
		const hello = this.#spend(session, ingress, state);
		if ("status" in hello) return hello;
		const body = (input ?? {}) as Record<string, unknown>;
		const ticket = decodeBase64(body.ticket, 16);
		const deviceKeyBytes = decodeBase64(body.device_key, 59, 128);
		const deviceSignature = decodeBase64(body.device_signature, 64);
		const name = typeof body.name === "string" ? body.name : "";
		const kind = body.kind as DeviceKind;
		if (
			!ticket ||
			!deviceKeyBytes ||
			!deviceSignature ||
			!NAME.test(name) ||
			!KINDS.includes(kind)
		)
			return this.#fail(ingress, { status: "invalid" });
		const deviceKey = importP256(deviceKeyBytes);
		if (!deviceKey) return this.#fail(ingress, { status: "invalid" });
		const digest = ticketDigest(ticket);
		const invite = this.#invites.get(digest);
		const inviter = activeDevices(state).find(
			(entry) => entry.id === invite?.by,
		);
		if (
			!invite ||
			invite.expires <= this.#now() ||
			invite.generation !== state.generation ||
			!inviter
		)
			return this.#fail(ingress);
		const deviceFingerprint = keyFingerprint(deviceKeyBytes);
		const message = transcript(
			"join",
			joinFields(
				hello.clientNonce,
				hello.boxNonce,
				identity.fingerprint,
				hello.binding,
				hello.generation,
				digest,
				deviceFingerprint,
				name,
				kind,
			),
		);
		if (!verifyP256(deviceKey, message, deviceSignature))
			return this.#fail(ingress);
		const id = `dev-${deviceFingerprint.slice(0, 16)}`;
		if (
			state.devices.some(
				(entry) => entry.fingerprint === deviceFingerprint || entry.id === id,
			) ||
			state.devices.length >= MAX_DEVICES
		)
			return this.#fail(ingress, { status: "invalid" });
		if (
			enrolledDevices(state).filter((entry) => entry.pending === true).length >=
			MAX_INVITES
		)
			return { status: "too_many" };
		this.#invites.delete(digest);
		const code = joinCodeFor(message);
		const device: DeviceRecord = {
			id,
			key: deviceKeyBytes.toString("base64"),
			fingerprint: deviceFingerprint,
			name,
			kind,
			role: "owner",
			added_at: new Date(this.#now()).toISOString(),
			added_by: inviter.id,
			pending: true,
			code,
		};
		const next: CompanionState = {
			...state,
			access_seq: state.access_seq + 1,
			devices: [...state.devices, device],
		};
		this.#store.write(next);
		this.#budget.succeed(ingress.key);
		return { status: "pending", device: device.id, code };
	}

	/**
	 * An owner allows a device that joined with its invite, after checking
	 * that both screens show the same code.
	 */
	allow(
		session: ChannelSession,
		input: unknown,
	): ({ status: "ok"; device: string } & AccessRecord) | Refusal {
		const self = this.authorized(session);
		if (self?.role !== "owner") return { status: "not_authenticated" };
		const target = (input as { device?: unknown } | null)?.device;
		const state = this.#read();
		if (!state) return { status: "unavailable" };
		const device = enrolledDevices(state).find(
			(entry) => entry.id === target && entry.pending === true,
		);
		if (!device) return { status: "invalid" };
		const { pending: _pending, code: _code, ...allowed } = device;
		const next: CompanionState = {
			...state,
			access_seq: state.access_seq + 1,
			devices: state.devices.map((entry) =>
				entry.id === device.id
					? {
							...allowed,
							allowed_by: self.id,
							allowed_at: new Date(this.#now()).toISOString(),
						}
					: entry,
			),
		};
		this.#store.write(next);
		return { status: "ok", device: device.id, ...access(next) };
	}

	/** The session's device if it is still enrolled in the current generation. */
	authorized(session: ChannelSession): DeviceRecord | undefined {
		const current = session.device;
		if (!current) return undefined;
		const state = this.#read();
		const device = state?.devices.find((entry) => entry.id === current.id);
		if (
			!state ||
			!device ||
			device.revoked_at !== undefined ||
			device.pending === true ||
			state.generation !== current.generation
		) {
			session.device = undefined;
			return undefined;
		}
		return device;
	}

	devices(session: ChannelSession) {
		const self = this.authorized(session);
		if (!self) return { status: "not_authenticated" } as const;
		const state = this.#read();
		if (!state) return { status: "unavailable" } as const;
		return {
			status: "ok",
			generation: state.generation,
			access_seq: state.access_seq,
			devices: state.devices.map((device) => ({
				id: device.id,
				name: device.name,
				kind: device.kind,
				role: device.role,
				added_at: device.added_at,
				...(device.revoked_at ? { revoked_at: device.revoked_at } : {}),
				...(device.pending ? { pending: true, code: device.code } : {}),
				self: device.id === self.id,
			})),
		} as const;
	}

	revoke(
		session: ChannelSession,
		input: unknown,
	): ({ status: "ok"; revoked: string } & AccessRecord) | Refusal {
		const self = this.authorized(session);
		if (self?.role !== "owner") return { status: "not_authenticated" };
		const target = (input as { device?: unknown } | null)?.device;
		const state = this.#read();
		if (!state) return { status: "unavailable" };
		const device = enrolledDevices(state).find((entry) => entry.id === target);
		if (!device) return { status: "invalid" };
		const owners = activeDevices(state).filter(
			(entry) => entry.role === "owner",
		);
		if (
			device.pending !== true &&
			device.role === "owner" &&
			owners.length <= 1
		)
			return { status: "last_owner" };
		const revokedAt = new Date(this.#now()).toISOString();
		const next: CompanionState = {
			...state,
			access_seq: state.access_seq + 1,
			devices: state.devices.map((entry) =>
				entry.id === device.id ? { ...entry, revoked_at: revokedAt } : entry,
			),
		};
		this.#store.write(next);
		for (const [digest, invite] of this.#invites)
			if (invite.by === device.id) this.#invites.delete(digest);
		this.#onRevoked(device.id);
		return { status: "ok", revoked: device.id, ...access(next) };
	}
}

export interface SetupVerifier {
	setupId: string;
	claimKey: Buffer;
	proofKey: Buffer;
}

/**
 * Install fresh setup material on an unclaimed box. Refuses a claim key that
 * was used before, so an old card or insert never works again.
 */
export function provisionSetup(store: CompanionStore, verifier: SetupVerifier) {
	const state = store.read();
	if (enrolledDevices(state).length > 0)
		throw new CompanionStoreError("The box is claimed; reset it first");
	// A code that is replaced before use is retired too: an insert that was
	// handed out must not start working again later.
	const retired = state.setup
		? [
				...state.retired_claims,
				keyFingerprint(Buffer.from(state.setup.claim_key, "base64")),
			]
		: state.retired_claims;
	if (retired.includes(keyFingerprint(verifier.claimKey)))
		throw new CompanionStoreError("This setup code was already used");
	store.identity();
	store.write({
		...state,
		retired_claims: retired.slice(-RETIRED_LIMIT),
		setup: {
			setup_id: verifier.setupId,
			claim_key: verifier.claimKey.toString("base64"),
			proof_key: verifier.proofKey.toString("base64"),
		},
	});
}

/**
 * Physical reset: forget every device and any unused setup material, keep the
 * retired claim keys, advance the ownership generation and install new setup
 * material when the caller has it (otherwise setup stays unavailable).
 */
export function resetOwnership(
	store: CompanionStore,
	fresh?: SetupVerifier,
): CompanionState {
	const state = store.read();
	const retired = state.setup
		? [
				...state.retired_claims,
				keyFingerprint(Buffer.from(state.setup.claim_key, "base64")),
			]
		: state.retired_claims;
	if (fresh && retired.includes(keyFingerprint(fresh.claimKey)))
		throw new CompanionStoreError("This setup code was already used");
	const next: CompanionState = {
		...state,
		generation: state.generation + 1,
		access_seq: state.access_seq + 1,
		retired_claims: retired.slice(-RETIRED_LIMIT),
		devices: [],
		setup: fresh
			? {
					setup_id: fresh.setupId,
					claim_key: fresh.claimKey.toString("base64"),
					proof_key: fresh.proofKey.toString("base64"),
				}
			: null,
	};
	store.write(next);
	return next;
}
