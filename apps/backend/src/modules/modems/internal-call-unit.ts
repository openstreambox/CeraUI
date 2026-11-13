import type { CellularPhysicalLink } from "../network/cellular-host-identity.ts";
import { isSafeIfname } from "../network/safe-ifname.ts";
import { preparationKey } from "./cellular-preparation-state.ts";
import type { CellularControlTarget } from "./modems.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

/** Opaque unit/subscriber evidence is pairing, never carrier/APN policy. */
export function internalCallUnitKey(equipment: string): string | undefined {
	return /^\d{14,16}$/.test(equipment) && equipment.trim() === equipment
		? preparationKey("unit", equipment)
		: undefined;
}
export function internalCallSubscriptionKey(
	subscriber: string,
): string | undefined {
	return /^\d{14,16}$/.test(subscriber) && subscriber.trim() === subscriber
		? preparationKey("subscription", subscriber)
		: undefined;
}
export interface InternalCallUnitReference {
	readonly stableKey: string;
	readonly unit: string;
	readonly physical: CellularPhysicalLink;
}
export interface InternalCallUnitLookupDeps {
	readonly list: () => Promise<readonly number[] | undefined>;
	readonly info: (
		id: number,
	) => Promise<
		{ readonly uid: string; readonly equipment: string } | undefined
	>;
	readonly resolveUid: (uid: string) => Promise<string>;
	readonly target: (
		id: number,
		key: string,
	) => Promise<CellularControlTarget | undefined>;
}
/** Find the current MM object for inverse only. Core identity is read before
 * SIM-dependent transport: an unrelated modem without a SIM cannot donate an
 * old allocation or force this unit to borrow a remembered index. Complete
 * roster/identity errors and ambiguous same-unit objects remain unknown.
 */
export async function findInternalCallUnit(
	raw: InternalCallUnitReference,
	deps: InternalCallUnitLookupDeps,
): Promise<CellularControlTarget | undefined> {
	const frame = Object.freeze({
		stableKey: raw.stableKey,
		unit: raw.unit,
		physical: Object.freeze({ ...raw.physical }),
	});
	const fields = [
		"ifname",
		"ifindex",
		"usbDevice",
		"netDevice",
		"generation",
	] as const;
	if (
		!frame.stableKey ||
		!/^[a-f0-9]{64}$/.test(frame.unit) ||
		fields.some(
			(field) =>
				typeof frame.physical[field] !== "string" || !frame.physical[field],
		) ||
		!isSafeIfname(frame.physical.ifname) ||
		!/^[1-9]\d{0,9}$/.test(frame.physical.ifindex)
	)
		return undefined;
	const inventory = async () => {
		const ids = await deps.list();
		return ids &&
			ids.length <= 32 &&
			new Set(ids).size === ids.length &&
			ids.every((id) => Number.isSafeInteger(id) && id >= 0)
			? [...ids].sort((a, b) => a - b)
			: undefined;
	};
	try {
		const ids = await inventory();
		if (!ids) return undefined;
		const matches: CellularControlTarget[] = [];
		for (const id of ids) {
			const info = await deps.info(id),
				uid = info?.uid;
			if (!info || !uid) return undefined;
			if ((await deps.resolveUid(uid)) !== frame.physical.usbDevice) continue;
			if (internalCallUnitKey(info.equipment) !== frame.unit) return undefined;
			const target = await deps.target(id, frame.stableKey);
			if (
				!target ||
				target.id !== id ||
				target.key !== frame.stableKey ||
				internalCallUnitKey(target.equipment) !== frame.unit ||
				resolveTransportQuirk(target.identity)?.owner !== "internal-call" ||
				fields.some((field) => frame.physical[field] !== target[field])
			)
				return undefined;
			matches.push(
				Object.freeze({
					...target,
					identity: Object.freeze({ ...target.identity }),
				}),
			);
		}
		return matches.length === 1 &&
			JSON.stringify(ids) === JSON.stringify(await inventory())
			? matches[0]
			: undefined;
	} catch {
		return undefined;
	}
}
