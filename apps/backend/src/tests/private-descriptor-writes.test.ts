import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveDamagedRecord } from "../helpers/persistent-record.ts";
import { FileJournal } from "../modules/network/two-radio/journal.ts";
import { writeTwoRadioClaim } from "../modules/network/two-radio/runtime.ts";
import { writeSynced } from "../modules/network/uplink-sharing.ts";
import { aptRoutingFileStore } from "../modules/system/apt-routing-journal.ts";
import { saveCredentialLedger } from "../modules/system/update-orchestrator/credential-ledger-io.ts";
import { writePrivateOsJobFile } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { fileRecoveryStore } from "../modules/system/update-orchestrator/recovery-store.ts";

const writers: [string, (dir: string) => Promise<string> | string][] = [
	[
		"uplink ruleset replacement",
		async (dir) => {
			const file = join(dir, "rules.tmp");
			await writeFile(file, "old");
			await chmod(file, 0o644);
			await writeSynced(file, "new");
			expect(await Bun.file(file).text()).toBe("new");
			return file;
		},
	],
	[
		"radio ownership claim",
		async (dir) => {
			const file = join(dir, "owner.json");
			await writeTwoRadioClaim(file, "{}");
			expect(await Bun.file(file).text()).toBe("{}");
			return file;
		},
	],
	[
		"recovery",
		async (dir) => {
			await fileRecoveryStore(dir).writeState(Buffer.from("{}"));
			return join(dir, "agent.json");
		},
	],
	[
		"job token",
		(dir) => {
			writePrivateOsJobFile("token", "synthetic", dir);
			return join(dir, "token");
		},
	],
	[
		"credential ledger",
		(dir) => {
			const file = join(dir, "ledger.json");
			saveCredentialLedger(file, "{}");
			return file;
		},
	],
	[
		"routing journal",
		(dir) => {
			const file = join(dir, "routing.json");
			aptRoutingFileStore(file).save([]);
			return file;
		},
	],
	[
		"damaged credentials",
		(dir) =>
			preserveDamagedRecord(join(dir, "config.json"), Buffer.from("synthetic")),
	],
	[
		"radio journal",
		async (dir) => {
			const file = join(dir, "radio.json");
			await new FileJournal(file).save({
				version: 1,
				session: "test",
				operations: [],
			});
			return file;
		},
	],
];
for (const mask of [0o022, 0o777]) {
	test.each(writers)(
		`%s enforces 0600 with umask ${mask.toString(8)}`,
		async (_name, write) => {
			const dir = await mkdtemp(join(tmpdir(), "private-descriptors-"));
			const previous = process.umask(mask);
			try {
				const file = await write(dir);
				expect((await stat(file)).mode & 0o777).toBe(0o600);
			} finally {
				process.umask(previous);
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
}
