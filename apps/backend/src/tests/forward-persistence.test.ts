import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadForwardConfig } from "../modules/ingest/forward-config.ts";
import { loadForwardSecret } from "../modules/ingest/forward-secret.ts";

test("migration persists forwarding settings and legacy generated credential across OTA", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-config-"));
	try {
		const legacySecret = join(dir, "legacy.secret");
		await writeFile(legacySecret, "legacy-generated-secret", { mode: 0o600 });
		const legacy = { host: "127.0.0.1", port: 4000, maxbw: 500000 };
		const first = await loadForwardConfig(dir, legacy, legacySecret);
		expect(first?.passphrase).toBe("legacy-generated-secret");
		const next = await loadForwardConfig(dir, undefined, legacySecret);
		expect(next).toEqual(first);
		expect((await stat(join(dir, "srt-forward.json"))).mode & 0o777).toBe(
			0o600,
		);
		expect(await readFile(join(dir, "srt-forward.json"), "utf8")).not.toContain(
			"legacy-generated-secret",
		);
		// Operator settings take precedence over stale image metadata.
		await writeFile(
			join(dir, "srt-forward.json"),
			JSON.stringify({ host: "127.0.0.2", passphrase: "operator-secret" }),
			{ mode: 0o600 },
		);
		expect((await loadForwardConfig(dir, legacy, legacySecret))?.host).toBe(
			"127.0.0.2",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test.each(["", "bad", "x".repeat(100), "\u0000broken-secret"])(
	"recovers damaged generated credential %j",
	async (content) => {
		const dir = await mkdtemp(join(tmpdir(), "forward-secret-"));
		try {
			const path = join(dir, "secret");
			await writeFile(path, content, { mode: 0o600 });
			expect(await loadForwardSecret(path, "regenerated-test-secret")).toBe(
				"regenerated-test-secret",
			);
			expect(await loadForwardSecret(path, "unused-test-secret")).toBe(
				"regenerated-test-secret",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("damaged operator settings never fall back to stale image settings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-config-"));
	try {
		await writeFile(join(dir, "srt-forward.json"), "{broken", { mode: 0o600 });
		await expect(
			loadForwardConfig(dir, { host: "127.0.0.1" }, join(dir, "legacy")),
		).rejects.toThrow();
		expect(await readFile(join(dir, "srt-forward.json"), "utf8")).toBe(
			"{broken",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

import { spyOn } from "bun:test";
import fs from "node:fs";
import * as files from "node:fs/promises";
import { writeForwardFile } from "../modules/ingest/forward-secret.ts";

test("private publication fsyncs file before rename and directory afterwards", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-atomic-"));
	const events: string[] = [];
	const sync = fs.fsyncSync;
	const rename = fs.renameSync;
	const syncing = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		events.push(
			fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync",
		);
		sync(fd);
	});
	const renaming = spyOn(fs, "renameSync").mockImplementation((from, to) => {
		events.push("rename");
		rename(from, to);
	});
	try {
		await writeForwardFile(join(dir, "secret"), "durable-test-secret");
		expect(events).toEqual(["file-sync", "rename", "directory-sync"]);
	} finally {
		syncing.mockRestore();
		renaming.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed file fsync preserves published credential and cleans temporary bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-atomic-"));
	const path = join(dir, "secret");
	await writeFile(path, "previous-test-secret", { mode: 0o600 });
	const syncing = spyOn(fs, "fsyncSync").mockImplementation(() => {
		throw Error("injected-sync-fault");
	});
	try {
		await expect(writeForwardFile(path, "replacement-secret")).rejects.toThrow(
			"injected-sync-fault",
		);
		expect(await readFile(path, "utf8")).toBe("previous-test-secret");
		expect(await files.readdir(dir)).toEqual(["secret"]);
	} finally {
		syncing.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("first migration without a legacy secret retains its generated credential", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-config-"));
	try {
		const first = await loadForwardConfig(
			dir,
			{ host: "127.0.0.1" },
			join(dir, "absent"),
		);
		expect(first?.passphrase).toMatch(/^[a-f0-9]{32}$/);
		expect(
			await loadForwardConfig(dir, undefined, join(dir, "absent")),
		).toEqual(first);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("migration recovers settings saved before package unpack replaced setup.json", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-config-"));
	try {
		await writeFile(
			join(dir, "srt-forward-legacy-setup.json"),
			JSON.stringify({
				hw: "rk3588",
				srt_forward: {
					host: "127.0.0.1",
					passphrase: "preserved-operator-secret",
				},
			}),
			{ mode: 0o600 },
		);
		expect(
			(await loadForwardConfig(dir, undefined, join(dir, "absent")))
				?.passphrase,
		).toBe("preserved-operator-secret");
		expect(await files.readdir(dir)).toEqual(["srt-forward.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

for (const persistent of [false, true]) {
	test(`removes stale snapshot when ${persistent ? "persistent" : "current legacy"} settings win`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "forward-stale-"));
		try {
			const config = { host: "127.0.0.1", passphrase: "operator-test-secret" };
			const snapshot = join(dir, "srt-forward-legacy-setup.json");
			await writeFile(snapshot, "{broken stale snapshot", { mode: 0o600 });
			if (persistent)
				await writeFile(join(dir, "srt-forward.json"), JSON.stringify(config), {
					mode: 0o600,
				});
			expect(
				(
					await loadForwardConfig(
						dir,
						persistent ? undefined : config,
						join(dir, "absent"),
					)
				)?.host,
			).toBe(config.host);
			expect(await Bun.file(snapshot).exists()).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
test("creates settings and generated secret as 0600 under umask 0022", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-mode-"));
	const mask = process.umask(0o022);
	try {
		await loadForwardConfig(dir, { host: "127.0.0.1" }, join(dir, "absent"));
		for (const name of ["srt-forward.json", "srt-forward.secret"])
			expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
	} finally {
		process.umask(mask);
		await rm(dir, { recursive: true, force: true });
	}
});

import { logger } from "../helpers/logger.ts";

test("warns once after recovering a damaged credential without logging bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-warning-"));
	const warning = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		const path = join(dir, "secret");
		await writeFile(path, "bad", { mode: 0o600 });
		await loadForwardSecret(path, "replacement-test-secret");
		await loadForwardSecret(path, "unused-test-secret");
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith(
			"SRT forwarding credential regenerated",
		);
	} finally {
		warning.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("persistent settings discard stale backup even when their JSON is damaged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-invalid-"));
	try {
		const snapshot = join(dir, "srt-forward-legacy-setup.json");
		await writeFile(snapshot, "private obsolete bytes", { mode: 0o600 });
		await writeFile(join(dir, "srt-forward.json"), "{broken", { mode: 0o600 });
		await expect(
			loadForwardConfig(dir, undefined, join(dir, "absent")),
		).rejects.toThrow();
		expect(await Bun.file(snapshot).exists()).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
