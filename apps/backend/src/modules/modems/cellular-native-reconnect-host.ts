import { createHash } from "node:crypto";
import {
	nmConnect,
	nmConnGetFields,
	nmDisconnect,
} from "../network/network-manager.ts";
import {
	effectiveCarrierAutomatic,
	readCarrierIntent,
} from "./automatic-carrier-intent.ts";
import {
	type CellularNativeReconnectBaseline,
	type CellularNativeReconnectDeps,
	parseCellularNativeReconnectBaseline,
	reconnectCellularNative,
	restoreCellularNativeReconnect,
} from "./cellular-native-reconnect.ts";
import { readCellularNmActivation } from "./cellular-nm-activation.ts";
import { automaticActivationReady } from "./cellular-preparation.ts";
import { isModemPairAtStableKey } from "./modem-registration.ts";
import {
	type CellularNetworkTarget,
	cellularTargetPresent,
	findCellularNetworkTarget,
} from "./modems.ts";
import { withJournaledModemMutation } from "./mutation-lease.ts";
import { registerModemConfigInverse } from "./mutation-rollback.ts";
import { selectAutomaticSubscription } from "./subscription-policy.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

const fields = [
		"gsm.device-id",
		"gsm.sim-id",
		"gsm.auto-config",
		"gsm.apn",
		"gsm.home-only",
		"gsm.network-id",
		"gsm.username",
		"gsm.password",
		"ipv4.method",
		"ipv6.method",
		"connection.autoconnect",
	] as const,
	digest = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function baselineFor(
	target: CellularNetworkTarget,
	uuid: string,
): Promise<CellularNativeReconnectBaseline | undefined> {
	const quirk = resolveTransportQuirk(target.identity),
		home = target.sim.simInfo["sim.properties.operator-code"]?.trim();
	if (quirk?.owner !== "network-manager" || !home || !/^\d{5,6}$/.test(home))
		return undefined;
	const spn = target.sim.simInfo["sim.properties.operator-name"],
		gid1 = target.sim.simInfo["sim.properties.gid1"],
		selection = selectAutomaticSubscription({
			homePlmn: home,
			...(spn ? { spn } : {}),
			...(gid1 ? { gid1 } : {}),
		});
	if (selection.state === "not-qualified") return undefined;
	const before = await nmConnGetFields(uuid, fields),
		intent = await readCarrierIntent({
			uuid,
			deviceId: target.deviceId,
			simId: target.simId,
		}),
		after = await nmConnGetFields(uuid, fields);
	if (
		!before ||
		!after ||
		before.length !== fields.length ||
		after.length !== fields.length ||
		after.some((value) => typeof value !== "string" || value.length > 1024) ||
		JSON.stringify(before) !== JSON.stringify(after) ||
		after[0] !== target.deviceId ||
		after[1] !== target.simId ||
		!effectiveCarrierAutomatic(intent, after[2] === "yes", after[3])
	)
		return undefined;
	return parseCellularNativeReconnectBaseline({
		format: "cellular-native-reconnect-v1",
		uuid,
		deviceId: target.deviceId,
		simId: target.simId,
		subscriber: target.subscriber,
		equipment: target.equipment,
		model: target.identity.model,
		firmware: target.identity.firmware,
		mode: target.identity.mode,
		homeDigest: digest([home, spn, gid1]),
		profileDigest: digest(after),
	});
}
const defaults: CellularNativeReconnectDeps = {
	now: () => performance.now(),
	journal: withJournaledModemMutation,
	disconnect: nmDisconnect,
	connect: (uuid) => nmConnect(uuid, 45),
	read: async (key, expected) => {
		const target = await findCellularNetworkTarget(key, expected);
		if (!target) return undefined;
		const baseline = await baselineFor(target, expected.uuid);
		if (!baseline) return undefined;
		const current = async () =>
				(await cellularTargetPresent(target)) &&
				(await isModemPairAtStableKey(key, target)),
			activation = await readCellularNmActivation(
				target,
				expected.uuid,
				current,
			);
		if (!activation) return undefined;
		const quirk = resolveTransportQuirk(target.identity),
			registered = ["registered", "connected"].includes(
				target.sim.modemInfo["modem.generic.state"],
			),
			prepared =
				registered &&
				!!quirk &&
				((!quirk.qmapReadback && !quirk.rawIpBeforeCall) ||
					(await automaticActivationReady(expected.uuid)));
		return (await current())
			? {
					baseline,
					physicalGeneration: digest([
						target.generation,
						target.ifindex,
						target.netDevice,
					]),
					state: activation.state,
					prepared,
				}
			: undefined;
	},
};
/** Baseline is captured afresh when recovery becomes due, never from a stored
 * modem allocation. The pure transaction repeats it under the shared journal.
 */
export async function reconnectCellularNativeHost(
	target: CellularNetworkTarget,
	uuid: string,
	withdrawn: () => boolean,
): Promise<boolean> {
	if (!withdrawn() || !(await cellularTargetPresent(target))) return false;
	const baseline = await baselineFor(target, uuid);
	const physicalGeneration = digest([
		target.generation,
		target.ifindex,
		target.netDevice,
	]);
	return (
		!!baseline &&
		withdrawn() &&
		(await reconnectCellularNative(target.key, baseline, withdrawn, {
			...defaults,
			read: async (key, expected) => {
				const fresh = await defaults.read(key, expected);
				return fresh?.physicalGeneration === physicalGeneration
					? fresh
					: undefined;
			},
		}))
	);
}
registerModemConfigInverse("cellular-native-reconnect-v1", {
	rollback: (key, state) =>
		restoreCellularNativeReconnect(key, state, defaults),
});
