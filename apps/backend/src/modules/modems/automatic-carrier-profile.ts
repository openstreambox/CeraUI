import "./automatic-bearer-family.ts";
import { logger } from "../../helpers/logger.ts";
import {
	nmConnGetFields,
	nmConnSetFields,
} from "../network/network-manager.ts";
import { automaticBearerFamilyEligible } from "./automatic-bearer-family.ts";
import {
	type CarrierIntent,
	type CarrierIntentIdentity,
	effectiveCarrierAutomatic,
	newCarrierIntent,
	parseCarrierIntent,
	readCarrierIntent,
	sameCarrierIntent,
	writeCarrierIntent,
} from "./automatic-carrier-intent.ts";
import { bearerIpFamilyFields } from "./bearer-ip-family.ts";
import { resetGsmConnections } from "./gsm-connections.ts";
import {
	isModemPairAtStableKey,
	type ReadyModemSim,
	readReadyModemSim,
} from "./modem-registration.ts";
import { getModem, getModemIds, setModem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import { registerModemConfigInverse } from "./mutation-rollback.ts";
import {
	type CarrierPolicy,
	selectSubscription,
} from "./subscription-policy.ts";

const FORMAT = "automatic-carrier-profile-v1";
const FIELDS = [
	"gsm.apn",
	"gsm.auto-config",
	"ipv4.method",
	"ipv6.method",
	"ipv6.never-default",
	"ipv6.ip6-privacy",
	"ipv6.ignore-auto-dns",
] as const;
export interface CarrierProfileDeps {
	readonly readFields: (
		uuid: string,
		names: readonly string[],
	) => Promise<readonly (string | undefined)[] | undefined>;
	readonly writeFields: (
		uuid: string,
		fields: Record<string, string>,
	) => Promise<boolean>;
	readonly pairPresent: (
		key: string,
		identity: CarrierIntentIdentity,
	) => Promise<boolean>;
	readonly readIntent: typeof readCarrierIntent;
	readonly writeIntent: typeof writeCarrierIntent;
	readonly journal: typeof withJournaledModemMutation;
}
export const defaultCarrierProfileDeps: CarrierProfileDeps = {
	readFields: nmConnGetFields,
	writeFields: nmConnSetFields,
	pairPresent: isModemPairAtStableKey,
	readIntent: readCarrierIntent,
	writeIntent: writeCarrierIntent,
	journal: withJournaledModemMutation,
};
const matches = (
	wanted: Readonly<Record<string, string>>,
	actual: Readonly<Record<string, string>>,
) => Object.keys(wanted).every((key) => wanted[key] === actual[key]);
async function readProfile(
	identity: CarrierIntentIdentity,
	deps: CarrierProfileDeps,
): Promise<Record<string, string> | undefined> {
	const values = await deps.readFields(identity.uuid, [
		"gsm.device-id",
		"gsm.sim-id",
		...FIELDS,
	]);
	if (
		!values ||
		values.length !== FIELDS.length + 2 ||
		values[0] !== identity.deviceId ||
		values[1] !== identity.simId
	)
		return undefined;
	const fields: Record<string, string> = {};
	for (const [index, name] of FIELDS.entries()) {
		const raw = values[index + 2];
		if (raw === undefined || raw.length > 256 || /[\r\n\0]/.test(raw))
			return undefined;
		const value = name === "gsm.apn" ? raw : raw.trim().split(/\s+/)[0];
		if (
			value === undefined ||
			(name !== "gsm.apn" && !/^[a-z0-9-]+$/.test(value))
		)
			return undefined;
		fields[name] = value;
	}
	return fields;
}
function inverseFrom(state: Readonly<Record<string, unknown>>):
	| {
			identity: CarrierIntentIdentity;
			fields: Record<string, string>;
			intent: CarrierIntent | undefined;
	  }
	| undefined {
	if (
		state.format !== FORMAT ||
		typeof state.uuid !== "string" ||
		!state.uuid ||
		typeof state.deviceId !== "string" ||
		!state.deviceId ||
		typeof state.simId !== "string" ||
		!state.simId ||
		!state.fields ||
		typeof state.fields !== "object" ||
		Array.isArray(state.fields)
	)
		return undefined;
	const identity = {
		uuid: state.uuid,
		deviceId: state.deviceId,
		simId: state.simId,
	};
	const fields: Record<string, string> = {};
	for (const name of FIELDS) {
		const value = (state.fields as Record<string, unknown>)[name];
		if (
			typeof value !== "string" ||
			value.length > 256 ||
			/[\r\n\0]/.test(value) ||
			(name !== "gsm.apn" && !/^[a-z0-9-]+$/.test(value))
		)
			return undefined;
		fields[name] = value;
	}
	try {
		return {
			identity,
			fields,
			intent:
				state.intent === null
					? undefined
					: parseCarrierIntent(identity, state.intent),
		};
	} catch {
		return undefined;
	}
}
export async function restoreAutomaticCarrierProfile(
	key: string,
	state: Readonly<Record<string, unknown>>,
	deps: CarrierProfileDeps = defaultCarrierProfileDeps,
): Promise<"restored" | "failed"> {
	const inverse = inverseFrom(state);
	if (!inverse || !(await deps.pairPresent(key, inverse.identity)))
		return "failed";
	const current = await readProfile(inverse.identity, deps);
	if (!current) return "failed";
	if (!matches(inverse.fields, current)) {
		if (!(await deps.writeFields(inverse.identity.uuid, inverse.fields)))
			return "failed";
		const after = await readProfile(inverse.identity, deps);
		if (!after || !matches(inverse.fields, after)) return "failed";
	}
	await deps.writeIntent(inverse.identity, inverse.intent);
	const intent = await deps.readIntent(inverse.identity);
	return sameCarrierIntent(intent, inverse.intent) ? "restored" : "failed";
}

export async function reconcileAutomaticCarrierProfile(
	key: string,
	identity: CarrierIntentIdentity,
	policy: CarrierPolicy,
	current: () => Promise<boolean>,
	deps: CarrierProfileDeps = defaultCarrierProfileDeps,
): Promise<"unchanged" | "updated" | "preserved" | "refused" | "failed"> {
	if (!key || !policy.qualified || !(await current())) return "refused";
	const before = await readProfile(identity, deps);
	if (!before) return "refused";
	const oldIntent = await deps.readIntent(identity);
	if (
		!effectiveCarrierAutomatic(
			oldIntent,
			before["gsm.auto-config"] === "yes",
			before["gsm.apn"] ?? "",
		)
	)
		return "preserved";
	const wanted = {
		"gsm.apn": policy.apn,
		"gsm.auto-config": "no",
		...bearerIpFamilyFields(policy.requestFamily),
	} as Record<string, string>;
	const applied = newCarrierIntent(identity, "automatic", policy.apn);
	if (matches(wanted, before) && sameCarrierIntent(oldIntent, applied))
		return "unchanged";
	if (!(await deps.pairPresent(key, identity))) return "refused";
	const inverse = {
		format: FORMAT,
		...identity,
		fields: before,
		intent: oldIntent ?? null,
	};
	const result = await deps.journal(
		key,
		"modem-config",
		inverse,
		async (mutation) => {
			const fresh = await readProfile(identity, deps);
			const intent = await deps.readIntent(identity);
			if (
				!fresh ||
				!matches(before, fresh) ||
				!sameCarrierIntent(intent, oldIntent) ||
				!(await current()) ||
				!(await deps.pairPresent(key, identity))
			)
				return { confirmed: true, value: "refused" as const };
			await mutation.markExecuting();
			if (!(await current()) || !(await deps.pairPresent(key, identity)))
				return { confirmed: true, value: "refused" as const };
			try {
				await deps.writeIntent(
					identity,
					newCarrierIntent(identity, "automatic"),
				);
				const written = await deps.writeFields(identity.uuid, wanted);
				const after = await readProfile(identity, deps);
				if (
					written &&
					after &&
					matches(wanted, after) &&
					(await current()) &&
					(await deps.pairPresent(key, identity))
				) {
					await deps.writeIntent(identity, applied);
					if (sameCarrierIntent(await deps.readIntent(identity), applied))
						return { confirmed: true, value: "updated" as const };
				}
				const restored = await restoreAutomaticCarrierProfile(
					key,
					inverse,
					deps,
				);
				return {
					confirmed: restored === "restored",
					value: "failed" as const,
					detail: "automatic carrier profile did not verify",
				};
			} catch (error) {
				const restored = await restoreAutomaticCarrierProfile(
					key,
					inverse,
					deps,
				).catch(() => "failed" as const);
				if (restored !== "restored") throw error;
				return { confirmed: true, value: "failed" as const };
			}
		},
	);
	return result.ok ? result.value : "refused";
}

function policyFor(sim: ReadyModemSim): CarrierPolicy | undefined {
	if (!automaticBearerFamilyEligible(sim)) return undefined;
	const choice = selectSubscription({
		...(sim.simInfo["sim.properties.operator-code"]
			? { homePlmn: sim.simInfo["sim.properties.operator-code"] }
			: {}),
		...(sim.modemInfo["modem.3gpp.operator-code"]
			? { servingPlmn: sim.modemInfo["modem.3gpp.operator-code"] }
			: {}),
		...(sim.simInfo["sim.properties.operator-name"]
			? { spn: sim.simInfo["sim.properties.operator-name"] }
			: {}),
		...(sim.simInfo["sim.properties.gid1"]
			? { gid1: sim.simInfo["sim.properties.gid1"] }
			: {}),
	});
	return choice.state === "recognized" ? choice.policy : undefined;
}
export async function runAutomaticCarrierProfiles(): Promise<
	readonly number[]
> {
	const changed: number[] = [];
	for (const id of getModemIds()) {
		const config = getModem(id)?.config;
		const key = modemStableKeyForId(id);
		if (!config?.conn || !config.autoconfig || !key) continue;
		try {
			const sim = await readReadyModemSim(id);
			if (!sim || sim === "unreadable") continue;
			const policy = policyFor(sim);
			if (!policy) continue;
			const identity = {
				uuid: config.conn,
				deviceId: sim.modemInfo["modem.generic.device-identifier"],
				simId: sim.simInfo["sim.properties.iccid"],
			};
			const current = async () => {
				if (
					modemStableKeyForId(id) !== key ||
					getModem(id)?.config !== config ||
					!config.autoconfig
				)
					return false;
				const fresh = await readReadyModemSim(id);
				return (
					!!fresh &&
					fresh !== "unreadable" &&
					fresh.modemInfo["modem.generic.device-identifier"] ===
						identity.deviceId &&
					fresh.simInfo["sim.properties.iccid"] === identity.simId &&
					policyFor(fresh)?.key === policy.key
				);
			};
			const result = await reconcileAutomaticCarrierProfile(
				key,
				identity,
				policy,
				current,
			);
			if (result === "updated") {
				const modem = getModem(id);
				if (modem?.config === config) {
					setModem(id, { ...modem, config: { ...config, apn: policy.apn } });
					changed.push(id);
				}
				resetGsmConnections();
			}
		} catch (error) {
			logger.warn("automatic carrier profile reconciliation deferred", {
				module: "modems",
				error,
			});
		}
	}
	return changed;
}
registerModemConfigInverse(FORMAT, {
	rollback: restoreAutomaticCarrierProfile,
});
