import { logger } from "../../helpers/logger.ts";
import {
	nmConnGetFields,
	nmConnSetFields,
} from "../network/network-manager.ts";
import { bearerIpFamilyFields } from "./bearer-ip-family.ts";
import {
	isModemPairAtStableKey,
	type ReadyModemSim,
	readReadyModemSim,
} from "./modem-registration.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import { registerModemConfigInverse } from "./mutation-rollback.ts";
import { selectAutomaticSubscription } from "./subscription-policy.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

const FAMILY_FIELDS = [
	"ipv4.method",
	"ipv6.method",
	"ipv6.never-default",
	"ipv6.ip6-privacy",
	"ipv6.ignore-auto-dns",
] as const;
const PAIR_FIELDS = ["gsm.device-id", "gsm.sim-id"] as const;
const FORMAT = "automatic-bearer-family-v1";
export interface FamilyPair {
	readonly deviceId: string;
	readonly simId: string;
}
export interface FamilyInverse extends FamilyPair {
	readonly format: typeof FORMAT;
	readonly uuid: string;
	readonly fields: Readonly<Record<string, string>>;
}
export interface AutomaticFamilyDeps {
	readonly readFields: (
		uuid: string,
		fields: readonly string[],
	) => Promise<readonly (string | undefined)[] | undefined>;
	readonly writeFields: (
		uuid: string,
		fields: Record<string, string>,
	) => Promise<boolean>;
	readonly pairPresent: (key: string, pair: FamilyPair) => Promise<boolean>;
	readonly journal: typeof withJournaledModemMutation;
}

const defaults: AutomaticFamilyDeps = {
	readFields: nmConnGetFields,
	writeFields: nmConnSetFields,
	pairPresent: isModemPairAtStableKey,
	journal: withJournaledModemMutation,
};

function matches(
	a: Readonly<Record<string, string>>,
	b: Readonly<Record<string, string>>,
): boolean {
	return Object.keys(a).every((key) => a[key] === b[key]);
}
async function readProfile(
	uuid: string,
	pair: FamilyPair,
	deps: AutomaticFamilyDeps,
): Promise<Record<string, string> | undefined> {
	const values = await deps.readFields(uuid, [
		...PAIR_FIELDS,
		...FAMILY_FIELDS,
	]);
	if (
		!values ||
		values.length !== PAIR_FIELDS.length + FAMILY_FIELDS.length ||
		values[0] !== pair.deviceId ||
		values[1] !== pair.simId
	)
		return undefined;
	const fields: Record<string, string> = {};
	for (const [index, name] of FAMILY_FIELDS.entries()) {
		const value = values[index + 2]?.trim().split(/\s+/)[0];
		if (!value) return undefined;
		fields[name] = value;
	}
	return fields;
}

export async function restoreAutomaticBearerFamily(
	key: string,
	state: Readonly<Record<string, unknown>>,
	deps: AutomaticFamilyDeps = defaults,
): Promise<"restored" | "failed"> {
	if (
		state.format !== FORMAT ||
		typeof state.uuid !== "string" ||
		typeof state.deviceId !== "string" ||
		typeof state.simId !== "string" ||
		!state.fields ||
		typeof state.fields !== "object" ||
		Array.isArray(state.fields)
	)
		return "failed";
	const inverse: Record<string, string> = {};
	for (const name of FAMILY_FIELDS) {
		const value = (state.fields as Record<string, unknown>)[name];
		if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value))
			return "failed";
		inverse[name] = value;
	}
	const pair = { deviceId: state.deviceId, simId: state.simId };
	if (!(await deps.pairPresent(key, pair))) return "failed";
	const current = await readProfile(state.uuid, pair, deps);
	if (!current) return "failed";
	if (matches(inverse, current)) return "restored";
	if (!(await deps.writeFields(state.uuid, inverse))) return "failed";
	const after = await readProfile(state.uuid, pair, deps);
	return after && matches(inverse, after) ? "restored" : "failed";
}

/** Stored fields only: no disconnect, connect, modem reset or carrier command. */
export async function reconcileAutomaticBearerFamily(
	key: string,
	uuid: string,
	pair: FamilyPair,
	currentIntent: () => boolean,
	deps: AutomaticFamilyDeps = defaults,
): Promise<"unchanged" | "updated" | "refused" | "failed"> {
	if (!key || !uuid || !pair.deviceId || !pair.simId || !currentIntent())
		return "refused";
	const before = await readProfile(uuid, pair, deps);
	if (!before) return "refused";
	const wanted = bearerIpFamilyFields("ipv4v6") as Record<string, string>;
	if (matches(wanted, before)) return "unchanged";
	if (!(await deps.pairPresent(key, pair))) return "refused";
	const inverse: FamilyInverse = {
		format: FORMAT,
		uuid,
		...pair,
		fields: before,
	};
	const result = await deps.journal(
		key,
		"modem-config",
		{ ...inverse },
		async (mutation) => {
			const fresh = await readProfile(uuid, pair, deps);
			if (
				!currentIntent() ||
				!fresh ||
				!matches(before, fresh) ||
				!(await deps.pairPresent(key, pair))
			)
				return { confirmed: true, value: "refused" as const };
			await mutation.markExecuting();
			if (!currentIntent() || !(await deps.pairPresent(key, pair)))
				return { confirmed: true, value: "refused" as const };
			const written = await deps.writeFields(uuid, wanted);
			const after = await readProfile(uuid, pair, deps);
			if (written && after && matches(wanted, after))
				return { confirmed: true, value: "updated" as const };
			const restored = await restoreAutomaticBearerFamily(
				key,
				{ ...inverse },
				deps,
			);
			return {
				confirmed: restored === "restored",
				value: "failed" as const,
				detail: "automatic bearer family did not verify",
			};
		},
	);
	return result.ok ? result.value : "refused";
}

export function automaticBearerFamilyEligible(sim: ReadyModemSim): boolean {
	const ports = sim.modemInfo["modem.generic.ports"];
	const mode = ports.some((port) => port.endsWith(" (qmi)"))
		? "qmi"
		: ports.some((port) => port.endsWith(" (mbim)"))
			? "mbim"
			: "rndis";
	const transport = resolveTransportQuirk({
		model: sim.modemInfo["modem.generic.model"],
		firmware: sim.modemInfo["modem.generic.revision"] ?? "",
		mode,
	});
	if (transport?.owner !== "network-manager") return false;
	const subscription = selectAutomaticSubscription({
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
	return subscription.state === "recognized";
}

/** Called outside the modem reconcile lock; a manual/unknown policy is untouched. */
export async function runAutomaticBearerFamilies(): Promise<void> {
	for (const id of getModemIds()) {
		const config = getModem(id)?.config;
		const key = modemStableKeyForId(id);
		if (!config?.autoconfig || !config.conn || !key) continue;
		try {
			const sim = await readReadyModemSim(id);
			if (!sim || sim === "unreadable") continue;
			if (!automaticBearerFamilyEligible(sim)) continue;
			await reconcileAutomaticBearerFamily(
				key,
				config.conn,
				{
					deviceId: sim.modemInfo["modem.generic.device-identifier"],
					simId: sim.simInfo["sim.properties.iccid"],
				},
				() =>
					modemStableKeyForId(id) === key &&
					getModem(id)?.config === config &&
					config.autoconfig,
			);
		} catch (error) {
			logger.warn("automatic bearer family reconciliation deferred", {
				module: "modems",
				error,
			});
		}
	}
}
registerModemConfigInverse(FORMAT, {
	rollback: restoreAutomaticBearerFamily,
});
