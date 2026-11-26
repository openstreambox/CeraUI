import { type EffectOwner, isOwnerEnded } from "../../helpers/effect-owner.ts";
import { logger } from "../../helpers/logger.ts";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";

/**
 * `owner` is whom the archives are cleaned for, when `run` runs the command
 * for it: a cleanup that fails, or is refused, once that owner has ended is
 * not reported.
 */
export async function cleanAptCache(
	run: typeof spawnWithTimeout = spawnWithTimeout,
	owner?: EffectOwner,
): Promise<boolean> {
	try {
		const result = await run(["/usr/bin/apt-get", "clean"], {
			timeoutMs: 30_000,
		});
		if (result.exitCode === 0) return true;
		if (!owner?.ended())
			logger.warn("Software update archive cleanup failed", {
				exitCode: result.exitCode,
			});
	} catch (error) {
		if (!isOwnerEnded(error) && !owner?.ended())
			logger.warn("Software update archive cleanup failed", {
				error: error instanceof Error ? error : String(error),
			});
	}
	return false;
}
