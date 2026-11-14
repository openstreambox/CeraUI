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
export function createRelayRunner(
	spawn: Spawn,
	health: (degraded: boolean) => void = () => undefined,
) {
	let handle: SupervisedHandle | undefined;
	let stopping: SupervisedHandle | undefined;
	return {
		running: () => handle !== undefined,
		start() {
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
			health(false);
			const current = handle;
			void child.exited.then(
				() => {
					if (handle === current) {
						handle = undefined;
						if (stopping !== current) health(true);
					}
				},
				() => {
					if (handle === current) {
						handle = undefined;
						if (stopping !== current) health(true);
					}
				},
			);
		},
		async stop() {
			const current = handle;
			if (!current) return;
			stopping = current;
			try {
				await current.shutdown();
				if (handle === current) handle = undefined;
			} finally {
				stopping = undefined;
			}
		},
	};
}
