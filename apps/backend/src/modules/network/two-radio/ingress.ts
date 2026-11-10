import { z } from "zod";
import type { Identity } from "./effect-adapter.ts";
import { type Radio, sameEpoch, type TraceEvent } from "./reducer.ts";

const text = z.string().min(1).max(512);
const time = z.number().finite().nonnegative();
const number = z.number().int().nonnegative().safe();
const radio = z.enum(["a", "b"]);
export const epochSchema = z.strictObject({
	bssid: text,
	lease: text,
	routeGeneration: number,
	activation: text,
});
const challenge = z.strictObject({
	id: text,
	radio,
	epoch: epochSchema,
	target: text,
	round: text,
	socket: text,
	startedAt: time,
	expiresAt: time,
});
const event = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("tick") }),
	z.strictObject({
		type: z.literal("identity"),
		radio,
		epoch: epochSchema.nullable(),
	}),
	z.strictObject({ type: z.literal("challenge"), challenge }),
	z.strictObject({
		type: z.literal("response"),
		id: text,
		radio,
		epoch: epochSchema,
		socket: text,
		nonce: text,
		ok: z.boolean(),
	}),
	z.strictObject({
		type: z.literal("round-complete"),
		target: text,
		round: text,
	}),
	z.strictObject({
		type: z.literal("depart"),
		radio,
		action: z.enum([
			"disconnect",
			"reassociate",
			"scan",
			"reapply",
			"forced-renew",
		]),
	}),
	z.strictObject({ type: z.literal("swap") }),
	z.strictObject({
		type: z.literal("traffic"),
		operation: number,
		radio,
		epoch: epochSchema,
	}),
	z.strictObject({ type: z.literal("cancel"), operation: number }),
]);
const rowSchema = z.strictObject({
	version: z.literal(1),
	at: time,
	physical: text.optional(),
	event,
});
export interface IngressAuthority {
	/** Owner-maintained physical binding; never a position in nmcli/iw output. */
	resolve(physical: string): { radio: Radio; identity: Identity } | null;
	absent(physical: string, radio: Radio): boolean;
	/** Original dispatch/socket record proving SO_BINDTODEVICE on this incarnation. */
	bound(socket: string, identity: Identity, nonce: string): boolean;
	/** Correlated real sender/receiver receipt; a probe arrival is insufficient. */
	traffic(operation: number, identity: Identity): boolean;
}
export class Ingress {
	private at = 0;
	constructor(private readonly authority: IngressAuthority) {}
	parse(json: string): TraceEvent {
		if (json.length > 16_384) throw new Error("Oversize event record");
		const row = rowSchema.parse(JSON.parse(json));
		if (row.at < this.at) throw new Error("Nonmonotonic trace");
		const e = row.event;
		const r =
			e.type === "challenge"
				? e.challenge.radio
				: "radio" in e
					? e.radio
					: undefined;
		let deviceBound = false;
		if (r !== undefined) {
			if (!row.physical) throw new Error("Missing physical identity");
			const binding = this.authority.resolve(row.physical);
			if (e.type === "identity" && e.epoch === null) {
				if (!this.authority.absent(row.physical, r))
					throw new Error("Absence unknown");
			} else {
				if (
					!binding ||
					binding.radio !== r ||
					binding.identity.physical !== row.physical
				)
					throw new Error("Unmapped physical identity");
				const epoch =
					e.type === "challenge"
						? e.challenge.epoch
						: "epoch" in e
							? e.epoch
							: undefined;
				if (epoch && !sameEpoch(epoch, binding.identity.epoch))
					throw new Error("Stale epoch");
				if (e.type === "challenge") {
					deviceBound = this.authority.bound(
						e.challenge.socket,
						binding.identity,
						e.challenge.id,
					);
					if (
						!deviceBound ||
						e.challenge.startedAt !== row.at ||
						e.challenge.expiresAt <= row.at
					)
						throw new Error("Unattested challenge");
				}
				if (
					e.type === "traffic" &&
					!this.authority.traffic(e.operation, binding.identity)
				)
					throw new Error("Unattested traffic");
			}
		}
		this.at = row.at;
		return {
			version: 1,
			at: row.at,
			event: e.type === "challenge" ? { ...e, deviceBound } : e,
		};
	}
}
