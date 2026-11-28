import type { BigIntStats, BigIntStatsFs } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { type EffectOwner, ownedAll } from "../../helpers/effect-owner.ts";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import { cleanAptCache } from "./apt-cache-clean.ts";
import {
	AptPreflightError,
	aptBytes,
	parseAptArchivePath,
	parseAptSpaceProbe,
} from "./apt-space-parser.ts";

// Net installed growth does not bound dpkg's transient unpack/backup peak.
// This reserve is an engineering margin: it reduces ENOSPC risk, not eliminates it.
export const APT_SPACE_RESERVE_BYTES = 268435456;

export type AptSpaceDeps = {
	readonly run: typeof spawnWithTimeout;
	readonly stat: (path: string) => Promise<Pick<BigIntStats, "dev">>;
	readonly statfs: (
		path: string,
	) => Promise<Pick<BigIntStatsFs, "bavail" | "bsize">>;
	/** Whom the preflight is run for, when `run` runs its commands for it. */
	readonly owner?: EffectOwner | undefined;
};

export const defaultAptSpaceDeps: AptSpaceDeps = {
	run: spawnWithTimeout,
	stat: (path) => stat(path, { bigint: true }),
	statfs: (path) => statfs(path, { bigint: true }),
};

export async function preflightAptSpace(
	installArgs: readonly string[],
	deps: AptSpaceDeps = defaultAptSpaceDeps,
): Promise<void> {
	if (!(await cleanAptCache(deps.run, deps.owner)))
		throw new AptPreflightError("pre_clean_failed");
	const config = await deps
		.run(
			["/usr/bin/apt-config", "shell", "ARCHIVES", "Dir::Cache::archives/d"],
			{ timeoutMs: 10_000 },
		)
		.catch((cause: unknown) => {
			throw new AptPreflightError("apt_config_failed", { cause });
		});
	if (config.exitCode !== 0) throw new AptPreflightError("apt_config_failed");
	const archives = parseAptArchivePath(config.stdout);
	const probe = await deps
		.run(
			[
				"/usr/bin/apt-get",
				"--print-uris",
				...installArgs.filter((arg) => arg !== "--no-download"),
			],
			{
				timeoutMs: 120_000,
				env: { ...process.env, LC_ALL: "C" },
			},
		)
		.catch((cause: unknown) => {
			throw new AptPreflightError("probe_failed", { cause });
		});
	if (probe.exitCode !== 0) throw new AptPreflightError("probe_failed");
	const { download_bytes, install_delta_bytes } = parseAptSpaceProbe(
		probe.stdout,
	);
	const [archiveStat, rootStat] = await ownedAll(deps.owner, [
		deps.stat(archives),
		deps.stat("/"),
	]).catch((cause: unknown) => {
		throw new AptPreflightError("stat_failed", { cause });
	});
	const [archiveFs, rootFs] = await ownedAll(deps.owner, [
		deps.statfs(archives),
		deps.statfs("/"),
	]).catch((cause: unknown) => {
		throw new AptPreflightError("statfs_failed", { cause });
	});
	const archiveFree = aptBytes(
		aptBytes(archiveFs.bavail) * aptBytes(archiveFs.bsize),
	);
	const rootFree = aptBytes(aptBytes(rootFs.bavail) * aptBytes(rootFs.bsize));
	const reserve = BigInt(APT_SPACE_RESERVE_BYTES);
	const archiveRequired = aptBytes(download_bytes + reserve);
	const rootRequired = aptBytes(install_delta_bytes + reserve);
	const enough =
		archiveStat.dev === rootStat.dev
			? archiveFree >= aptBytes(download_bytes + install_delta_bytes + reserve)
			: archiveFree >= archiveRequired && rootFree >= rootRequired;
	if (!enough) throw new AptPreflightError("insufficient_space");
}
