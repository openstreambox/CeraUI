import { randomBytes } from "node:crypto";

import { newSetupId, SETUP_ID, SETUP_SECRET_BYTES } from "./keys.ts";

/**
 * The claim QR: `osb-box://claim#v=1&id=<setup id>&s=<secret>[&fp=<hex>]`.
 *
 * Everything is in the fragment, as in the hub's join link, so nothing that
 * logs URLs sees the secret. `fp` (SHA-256 of the box identity key) is present
 * when the box made its identity before the code was printed or shown. The
 * Wi-Fi join hint for the setup hotspot is a separate payload (D16) and not
 * part of this prototype.
 */
export interface SetupLink {
	setupId: string;
	secret: Buffer;
	fingerprint?: string;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{22}$/;

export function newSetupSecret(): { setupId: string; secret: Buffer } {
	return { setupId: newSetupId(), secret: randomBytes(SETUP_SECRET_BYTES) };
}

export function formatSetupLink(link: SetupLink): string {
	const params = new URLSearchParams({
		v: "1",
		id: link.setupId,
		s: link.secret.toString("base64url"),
	});
	if (link.fingerprint) params.set("fp", link.fingerprint);
	return `osb-box://claim#${params.toString()}`;
}

export function parseSetupLink(text: string): SetupLink | undefined {
	const prefix = "osb-box://claim#";
	if (!text.startsWith(prefix) || text.length > 256) return undefined;
	const params = new URLSearchParams(text.slice(prefix.length));
	const keys = [...params.keys()];
	if (new Set(keys).size !== keys.length) return undefined;
	if (keys.some((key) => !["v", "id", "s", "fp"].includes(key)))
		return undefined;
	const setupId = params.get("id") ?? "";
	const secretText = params.get("s") ?? "";
	const fingerprint = params.get("fp") ?? undefined;
	if (params.get("v") !== "1" || !SETUP_ID.test(setupId)) return undefined;
	if (!SECRET.test(secretText)) return undefined;
	if (fingerprint !== undefined && !FINGERPRINT.test(fingerprint))
		return undefined;
	const secret = Buffer.from(secretText, "base64url");
	if (secret.length !== SETUP_SECRET_BYTES) return undefined;
	return fingerprint ? { setupId, secret, fingerprint } : { setupId, secret };
}

/** An owner's invite QR: `osb-box://join#v=1&fp=<hex>&t=<ticket>`. */
export interface JoinLink {
	fingerprint: string;
	ticket: Buffer;
}

export function formatJoinLink(link: JoinLink): string {
	const params = new URLSearchParams({
		v: "1",
		fp: link.fingerprint,
		t: link.ticket.toString("base64url"),
	});
	return `osb-box://join#${params.toString()}`;
}

export function parseJoinLink(text: string): JoinLink | undefined {
	const prefix = "osb-box://join#";
	if (!text.startsWith(prefix) || text.length > 256) return undefined;
	const params = new URLSearchParams(text.slice(prefix.length));
	const keys = [...params.keys()];
	if (new Set(keys).size !== keys.length) return undefined;
	if (keys.some((key) => !["v", "fp", "t"].includes(key))) return undefined;
	const fingerprint = params.get("fp") ?? "";
	const ticketText = params.get("t") ?? "";
	if (params.get("v") !== "1" || !FINGERPRINT.test(fingerprint))
		return undefined;
	if (!SECRET.test(ticketText)) return undefined;
	const ticket = Buffer.from(ticketText, "base64url");
	return ticket.length === 16 ? { fingerprint, ticket } : undefined;
}
