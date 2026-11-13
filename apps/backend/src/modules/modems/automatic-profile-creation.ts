import { randomUUID } from "node:crypto";
import {
	type NetworkManagerConnection,
	nmConnAdd,
	nmConnDelete,
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import {
	type CarrierIntentIdentity,
	newPendingCarrierIntent,
	readCarrierIntent,
	sameCarrierIntent,
	writeCarrierIntent,
} from "./automatic-carrier-intent.ts";
import { isModemPairAtStableKey } from "./modem-registration.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import { registerModemConfigInverse } from "./mutation-rollback.ts";

const FORMAT = "automatic-profile-creation-v1";
export interface ProfileCreationDeps {
	readonly add: typeof nmConnAdd;
	readonly remove: typeof nmConnDelete;
	readonly fields: typeof nmConnGetFields;
	readonly list: typeof nmConnsGet;
	readonly readIntent: typeof readCarrierIntent;
	readonly writeIntent: typeof writeCarrierIntent;
	readonly pairPresent: typeof isModemPairAtStableKey;
	readonly journal: typeof withJournaledModemMutation;
	readonly uuid: () => string;
}
export const defaultProfileCreationDeps: ProfileCreationDeps = {
	add: nmConnAdd,
	remove: nmConnDelete,
	fields: nmConnGetFields,
	list: nmConnsGet,
	readIntent: readCarrierIntent,
	writeIntent: writeCarrierIntent,
	pairPresent: isModemPairAtStableKey,
	journal: withJournaledModemMutation,
	uuid: randomUUID,
};
function identityFrom(
	state: Readonly<Record<string, unknown>>,
): CarrierIntentIdentity | undefined {
	if (
		state.format !== FORMAT ||
		typeof state.uuid !== "string" ||
		!/^[0-9a-f-]{36}$/.test(state.uuid) ||
		typeof state.deviceId !== "string" ||
		!state.deviceId ||
		typeof state.simId !== "string" ||
		!state.simId
	)
		return undefined;
	return { uuid: state.uuid, deviceId: state.deviceId, simId: state.simId };
}
async function profileState(uuid: string, deps: ProfileCreationDeps) {
	const rows = await deps.list("uuid,type,state");
	if (!rows) return undefined;
	const matches = rows.map(nmcliParseSep).filter((row) => row[0] === uuid);
	if (matches.length > 1) return undefined;
	if (!matches.length) return "absent";
	const row = matches[0];
	return row?.[1] === "gsm" && row.length === 3 ? { state: row[2] } : undefined;
}
async function pairUnconfigured(
	pair: Omit<CarrierIntentIdentity, "uuid">,
	deps: ProfileCreationDeps,
): Promise<boolean> {
	const rows = await deps.list("uuid,type,state");
	if (!rows) return false;
	for (const row of rows) {
		const [uuid, type] = nmcliParseSep(row);
		if (type !== "gsm") continue;
		if (!uuid) return false;
		const fields = await deps.fields(uuid, [
			"gsm.device-id",
			"gsm.sim-id",
		] as const);
		if (fields?.length !== 2) return false;
		if (fields[0] === pair.deviceId && fields[1] === pair.simId) return false;
	}
	return true;
}
/** Delete only our preallocated UUID, exact pair/name, disarmed and unused. */
export async function restoreCreatedProfile(
	key: string,
	state: Readonly<Record<string, unknown>>,
	deps: ProfileCreationDeps = defaultProfileCreationDeps,
): Promise<"restored" | "failed"> {
	const identity = identityFrom(state);
	if (!identity || !(await deps.pairPresent(key, identity))) return "failed";
	const current = await profileState(identity.uuid, deps);
	const intent = await deps.readIntent(identity);
	if (
		current === undefined ||
		intent?.mode === "manual" ||
		(current !== "absent" && !intent)
	)
		return "failed";
	if (current !== "absent") {
		if (current.state !== "") return "failed";
		const fields = await deps.fields(identity.uuid, [
			"connection.id",
			"gsm.device-id",
			"gsm.sim-id",
			"connection.autoconnect",
		] as const);
		if (
			fields?.length !== 4 ||
			fields[0] !== `cellular-${identity.uuid}` ||
			fields[1] !== identity.deviceId ||
			fields[2] !== identity.simId ||
			fields[3] !== "no" ||
			!(await deps.pairPresent(key, identity))
		)
			return "failed";
		if (
			!(await deps.remove(identity.uuid)) ||
			(await profileState(identity.uuid, deps)) !== "absent"
		)
			return "failed";
	}
	await deps.writeIntent(identity, undefined);
	return (await deps.readIntent(identity)) === undefined
		? "restored"
		: "failed";
}
/** Creation cannot call the modem: autoconnect stays off until transport preparation. */
export async function createDisarmedProfile(
	key: string,
	pair: Omit<CarrierIntentIdentity, "uuid">,
	fields: NetworkManagerConnection,
	current: () => Promise<boolean>,
	deps: ProfileCreationDeps = defaultProfileCreationDeps,
): Promise<
	{ state: "created"; uuid: string } | { state: "pending" | "attempted" }
> {
	const identity = { ...pair, uuid: deps.uuid() };
	if (
		!identityFrom({ format: FORMAT, ...identity }) ||
		fields["gsm.device-id"] !== pair.deviceId ||
		fields["gsm.sim-id"] !== pair.simId ||
		!(await current()) ||
		!(await deps.pairPresent(key, pair))
	)
		return { state: "pending" };
	if (
		(await profileState(identity.uuid, deps)) !== "absent" ||
		(await deps.readIntent(identity)) ||
		!(await pairUnconfigured(pair, deps))
	)
		return { state: "pending" };
	const inverse = { format: FORMAT, ...identity };
	let dispatched = false;
	const result = await deps.journal(
		key,
		"modem-config",
		inverse,
		async (mutation) => {
			if (
				!(await current()) ||
				!(await deps.pairPresent(key, pair)) ||
				(await profileState(identity.uuid, deps)) !== "absent" ||
				!(await pairUnconfigured(pair, deps))
			)
				return { confirmed: true, value: undefined };
			await mutation.markExecuting();
			if (!(await current()) || !(await deps.pairPresent(key, pair)))
				return { confirmed: true, value: undefined };
			try {
				const intent = newPendingCarrierIntent(identity, fields["gsm.apn"]);
				await deps.writeIntent(identity, intent);
				dispatched = true;
				const uuid = await deps.add({
					...fields,
					"connection.uuid": identity.uuid,
					"connection.id": `cellular-${identity.uuid}`,
					autoconnect: "no",
				});
				const expected = await deps.fields(identity.uuid, [
					"connection.id",
					"gsm.device-id",
					"gsm.sim-id",
					"connection.autoconnect",
				] as const);
				if (
					uuid === identity.uuid &&
					expected?.length === 4 &&
					expected[0] === `cellular-${identity.uuid}` &&
					expected[1] === pair.deviceId &&
					expected[2] === pair.simId &&
					expected[3] === "no" &&
					sameCarrierIntent(await deps.readIntent(identity), intent) &&
					(await current()) &&
					(await deps.pairPresent(key, pair))
				)
					return { confirmed: true, value: uuid };
			} catch {
				// The preallocated UUID lets recovery find a write whose reply was lost.
			}
			const restored = await restoreCreatedProfile(key, inverse, deps).catch(
				() => "failed" as const,
			);
			return {
				confirmed: restored === "restored",
				value: undefined,
				detail: "profile creation did not verify",
			};
		},
	);
	return result.ok && result.value
		? { state: "created", uuid: result.value }
		: { state: dispatched ? "attempted" : "pending" };
}
registerModemConfigInverse(FORMAT, { rollback: restoreCreatedProfile });
