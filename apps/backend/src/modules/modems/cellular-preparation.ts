import { logger } from "../../helpers/logger.ts";
import {
	nmConnGetFields,
	nmConnSetFields,
} from "../network/network-manager.ts";
import {
	type CarrierIntentIdentity,
	effectiveCarrierAutomatic,
	readCarrierIntent,
} from "./automatic-carrier-intent.ts";
import { accessCellularAuthority } from "./cellular-authority-store.ts";
import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import {
	acquireCellularControl,
	type CellularControlTarget,
	cellularTargetPresent,
	readCellularControlTarget,
	readCellularRawIp,
	resetCellularTarget,
	setCellularInitialEps,
	writeCellularRawIp,
} from "./modems.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import { registerModemConfigInverse } from "./mutation-rollback.ts";
import {
	type CarrierPolicy,
	selectSubscription,
} from "./subscription-policy.ts";
import { decideInitialEps, resolveTransportQuirk } from "./transport-policy.ts";

const FORMAT = "cellular-preparation-v1";

export {
	type PreparationRecord,
	preparationKey,
} from "./cellular-preparation-state.ts";

import {
	type PreparationRecord,
	parsePreparationRecord,
	preparationKey,
} from "./cellular-preparation-state.ts";

async function readRecord(key: string): Promise<PreparationRecord | undefined> {
	return accessCellularAuthority(
		"cellular-preparation",
		key,
		parsePreparationRecord,
		async (value) => value,
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
	);
}
async function writeRecord(record: PreparationRecord) {
	await accessCellularAuthority(
		"cellular-preparation",
		record.key,
		parsePreparationRecord,
		async (_value, write) => write(record),
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
	);
}
export interface CellularPreparationDeps {
	readonly target: typeof readCellularControlTarget;
	readonly present: typeof cellularTargetPresent;
	readonly acquire: typeof acquireCellularControl;
	readonly raw: typeof readCellularRawIp;
	readonly writeRaw: typeof writeCellularRawIp;
	readonly setEps: typeof setCellularInitialEps;
	readonly reset: typeof resetCellularTarget;
	readonly read: typeof readRecord;
	readonly write: typeof writeRecord;
	readonly fields: typeof nmConnGetFields;
	readonly setFields: typeof nmConnSetFields;
	readonly intent: typeof readCarrierIntent;
	readonly journal: typeof withJournaledModemMutation;
	readonly now: () => number;
	readonly autoConfigSupported: () => boolean;
}
export const defaultCellularPreparationDeps: CellularPreparationDeps = {
	target: readCellularControlTarget,
	present: cellularTargetPresent,
	acquire: acquireCellularControl,
	raw: readCellularRawIp,
	writeRaw: writeCellularRawIp,
	setEps: setCellularInitialEps,
	reset: resetCellularTarget,
	read: readRecord,
	write: writeRecord,
	fields: nmConnGetFields,
	setFields: nmConnSetFields,
	intent: readCarrierIntent,
	journal: withJournaledModemMutation,
	now: Date.now,
	autoConfigSupported: resolveGsmAutoconfigSupport,
};
export type PreparationOutcome =
	| "ready"
	| "pending"
	| "preserved"
	| "waiting-usb"
	| "blocked";
const ready = new Map<
	string,
	{
		target: CellularControlTarget;
		identity: CarrierIntentIdentity;
		policy: string;
	}
>();
const profileKey = (identity: CarrierIntentIdentity) =>
	preparationKey("profile", identity.uuid, identity.deviceId, identity.simId);
const epoch = (target: CellularControlTarget) =>
	preparationKey(target.generation);
async function automatic(
	uuid: string,
	target: CellularControlTarget,
	deps: CellularPreparationDeps,
) {
	const values = await deps.fields(uuid, [
		"gsm.device-id",
		"gsm.sim-id",
		"gsm.auto-config",
		"gsm.apn",
		"connection.autoconnect",
		"connection.id",
	] as const);
	if (
		values?.length !== 6 ||
		values[0] !== target.deviceId ||
		values[1] !== target.simId ||
		!["yes", "no"].includes(values[4] ?? "")
	)
		return undefined;
	const identity = { uuid, deviceId: target.deviceId, simId: target.simId };
	const intent = await deps.intent(identity);
	return effectiveCarrierAutomatic(intent, values[2] === "yes", values[3])
		? { identity, values, intent }
		: undefined;
}
/** Keep NM from submitting an early host call, including after process/USB return. */
async function takeProfile(
	uuid: string,
	target: CellularControlTarget,
	current: () => Promise<boolean>,
	deps: CellularPreparationDeps,
	policy: CarrierPolicy | undefined,
): Promise<"ready" | "preserved" | "blocked"> {
	const selected = await automatic(uuid, target, deps);
	if (!selected || !(await current())) return "preserved";
	const key = profileKey(selected.identity);
	let record = await deps.read(key);
	if (record && record.kind !== "profile")
		throw new Error("Unexpected preparation authority");
	if (!record) {
		const birth = selected.values[5] === `cellular-${uuid}`;
		if (selected.values[4] === "no" && !birth) return "preserved";
		record = {
			version: 1,
			kind: "profile",
			key,
			original: selected.values[4] as "yes" | "no",
			birth,
			originalAuto: selected.values[2] === "yes" ? "yes" : "no",
			originalApn: selected.values[3],
		};
		// Baseline is durable before demotion, including when the following write fails.
		await deps.write(record);
	}
	if (!(await current())) return "preserved";
	if (policy === undefined && selected.intent?.appliedApn !== undefined)
		return "preserved";
	if (
		selected.values[4] !== "no" &&
		!(await deps.setFields(uuid, { "connection.autoconnect": "no" }))
	)
		return "blocked";
	if (
		!policy &&
		record.birth &&
		selected.intent?.phase === "pending" &&
		selected.values[2] !== "yes" &&
		!deps.autoConfigSupported()
	)
		return "preserved";
	const enableGeneric =
		!policy &&
		record.birth &&
		selected.intent?.phase === "pending" &&
		selected.values[2] !== "yes" &&
		deps.autoConfigSupported();
	if (
		enableGeneric &&
		!(await deps.setFields(uuid, { "gsm.auto-config": "yes", "gsm.apn": "" }))
	)
		return "blocked";
	const verified = await automatic(uuid, target, deps);
	if (!(await current())) return "preserved";
	return verified &&
		verified.values[4] === "no" &&
		(!enableGeneric ||
			(verified.values[2] === "yes" && verified.values[3] === ""))
		? "ready"
		: "blocked";
}
/** A manual save releases the original NM flag; automatic ownership stays disarmed. */
export async function automaticProfileConnectionFlags(
	identity: CarrierIntentIdentity,
	automaticMode: boolean,
): Promise<Record<string, string>> {
	const record = await readRecord(profileKey(identity));
	if (!record) return {};
	if (record.kind !== "profile")
		throw new Error("Unexpected preparation authority");
	return {
		"connection.autoconnect": automaticMode
			? "no"
			: record.birth
				? "yes"
				: record.original,
	};
}

async function prepareUnit(
	target: CellularControlTarget,
	deps: CellularPreparationDeps,
): Promise<PreparationOutcome> {
	const quirk = resolveTransportQuirk(target.identity);
	if (quirk?.owner !== "network-manager") return "preserved";
	if (!quirk.qmapReadback) return "ready";
	if (!/^\d{14,16}$/.test(target.equipment)) return "blocked";
	const key = preparationKey("qmap", target.equipment);
	let record = await deps.read(key);
	if (record && record.kind !== "qmap")
		throw new Error("Unexpected preparation authority");
	if (record?.phase === "blocked") return "blocked";
	if (record?.phase === "verified" && record.epoch === epoch(target))
		return "ready";
	if (record?.phase === "awaiting-usb" && record.epoch === epoch(target)) {
		if (deps.now() >= record.started && deps.now() - record.started < 75_000)
			return "waiting-usb";
		await deps.write({ ...record, phase: "blocked" });
		return "blocked";
	}
	const control = await deps.acquire(target);
	try {
		const value = await control.readAutoConnect();
		if (value === undefined) return "blocked";
		if (!record) {
			record = {
				version: 1,
				kind: "qmap",
				key,
				original: value,
				phase: "baseline",
				epoch: epoch(target),
				started: deps.now(),
			};
			await deps.write(record);
		}
		if (value === 0) {
			await deps.write({ ...record, phase: "verified", epoch: epoch(target) });
			return "pending";
		}
		if (record.phase === "awaiting-usb") {
			await deps.write({ ...record, phase: "blocked" });
			return "blocked";
		}
		await deps.write({
			...record,
			phase: "awaiting-usb",
			epoch: epoch(target),
			started: deps.now(),
		});
		if (!(await control.disableAutoConnect())) {
			await deps.write({ ...record, phase: "blocked" });
			return "blocked";
		}
		try {
			await control.reset();
		} catch {
			if (await deps.present(target))
				throw new Error("Transport reset did not retire its generation");
		}
		return "waiting-usb";
	} finally {
		await control.close();
	}
}
async function prepareEps(
	target: CellularControlTarget,
	policy: CarrierPolicy | undefined,
	deps: CellularPreparationDeps,
): Promise<PreparationOutcome> {
	if (!resolveTransportQuirk(target.identity)?.qmapReadback || !policy)
		return "ready";
	if (!target.initialEps) return "blocked";
	const desired = { apn: policy.apn, family: policy.requestFamily };
	const key = preparationKey("eps", target.equipment, target.simId);
	let record = await deps.read(key);
	if (record && record.kind !== "eps")
		throw new Error("Unexpected preparation authority");
	if (record?.phase === "blocked") return "blocked";
	if (record?.phase === "awaiting-usb" && record.epoch === epoch(target)) {
		if (deps.now() >= record.started && deps.now() - record.started < 75_000)
			return "waiting-usb";
		await deps.write({ ...record, phase: "blocked" });
		return "blocked";
	}
	const decision = decideInitialEps(
		target.initialEps,
		desired,
		record?.attempted ?? false,
		true,
	);
	if (!record) {
		record = {
			version: 1,
			kind: "eps",
			key,
			original: target.initialEps,
			desired,
			attempted: false,
			phase: "baseline",
			epoch: epoch(target),
			started: deps.now(),
		};
		await deps.write(record);
	}
	if (decision === "aligned") {
		if (
			record.phase !== "verified" ||
			record.desired.apn !== desired.apn ||
			record.desired.family !== desired.family
		)
			await deps.write({ ...record, desired, phase: "verified" });
		return "ready";
	}
	if (decision === "blocked") {
		await deps.write({ ...record, phase: "blocked" });
		return "blocked";
	}
	// Consume the pair's only attempt BEFORE the setter, even if it rejects.
	record = {
		...record,
		desired,
		attempted: true,
		phase: "awaiting-usb",
		epoch: epoch(target),
		started: deps.now(),
	};
	await deps.write(record);
	if (!(await deps.setEps(target, desired)) || !(await deps.reset(target))) {
		await deps.write({ ...record, phase: "blocked" });
		return "blocked";
	}
	return "waiting-usb";
}
export async function prepareCellularActivation(
	uuid: string,
	target: CellularControlTarget,
	policy: CarrierPolicy | undefined,
	current: () => Promise<boolean>,
	deps: CellularPreparationDeps = defaultCellularPreparationDeps,
): Promise<PreparationOutcome> {
	const quirk = resolveTransportQuirk(target.identity);
	if (quirk?.owner !== "network-manager" || policy?.qualified === false) {
		ready.delete(uuid);
		return "preserved";
	}
	const cached = ready.get(uuid);
	if (
		cached &&
		cached.policy === (policy?.key ?? "unknown") &&
		cached.target.subscriber === target.subscriber &&
		JSON.stringify(cached.target.identity) ===
			JSON.stringify(target.identity) &&
		cached.target.generation === target.generation &&
		cached.target.ifindex === target.ifindex &&
		cached.target.simId === target.simId &&
		cached.target.deviceId === target.deviceId &&
		(await current()) &&
		(await deps.present(target)) &&
		(await automatic(uuid, target, deps)) &&
		(!quirk.qmapReadback ||
			!policy ||
			decideInitialEps(
				target.initialEps,
				{ apn: policy.apn, family: policy.requestFamily },
				true,
				true,
			) === "aligned") &&
		(!resolveTransportQuirk(target.identity)?.rawIpBeforeCall ||
			(await deps.raw(target)) === "Y")
	)
		return "ready";
	ready.delete(uuid);

	if (
		!(await automatic(uuid, target, deps)) ||
		!(await current()) ||
		!(await deps.present(target))
	)
		return "pending";
	const result = await deps.journal(
		target.key,
		"modem-config",
		{
			format: FORMAT,
			uuid,
			deviceId: target.deviceId,
			simId: target.simId,
			equipmentKey: preparationKey("unit", target.equipment),
			epoch: epoch(target),
		},
		async (mutation) => {
			if (!(await current()) || !(await deps.present(target)))
				return { confirmed: true, value: "pending" as PreparationOutcome };
			await mutation.markExecuting();
			if (!(await current()) || !(await deps.present(target)))
				return { confirmed: true, value: "pending" as PreparationOutcome };
			const taken = await takeProfile(uuid, target, current, deps, policy);
			if (taken !== "ready")
				return { confirmed: taken !== "blocked", value: taken };
			let outcome = await prepareUnit(target, deps);
			// Inhibition deliberately removes the MM object. Release and let its fresh
			// subscription/transport projection reappear before any initial-EPS request.
			if (outcome !== "ready")
				return { confirmed: outcome !== "blocked", value: outcome };
			if (!(await current()) || !(await deps.present(target)))
				return { confirmed: true, value: "pending" as PreparationOutcome };
			outcome = await prepareEps(target, policy, deps);
			if (outcome !== "ready")
				return { confirmed: outcome !== "blocked", value: outcome };
			if (quirk.rawIpBeforeCall) {
				const raw = await deps.raw(target);
				if (raw === undefined)
					return { confirmed: false, value: "blocked" as PreparationOutcome };
				const rawKey = preparationKey(
					"raw",
					target.equipment,
					target.generation,
				);
				const rawRecord = await deps.read(rawKey);
				if (rawRecord && rawRecord.kind !== "raw")
					throw new Error("Unexpected raw-IP authority");
				const baseline = rawRecord ?? {
					version: 1 as const,
					kind: "raw" as const,
					key: rawKey,
					original: raw,
					epoch: epoch(target),
					phase: "baseline" as const,
				};
				if (!rawRecord) await deps.write(baseline);
				if (raw !== "Y" && !(await deps.writeRaw(target, "Y")))
					return { confirmed: false, value: "blocked" as PreparationOutcome };
				if (baseline.phase !== "verified")
					await deps.write({ ...baseline, phase: "verified" });
			}
			if (!(await current()) || !(await deps.present(target)))
				return { confirmed: true, value: "pending" as PreparationOutcome };
			return { confirmed: true, value: "ready" as PreparationOutcome };
		},
	);
	if (!result.ok) return "pending";
	if (result.value === "ready")
		ready.set(uuid, {
			target,
			identity: { uuid, deviceId: target.deviceId, simId: target.simId },
			policy: policy?.key ?? "unknown",
		});
	return result.value;
}
export async function automaticActivationReady(uuid: string): Promise<boolean> {
	const grant = ready.get(uuid);
	if (!grant || !(await cellularTargetPresent(grant.target))) return false;
	const fresh = await readCellularControlTarget(
		grant.target.id,
		grant.target.key,
	);
	if (
		!fresh ||
		fresh.generation !== grant.target.generation ||
		fresh.ifindex !== grant.target.ifindex ||
		fresh.simId !== grant.target.simId ||
		fresh.deviceId !== grant.target.deviceId ||
		fresh.subscriber !== grant.target.subscriber
	)
		return false;
	if (
		resolveTransportQuirk(fresh.identity)?.rawIpBeforeCall &&
		(await readCellularRawIp(fresh)) !== "Y"
	)
		return false;
	const selection = subscriptionForTarget(fresh);
	if (
		selection.state === "not-qualified" ||
		(selection.state === "recognized" ? selection.policy.key : "unknown") !==
			grant.policy
	)
		return false;
	if (
		selection.state === "recognized" &&
		resolveTransportQuirk(fresh.identity)?.qmapReadback &&
		decideInitialEps(
			fresh.initialEps,
			{ apn: selection.policy.apn, family: selection.policy.requestFamily },
			true,
			true,
		) !== "aligned"
	)
		return false;
	const config = getModem(grant.target.id)?.config;
	if (
		config?.conn !== uuid ||
		!config.autoconfig ||
		modemStableKeyForId(grant.target.id) !== grant.target.key
	)
		return false;
	const selected = await automatic(
		uuid,
		grant.target,
		defaultCellularPreparationDeps,
	);
	return !!selected && selected.values[4] === "no";
}
function subscriptionForTarget(target: CellularControlTarget) {
	return selectSubscription({
		...(target.sim.simInfo["sim.properties.operator-code"]
			? { homePlmn: target.sim.simInfo["sim.properties.operator-code"] }
			: {}),
		...(target.sim.modemInfo["modem.3gpp.operator-code"]
			? { servingPlmn: target.sim.modemInfo["modem.3gpp.operator-code"] }
			: {}),
		...(target.sim.simInfo["sim.properties.operator-name"]
			? { spn: target.sim.simInfo["sim.properties.operator-name"] }
			: {}),
		...(target.sim.simInfo["sim.properties.gid1"]
			? { gid1: target.sim.simInfo["sim.properties.gid1"] }
			: {}),
	});
}

export async function runCellularPreparation(): Promise<void> {
	for (const id of getModemIds()) {
		const config = getModem(id)?.config,
			key = modemStableKeyForId(id);
		if (!config?.conn || !config.autoconfig || !key) continue;
		try {
			const target = await readCellularControlTarget(id, key);
			if (!target) continue;
			const selection = subscriptionForTarget(target);
			if (selection.state === "not-qualified") continue;
			const policy =
				selection.state === "recognized" ? selection.policy : undefined;
			await prepareCellularActivation(config.conn, target, policy, async () => {
				if (getModem(id)?.config !== config || modemStableKeyForId(id) !== key)
					return false;
				const fresh = await readCellularControlTarget(id, key);
				return (
					fresh?.generation === target.generation &&
					fresh.simId === target.simId &&
					fresh.deviceId === target.deviceId &&
					fresh.subscriber === target.subscriber &&
					JSON.stringify(subscriptionForTarget(fresh)) ===
						JSON.stringify(selection)
				);
			});
		} catch {
			logger.warn("cellular transport preparation deferred", {
				module: "modems",
			});
		}
	}
}
// Interrupted firmware effects remain blocked. Private per-unit/pair records
// retain the original baseline and spent attempt for explicit recovery.
registerModemConfigInverse(FORMAT, { rollback: async () => "failed" });
