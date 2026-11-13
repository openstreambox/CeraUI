import {
	type ManagedProcess,
	type SupervisedHandle,
	superviseWorker,
} from "../../helpers/spawn-policy";

type Spawn = (
	args: string[],
	options: { stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
) => Pick<ManagedProcess, "exited" | "exitCode" | "signalCode" | "kill">;

/** The supervision label is constant: diagnostics must never contain argv. */
export function createRelayRunner(spawn: Spawn) {
	let handle: SupervisedHandle | undefined;
	return {
		start(_password: string) {
			if (handle) throw new Error("Relay already owned");
			const child = spawn(
				[
					"/usr/local/bin/moblink-relay-service",
					"--password-file",
					"/data/moblink/credential",
					"--database",
					"/data/moblink/relay-ids.json",
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			handle = superviseWorker(["moblink-relay-service"], {
				spawn: () => child,
				startupTimeoutMs: 2000,
				killGraceMs: 2000,
			});
			const current = handle;
			void child.exited.then(
				() => {
					if (handle === current) handle = undefined;
				},
				() => {
					if (handle === current) handle = undefined;
				},
			);
		},
		async stop() {
			const current = handle;
			if (!current) return;
			await current.shutdown();
			if (handle === current) handle = undefined;
		},
	};
}
