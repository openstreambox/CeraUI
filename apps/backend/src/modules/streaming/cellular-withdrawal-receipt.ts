import type { BindMapIdentity } from "@ceraui/srtla-send/telemetry";
import { captureCellularSourceWithdrawal } from "../network/cellular-source-state.ts";
import { isSafeIfname } from "../network/safe-ifname.ts";
import type { BindMapPublication } from "./bind-map-writer.ts";
import { senderReleasedCellularSource } from "./link-telemetry.ts";
import {
	drainSrtlaBondPublication,
	getLastPublishedBond,
	restrictSrtlaBond,
} from "./srtla.ts";
import { srtlaSendExec } from "./streamloop/exec-paths.ts";
import {
	getStreamingProcesses,
	type StreamingProcess,
} from "./streamloop/process-runner.ts";

export interface CellularWithdrawalScope {
	readonly owner: string;
	readonly epoch: string;
	readonly iface: string;
	readonly linkId: string;
	readonly devices: readonly string[];
	/** The retained source/slot owner, including after observation revocation. */
	readonly owned: () => boolean;
}
export interface CellularWithdrawalDeps {
	readonly senders: () => readonly StreamingProcess[];
	readonly restrict: (
		scope: CellularWithdrawalScope,
	) => Promise<BindMapPublication>;
	readonly drain: () => Promise<void>;
	readonly excludes: (scope: CellularWithdrawalScope) => boolean;
	readonly latest: () => BindMapPublication | undefined;
	readonly reload: (sender: StreamingProcess) => void;
	readonly now: () => number;
	readonly acknowledged: (
		sender: StreamingProcess,
		after: number,
		scope: CellularWithdrawalScope,
		identity: BindMapIdentity,
	) => boolean;
	/** Positive startup consumer census, not an inactive telemetry/stream flag. */
	readonly absent: () => Promise<boolean>;
}
const defaults: CellularWithdrawalDeps = {
	senders: () =>
		getStreamingProcesses().filter((row) => row.spawnfile === srtlaSendExec),
	restrict: (scope) =>
		restrictSrtlaBond(scope.linkId, scope.devices, scope.owned),
	drain: drainSrtlaBondPublication,
	excludes: (scope) => {
		const bond = getLastPublishedBond();
		return (
			!!bond?.publication.ok &&
			bond.entries.every(
				(row) =>
					row.linkId !== scope.linkId && !scope.devices.includes(row.iface),
			)
		);
	},
	latest: () => getLastPublishedBond()?.publication,
	reload: (sender) => sender.proc.kill("SIGHUP"),
	now: () => performance.now(),
	acknowledged: (sender, after, scope, identity) =>
		senderReleasedCellularSource(
			sender,
			after,
			scope.linkId,
			scope.devices,
			identity,
		),
	absent: async () => false,
};
/** A receipt is deliberately process-local. Recovery obtains fresh evidence;
 * it cannot replay a saved timestamp or treat missing telemetry as closed FDs.
 * This helper never Stops a stream or owns a second process/recovery loop.
 */
export interface CellularWithdrawalReceipt {
	/** False means new publication or producer evidence must be captured. */
	readonly current: () => boolean;
	readonly confirmed: () => boolean;
}
export async function createCellularWithdrawalReceipt(
	raw: CellularWithdrawalScope,
	overrides: Partial<CellularWithdrawalDeps> = {},
): Promise<CellularWithdrawalReceipt | undefined> {
	const deps: CellularWithdrawalDeps = { ...defaults, ...overrides },
		retainedOwned = raw.owned,
		withdrawn = captureCellularSourceWithdrawal(
			raw.owner,
			raw.epoch,
			raw.iface,
		),
		scope: CellularWithdrawalScope = Object.freeze({
			...raw,
			devices: Object.freeze([...raw.devices]),
			owned: () => retainedOwned() && withdrawn(),
		});
	if (
		!/^[a-f0-9]{64}$/.test(scope.owner) ||
		!scope.epoch ||
		scope.epoch.length > 256 ||
		!isSafeIfname(scope.iface) ||
		!scope.devices.includes(scope.iface) ||
		!scope.linkId ||
		scope.linkId.length > 256 ||
		!scope.devices.length ||
		scope.devices.length > 2 ||
		scope.devices.some(
			(name) => !isSafeIfname(name) || ["all", "default", "lo"].includes(name),
		)
	)
		throw new Error("Invalid cellular withdrawal scope");
	if (!scope.owned()) return undefined;
	const before = [...deps.senders()];
	if (before.length > 1) return undefined;
	const producer = before[0];
	let exited = false;
	if (producer)
		void producer.proc.exited.then(
			() => {
				exited = true;
			},
			() => {
				/* A rejected exit observation is not proof of closed sockets. */
			},
		);
	const publication = await deps.restrict(scope);
	if (!scope.owned() || !publication.ok) return undefined;
	const identity: BindMapIdentity = Object.freeze({
		generation: publication.generation,
		ips_file_sha256: publication.ipsFileSha256,
	});
	const currentPublication = () => {
		const latest = deps.latest();
		return (
			scope.owned() &&
			!!latest?.ok &&
			latest.generation === identity.generation &&
			latest.ipsFileSha256 === identity.ips_file_sha256 &&
			deps.excludes(scope)
		);
	};
	await deps.drain();
	if (!currentPublication()) return undefined;
	if (!producer) {
		if (
			deps.senders().length ||
			!(await deps.absent()) ||
			!scope.owned() ||
			deps.senders().length ||
			!currentPublication()
		)
			return undefined;
		const current = () => currentPublication() && !deps.senders().length;
		return { current, confirmed: current };
	}
	const currentProducer = () => {
		const senders = deps.senders();
		return (
			currentPublication() &&
			(exited
				? senders.every((row) => row === producer)
				: senders.length === 1 && senders[0] === producer)
		);
	};
	if (exited) return { current: currentProducer, confirmed: currentProducer };
	const current = deps.senders();
	if (
		current.length !== 1 ||
		current[0] !== producer ||
		producer.proc.exitCode !== null ||
		producer.proc.signalCode !== null ||
		!scope.owned()
	)
		return undefined;
	try {
		deps.reload(producer);
	} catch {
		return undefined;
	}
	const after = deps.now(),
		epoch = producer.senderBinding?.epoch;
	return {
		current: currentProducer,
		confirmed: () =>
			currentProducer() &&
			(exited ||
				(!!epoch &&
					producer.senderBinding?.required === true &&
					producer.senderBinding.epoch === epoch &&
					deps.senders().length === 1 &&
					deps.senders()[0] === producer &&
					deps.acknowledged(producer, after, scope, identity))),
	};
}
