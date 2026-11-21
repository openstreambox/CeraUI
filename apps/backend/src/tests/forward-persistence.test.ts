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
import * as files from "node:fs/promises";
import { writeForwardFile } from "../modules/ingest/forward-secret.ts";

test("private publication fsyncs file before rename and directory afterwards", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-atomic-"));
	const events: string[] = [];
	const originalOpen = files.open;
	const originalRename = files.rename;
	const opening = spyOn(files, "open").mockImplementation(
		async (...args: Parameters<typeof files.open>) => {
			const handle = await originalOpen(...args);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				events.push(String(args[0]) === dir ? "directory-sync" : "file-sync");
				await sync();
			};
			return handle;
		},
	);
	const renaming = spyOn(files, "rename").mockImplementation(
		async (...args: Parameters<typeof files.rename>) => {
			events.push("rename");
			await originalRename(...args);
		},
	);
	try {
		await writeForwardFile(join(dir, "secret"), "durable-test-secret");
		expect(events).toEqual(["file-sync", "rename", "directory-sync"]);
	} finally {
		opening.mockRestore();
		renaming.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed file fsync preserves published credential and cleans temporary bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-atomic-"));
	const path = join(dir, "secret");
	await writeFile(path, "previous-test-secret", { mode: 0o600 });
	const originalOpen = files.open;
	const opening = spyOn(files, "open").mockImplementation(
		async (...args: Parameters<typeof files.open>) => {
			const handle = await originalOpen(...args);
			handle.sync = async () => {
				throw Error("injected-sync-fault");
			};
			return handle;
		},
	);
	try {
		await expect(writeForwardFile(path, "replacement-secret")).rejects.toThrow(
			"injected-sync-fault",
		);
		expect(await readFile(path, "utf8")).toBe("previous-test-secret");
		expect(await files.readdir(dir)).toEqual(["secret"]);
	} finally {
		opening.mockRestore();
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
