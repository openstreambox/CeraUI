import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldMockModems } from "../../mocks/providers/modems.ts";
import {
	setCellularSourceAdmission,
	withdrawCellularSource,
} from "../network/cellular-source-state.ts";
import { nmConnGetFields } from "../network/network-manager.ts";
import { getModemNetMarker } from "../network/router-cellular-scan.ts";
import { resolveBondPhysicalIdentity } from "../streaming/bond-entry.ts";
import {
	cellularSenderAllowsPublication,
	cellularSenderRuntime,
} from "../streaming/cellular-sender-runtime.ts";
import { getMutationBlocks } from "../streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import {
	probeSrtlaSenderCapabilities,
	supportsRequiredCellularBinding,
} from "../streaming/srtla-capabilities.ts";
import { srtlaSendExec } from "../streaming/streamloop/exec-paths.ts";
import { getStreamingProcesses } from "../streaming/streamloop/process-runner.ts";
import {
	effectiveCarrierAutomatic,
	readCarrierIntent,
} from "./automatic-carrier-intent.ts";
import { captureCellularDataGrant } from "./cellular-grant.ts";
import { CellularGrantLifetime } from "./cellular-grant-lifetime.ts";
import { cellularHostStore } from "./cellular-host-recovery.ts";
import { reconnectCellularNativeHost } from "./cellular-native-reconnect-host.ts";
import { readCellularNmIp } from "./cellular-nm-ip.ts";
import { automaticActivationReady } from "./cellular-preparation.ts";
import { privateCellularProbeBudget } from "./cellular-probe-budget.ts";
import {
	CellularRuntime,
	type CellularRuntimeObservation,
} from "./cellular-runtime.ts";
import { CellularRuntimeConsumers } from "./cellular-runtime-consumers.ts";
import { createCellularRuntimeKernelSession } from "./cellular-runtime-kernel.ts";
import {
	cellularTargetPresent,
	readCellularNativeBearer,
	readCellularNetworkTarget,
} from "./modems.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { selectAutomaticSubscription } from "./subscription-policy.ts";
import { resolveTransportQuirk } from "./transport-policy.ts";

const MM = "org.freedesktop.ModemManager1",
	NM = "org.freedesktop.NetworkManager";
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const kernelAddresses = async (iface: string): Promise<unknown> =>
	JSON.parse(
		await run("ip", ["-j", "addr", "show", "dev", iface], {
			timeout: 4000,
			maxBuffer: 256 * 1024,
		}),
	);
let runtime: CellularRuntime | undefined;
let bootId: string | undefined;
let capturing = false;
function failure(error: unknown): void {
	logger.warn("cellular runtime reconciliation deferred", {
		module: "modems",
		error,
	});
}
function root(): CellularRuntime {
	if (runtime) return runtime;
	const store = cellularHostStore();
	runtime = new CellularRuntime({
		now: () => performance.now(),
		capable: async () => {
			if (
				isRecoveryPending() ||
				!cellularSenderAllowsPublication(
					cellularSenderRuntime(getStreamingProcesses(), srtlaSendExec),
				)
			)
				return false;
			const capabilities = await probeSrtlaSenderCapabilities(srtlaSendExec);
			return (
				supportsRequiredCellularBinding(capabilities) && !isRecoveryPending()
			);
		},
		// Ten MiB covers a full day at the healthy five-minute cadence, with
		// finite discovery/failure allowance. Reservations survive USB/process loss.
		reserve: (owner, bytes) =>
			privateCellularProbeBudget(
				owner,
				{
					dir:
						process.env.CERALIVE_CELLULAR_BUDGET_STATE_DIR ??
						"/data/ceralive/cellular-probe-budget",
				},
				10 * 1024 * 1024,
			).reserve(bytes),
		failure,
		retain: (
			observation,
			grant,
			slot,
			sourceEpoch,
			hostEpoch,
			owned,
			currentNow,
		) => {
			if (!bootId)
				throw new Error("Cellular runtime boot identity unavailable");
			const withdraw = () =>
					withdrawCellularSource(
						observation.owner,
						sourceEpoch,
						observation.iface,
					),
				consumers = new CellularRuntimeConsumers({
					owner: observation.owner,
					epoch: sourceEpoch,
					iface: observation.iface,
					linkId: observation.linkId,
					devices:
						grant.family === "ipv4"
							? [observation.iface]
							: [observation.iface, `cclat${slot}`],
					owned,
				});
			return {
				session: createCellularRuntimeKernelSession(
					grant,
					slot,
					observation.owner,
					hostEpoch,
					{
						store,
						bootId,
						owned,
						currentNow: () => currentNow() && !isRecoveryPending(),
						current: observation.current,
						withdraw,
						consumersReleased: () => consumers.confirmed(),
						reserve: async (bytes) =>
							!!(await privateCellularProbeBudget(
								observation.owner,
								{
									dir:
										process.env.CERALIVE_CELLULAR_BUDGET_STATE_DIR ??
										"/data/ceralive/cellular-probe-budget",
								},
								10 * 1024 * 1024,
							).reserve(bytes)),
					},
				),
				finish: (complete) => consumers.finish(complete),
			};
		},
	});
	return runtime;
}
async function capture(
	id: number,
): Promise<CellularRuntimeObservation | undefined> {
	const config = getModem(id)?.config,
		key = modemStableKeyForId(id);
	if (!config?.conn || !config.autoconfig || !key) return undefined;
	const uuid = config.conn;
	let active = false,
		iface: string | undefined;
	const lifetime = new CellularGrantLifetime(() => {
		if (active && iface) runtime?.invalidate(iface);
	});
	try {
		await lifetime.start();
		const target = await readCellularNetworkTarget(id, key);
		if (!target) {
			await lifetime.close();
			return undefined;
		}
		if (getMutationBlocks().some((block) => block.stableKey === key)) {
			await lifetime.close();
			return undefined;
		}
		iface = target.ifname;
		const owner = digest([
				target.deviceId,
				target.simId,
				target.subscriber,
				target.equipment,
			]),
			identity = resolveBondPhysicalIdentity(iface);
		if (!identity || identity.anchor === "ifname") {
			await lifetime.close();
			return undefined;
		}
		const currentNow = () =>
				lifetime.current &&
				modemStableKeyForId(id) === key &&
				getModem(id)?.config === config &&
				config.conn === uuid &&
				!getModem(id)?.inhibit &&
				!getModem(id)?.is_scanning,
			currentPhysical = async () =>
				currentNow() && (await cellularTargetPresent(target)) && currentNow(),
			pair = {
				uuid,
				deviceId: target.deviceId,
				simId: target.simId,
			},
			fields = await nmConnGetFields(uuid, [
				"gsm.device-id",
				"gsm.sim-id",
				"gsm.auto-config",
				"gsm.apn",
			]),
			intent = await readCarrierIntent(pair),
			home = target.sim.simInfo["sim.properties.operator-code"]?.trim(),
			selection = selectAutomaticSubscription({
				...(home ? { homePlmn: home } : {}),
				...(target.sim.simInfo["sim.properties.operator-name"]
					? { spn: target.sim.simInfo["sim.properties.operator-name"] }
					: {}),
				...(target.sim.simInfo["sim.properties.gid1"]
					? { gid1: target.sim.simInfo["sim.properties.gid1"] }
					: {}),
			}),
			quirk = resolveTransportQuirk(target.identity);
		const eligible =
			fields?.length === 4 &&
			fields[0] === target.deviceId &&
			fields[1] === target.simId &&
			typeof fields[3] === "string" &&
			effectiveCarrierAutomatic(intent, fields[2] === "yes", fields[3]) &&
			!!home &&
			/^\d{5,6}$/.test(home) &&
			selection.state !== "not-qualified" &&
			quirk?.owner !== "internal-call" &&
			(!quirk || (await automaticActivationReady(uuid)));
		const bearer = eligible
				? await readCellularNativeBearer(target)
				: undefined,
			nm = bearer
				? await readCellularNmIp(target, uuid, currentPhysical)
				: undefined,
			addresses = nm ? await kernelAddresses(iface) : undefined,
			grant =
				bearer && nm && nm.service === lifetime.owner(NM) && currentNow()
					? captureCellularDataGrant(target, bearer, nm, addresses)
					: undefined,
			paths = [
				`/org/freedesktop/ModemManager1/Modem/${id}`,
				target.sim.modemInfo["modem.generic.sim"],
				...(bearer ? [bearer.path] : []),
				...(nm
					? [nm.device, nm.active, nm.ipv4Path, nm.ipv6Path].filter(
							(path) => path !== "/",
						)
					: []),
			];
		// No grant still keeps this identified automatic interface fenced unready.
		// It cannot donate an unverified native address to the ordinary collector.
		const watching = paths.length >= 4 && lifetime.select(paths);
		active = true;
		const observation: CellularRuntimeObservation = {
			owner,
			iface,
			linkId: identity.linkId,
			physicalGeneration: digest([target.generation, target.ifindex]),
			stamp: digest([
				grant?.generation,
				lifetime.owner(MM),
				lifetime.owner(NM),
				paths,
			]),
			...(grant && watching ? { grant } : {}),
			currentNow: () => watching && currentNow(),
			current: async () => {
				if (!grant || !bearer || !nm || !watching || !(await currentPhysical()))
					return false;
				const latest = captureCellularDataGrant(
					target,
					bearer,
					nm,
					await kernelAddresses(target.ifname),
				);
				return (
					latest?.generation === grant.generation && (await currentPhysical())
				);
			},
			close: async () => {
				active = false;
				await lifetime.close();
			},
			reconnect: (withdrawn) =>
				reconnectCellularNativeHost(target, uuid, withdrawn),
		};
		return observation;
	} catch (error) {
		active = false;
		await lifetime.close();
		throw error;
	}
}
/** Called by the existing retained modem poll, after transport preparation and
 * ready activation, outside its update lock. No separate timer or process owner.
 */
export async function runCellularRuntime(): Promise<void> {
	if (shouldMockModems() || capturing) return;
	capturing = true;
	try {
		if (isRecoveryPending()) {
			runtime?.invalidate();
			return;
		}
		bootId ??= (
			await readFile("/proc/sys/kernel/random/boot_id", "ascii")
		).trim();
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
			throw new Error("Cellular runtime boot identity unavailable");
		const observations: CellularRuntimeObservation[] = [];
		for (const id of getModemIds()) {
			try {
				const observation = await capture(id);
				if (observation) observations.push(observation);
			} catch (error) {
				runtime?.invalidate(getModem(id)?.ifname);
				failure(error);
			}
		}
		if (observations.length || runtime) await root().reconcile(observations);
	} catch (error) {
		runtime?.invalidate();
		failure(error);
	} finally {
		capturing = false;
	}
}
export function invalidateCellularRuntime(iface?: string): void {
	runtime?.invalidate(iface);
}

/** Synchronous boot admission only; no hardware commands, storage or probes. */
export function initCellularRuntimeAdmission(): void {
	setCellularSourceAdmission((iface) => {
		if (shouldMockModems()) return false;
		const rows = getModemIds()
			.map(getModem)
			.filter((row) => row?.ifname === iface);
		if (rows.length === 1 && rows[0]?.config?.autoconfig === false)
			return false;
		return rows.length > 0 || getModemNetMarker(iface) !== undefined;
	});
}
