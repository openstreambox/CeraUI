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
	readonly reload: (sender: StreamingProcess) => void;
	readonly now: () => number;
	readonly acknowledged: (
		sender: StreamingProcess,
		after: number,
		scope: CellularWithdrawalScope,
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
	reload: (sender) => sender.proc.kill("SIGHUP"),
	now: Date.now,
	acknowledged: (sender, after, scope) =>
		senderReleasedCellularSource(sender, after, scope.linkId, scope.devices),
	absent: async () => false,
};
/** A receipt is deliberately process-local. Recovery obtains fresh evidence;
 * it cannot replay a saved timestamp or treat missing telemetry as closed FDs.
 * This helper never Stops a stream or owns a second process/recovery loop.
 */
export async function createCellularWithdrawalReceipt(
	raw: CellularWithdrawalScope,
	deps: CellularWithdrawalDeps = defaults,
): Promise<{ readonly confirmed: () => boolean } | undefined> {
	const retainedOwned = raw.owned,
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
	await deps.drain();
	if (!scope.owned() || !deps.excludes(scope)) return undefined;
	if (!producer) {
		if (
			deps.senders().length ||
			!(await deps.absent()) ||
			!scope.owned() ||
			deps.senders().length ||
			!deps.excludes(scope)
		)
			return undefined;
		return {
			confirmed: () =>
				scope.owned() && !deps.senders().length && deps.excludes(scope),
		};
	}
	if (exited) return { confirmed: () => scope.owned() && exited };
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
		confirmed: () =>
			scope.owned() &&
			(exited ||
				(!!epoch &&
					producer.senderBinding?.required === true &&
					producer.senderBinding.epoch === epoch &&
					deps.senders().length === 1 &&
					deps.senders()[0] === producer &&
					deps.acknowledged(producer, after, scope))),
	};
}
