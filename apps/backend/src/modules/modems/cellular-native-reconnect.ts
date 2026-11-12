import { z } from "zod";
import type { withJournaledModemMutation } from "./mutation-lease.ts";

const identifier = z.string().min(1).max(256),
	digest = z.string().regex(/^[a-f0-9]{64}$/),
	baselineSchema = z
		.object({
			format: z.literal("cellular-native-reconnect-v1"),
			uuid: z.string().uuid(),
			deviceId: identifier,
			simId: identifier,
			subscriber: identifier,
			equipment: identifier,
			model: identifier,
			firmware: identifier,
			mode: z.enum(["qmi", "mbim"]),
			homeDigest: digest,
			profileDigest: digest,
		})
		.strict();
export type CellularNativeReconnectBaseline = Readonly<
	z.infer<typeof baselineSchema>
>;
export function parseCellularNativeReconnectBaseline(
	raw: unknown,
): CellularNativeReconnectBaseline {
	return Object.freeze(baselineSchema.parse(raw));
}
export interface CellularNativeReconnectObservation {
	readonly baseline: CellularNativeReconnectBaseline;
	/** Fresh physical generation, not an MM index or NM object path. */
	readonly physicalGeneration: string;
	readonly state: "active" | "idle";
	/** Positive transport preparation and registration for a new host call. */
	readonly prepared: boolean;
}
export interface CellularNativeReconnectDeps {
	readonly read: (
		key: string,
		baseline: CellularNativeReconnectBaseline,
	) => Promise<CellularNativeReconnectObservation | undefined>;
	readonly disconnect: (uuid: string) => Promise<unknown>;
	readonly connect: (uuid: string) => Promise<unknown>;
	readonly journal: typeof withJournaledModemMutation;
	readonly now: () => number;
}
const same = (
	a: CellularNativeReconnectBaseline,
	b: CellularNativeReconnectBaseline,
) =>
	JSON.stringify(parseCellularNativeReconnectBaseline(a)) ===
	JSON.stringify(parseCellularNativeReconnectBaseline(b));
async function read(
	deps: CellularNativeReconnectDeps,
	key: string,
	baseline: CellularNativeReconnectBaseline,
) {
	try {
		const observed = await deps.read(key, baseline);
		return observed?.physicalGeneration && same(observed.baseline, baseline)
			? observed
			: undefined;
	} catch {
		return undefined;
	}
}
/** Called only after the retained data-plane session has completely withdrawn.
 * The existing identity lease/journal covers every call. No radio/USB reset,
 * APN rewrite, source publication or retry loop belongs to this transaction.
 */
export async function reconnectCellularNative(
	key: string,
	raw: CellularNativeReconnectBaseline,
	withdrawn: () => boolean,
	deps: CellularNativeReconnectDeps,
): Promise<boolean> {
	const baseline = parseCellularNativeReconnectBaseline(raw),
		deadline = deps.now() + 90_000,
		permitted = () => withdrawn() && deps.now() < deadline;
	if (!permitted()) return false;
	const first = await read(deps, key, baseline);
	if (first?.state !== "active" || !first.prepared || !permitted())
		return false;
	const current = async () => {
		if (!permitted()) return undefined;
		const next = await read(deps, key, baseline);
		return permitted() && next?.physicalGeneration === first.physicalGeneration
			? next
			: undefined;
	};
	const result = await deps.journal(
		key,
		"modem-config",
		baseline,
		async (mutation) => {
			const before = await current();
			if (before?.state !== "active" || !before.prepared)
				return { confirmed: true, value: false };
			await mutation.markExecuting();
			const dispatch = await current();
			if (dispatch?.state !== "active" || !dispatch.prepared)
				return { confirmed: true, value: false };
			try {
				await deps.disconnect(baseline.uuid);
			} catch {
				// A lost CLI reply is settled only by positive state on the same pair.
			}
			const idle = await current();
			if (idle?.state !== "idle" || !idle.prepared)
				return {
					confirmed: false,
					value: false,
					detail: "native disconnect was not confirmed",
				};
			// This check deliberately does not reuse the old bearer lifetime: our
			// own disconnect revokes it. Fresh pair/USB/profile evidence is required.
			const connect = await current();
			if (connect?.state !== "idle" || !connect.prepared)
				return {
					confirmed: false,
					value: false,
					detail: "native reconnect lost its prepared pair",
				};
			try {
				await deps.connect(baseline.uuid);
			} catch {
				// Never retry a command whose effect is still unknown.
			}
			const active = await current(),
				confirmed = active?.state === "active";
			return {
				confirmed,
				value: confirmed,
				detail: "native reconnect requires fresh active-profile evidence",
			};
		},
	);
	return result.ok && result.value;
}

/** Startup invokes this through the existing modem-config inverse, after host
 * withdrawal. It can only restore the same saved profile, never tear it down.
 * Missing preparation remains failed, including after a new boot.
 */
export async function restoreCellularNativeReconnect(
	key: string,
	raw: unknown,
	deps: CellularNativeReconnectDeps,
): Promise<"restored" | "failed"> {
	let baseline: CellularNativeReconnectBaseline;
	try {
		baseline = parseCellularNativeReconnectBaseline(raw);
	} catch {
		return "failed";
	}
	const before = await read(deps, key, baseline);
	if (!before) return "failed";
	if (before.state === "active") return "restored";
	if (!before.prepared) return "failed";
	try {
		await deps.connect(baseline.uuid);
	} catch {
		/* Positive readback is required. */
	}
	const after = await read(deps, key, baseline);
	return after?.physicalGeneration === before.physicalGeneration &&
		after.state === "active"
		? "restored"
		: "failed";
}
