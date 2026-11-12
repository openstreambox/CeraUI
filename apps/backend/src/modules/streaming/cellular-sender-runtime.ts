import type { StreamingProcess } from "./streamloop/process-runner.ts";

/** Provenance attached by the existing subprocess owner to its actual argv.
 * This does not own stream admission, cleanup, retries or process restart.
 */
export interface CellularSenderBinding {
	readonly epoch: symbol;
	readonly startedAt: number;
	readonly required: boolean;
}
export type CellularSenderRuntime =
	| { readonly kind: "none" }
	| { readonly kind: "unknown" }
	| {
			readonly kind: "owned";
			readonly sender: StreamingProcess;
			readonly binding: CellularSenderBinding;
	  };
export function cellularSenderRuntime(
	processes: readonly StreamingProcess[],
	executable: string,
): CellularSenderRuntime {
	const senders = processes.filter((row) => row.spawnfile === executable);
	if (!senders.length) return { kind: "none" };
	const sender = senders[0];
	if (
		senders.length !== 1 ||
		!sender?.senderBinding ||
		sender.proc.exitCode !== null ||
		sender.proc.signalCode !== null
	)
		return { kind: "unknown" };
	return { kind: "owned", sender, binding: sender.senderBinding };
}
export function cellularSenderAllowsPublication(
	runtime: CellularSenderRuntime,
): boolean {
	return (
		runtime.kind === "none" ||
		(runtime.kind === "owned" && runtime.binding.required)
	);
}
