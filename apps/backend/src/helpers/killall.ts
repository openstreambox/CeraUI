import { setup } from "../modules/setup.ts";
import { ALLOWED, run } from "./run.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "./spawn-policy.ts";

const killallBinary = setup.killall_binary ?? "killall";

/** Cleanup callers ignore a missing process; reload callers need the outcome. */
export default async function killall(
	args: Readonly<Array<string>>,
): Promise<void> {
	await killallSucceeded(args);
}

export async function killallSucceeded(
	args: Readonly<Array<string>>,
): Promise<boolean> {
	try {
		if (ALLOWED.has(killallBinary)) {
			await run(killallBinary, [...args]);
			return true;
		}
		// Custom paths retain the existing bounded argv-only invocation.
		// bounded-probe (spawn-policy): a hung killall is capped by a wall-clock timeout.
		const result = Bun.spawnSync([killallBinary, ...args], {
			timeout: DEFAULT_SPAWN_TIMEOUT_MS,
		});
		return result.exitCode === 0 && !result.signalCode;
	} catch {
		return false;
	}
}
