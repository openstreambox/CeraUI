/// <reference types="bun" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import {
	type EffectOwner,
	type OwnedFileBackend,
	setOwnedFileBackendForTest,
} from "../helpers/effect-owner.ts";
import { logger } from "../helpers/logger.ts";
import {
	PRIVATE_FILE_LEFT_BEHIND,
	resetPrivateCurlFilesForTest,
	runCurlWithPrivateUrl,
	sweepPrivateCurlFiles,
} from "../modules/system/curl-private-url.ts";

const TOKEN = "k7Qm2xV9pL4sT8wZ";
const NOW = 1_800_000_000_000;
const now = () => NOW;
const URL = `https://updates.example.org/${TOKEN}/apt/dists/suite/InRelease`;

/** Private directories as an object, and removals that can be made to fail. */
function privateFiles() {
	const state = {
		directories: new Set<string>(),
		contents: new Map<string, string>(),
		/** Directories whose removal fails (EBUSY). */
		stuck: new Set<string>(),
		/** When each directory was last changed (now, unless told). */
		changed: new Map<string, number>(),
		unlistable: false,
		made: 0,
	};
	const never = async () => {
		throw new Error("not used by a private curl run");
	};
	const backend: OwnedFileBackend = {
		makeDirectory: never,
		inspect: async (directory) => ({
			isDirectory: () => true,
			isSymbolicLink: () => false,
			uid: 0,
			mode: 0o700,
			mtimeMs: state.changed.get(directory) ?? NOW,
		}),
		setMode: never,
		removeFile: never,
		createExclusive: never,
		removeTree: async (directory) => {
			if (state.stuck.has(directory))
				throw Object.assign(
					new Error(`EBUSY: resource busy or locked, rm '${directory}'`),
					{ code: "EBUSY" },
				);
			state.directories.delete(directory);
		},
		makeTempDirectory: async (prefix) => {
			const directory = `${prefix}${(++state.made).toString(36)}x9Qf`;
			state.directories.add(directory);
			return directory;
		},
		listDirectory: async (directory) => {
			if (state.unlistable) throw new Error("EACCES: permission denied");
			return [...state.directories]
				.filter((made) => path.dirname(made) === directory)
				.map((made) => path.basename(made));
		},
		writeNew: async (file, data) => {
			state.contents.set(file, data);
		},
	};
	setOwnedFileBackendForTest(backend);
	return state;
}

/** Everything logged at `level`, as it would be printed. */
function logged(level: "error" | "warn") {
	const lines: string[] = [];
	const spy = spyOn(logger, level).mockImplementation(
		(message: unknown, meta?: unknown) => {
			lines.push(`${String(message)} ${inspect(meta, { depth: 6 })}`);
			return logger;
		},
	);
	return { lines, restore: () => spy.mockRestore() };
}

const ended: EffectOwner = { ended: () => true };
const curl = async (argv: string[]) => ({ exitCode: 0, argv });

afterEach(() => {
	setOwnedFileBackendForTest(null);
	resetPrivateCurlFilesForTest();
});

describe("a private curl config", () => {
	it("holds the URL for one run and is gone afterwards", async () => {
		const files = privateFiles();
		const errors = logged("error");
		const result = await runCurlWithPrivateUrl(["curl", "-sS"], URL, curl);
		expect(result.argv.slice(0, 3)).toEqual(["curl", "-sS", "-K"]);
		expect(result.argv.join(" ")).not.toContain(TOKEN);
		expect([...files.contents.values()].join("")).toContain(TOKEN);
		expect([...files.directories]).toEqual([]);
		expect(errors.lines).toEqual([]);
		errors.restore();
	});

	it("that cannot be removed is reported, and the run's result stands", async () => {
		const files = privateFiles();
		const errors = logged("error");
		const result = await runCurlWithPrivateUrl(["curl"], URL, async (argv) => {
			// The directory exists now: its removal will fail.
			for (const directory of files.directories) files.stuck.add(directory);
			return curl(argv);
		});
		expect(result.exitCode).toBe(0);
		expect(errors.lines).toHaveLength(1);
		const [report] = errors.lines as [string];
		const [left] = [...files.directories] as [string];
		expect(report).toStartWith(PRIVATE_FILE_LEFT_BEHIND);
		// Where such files live and what failed; not which one, not the token.
		expect(report).toContain(path.join(tmpdir(), "ceraui-curl-*"));
		expect(report).toContain("EBUSY");
		expect(report).not.toContain(path.basename(left));
		expect(report).not.toContain(TOKEN);
		errors.restore();
	});

	it("is reported for an owner that has ended too", async () => {
		const files = privateFiles();
		const errors = logged("error");
		// The owner ends while curl runs: the removal is its teardown.
		let over = false;
		const owner: EffectOwner = { ended: () => over };
		await runCurlWithPrivateUrl(
			["curl"],
			URL,
			async (argv) => {
				over = true;
				for (const directory of files.directories) files.stuck.add(directory);
				return curl(argv);
			},
			owner,
		);
		expect(errors.lines).toHaveLength(1);
		expect(errors.lines[0]).toStartWith(PRIVATE_FILE_LEFT_BEHIND);
		expect(errors.lines[0]).not.toContain(TOKEN);
		expect(files.directories.size).toBe(1);
		errors.restore();
	});
});

describe("the sweep an install starts with", () => {
	it("removes what an earlier run could not, and what an earlier process left", async () => {
		const files = privateFiles();
		const errors = logged("error");
		await runCurlWithPrivateUrl(["curl"], URL, async (argv) => {
			for (const directory of files.directories) files.stuck.add(directory);
			return curl(argv);
		});
		expect(files.directories.size).toBe(1);
		// Whatever held it has let go; and a process that died left another,
		// an hour ago. A third is fresh: some other process's probe in flight.
		files.stuck.clear();
		const abandoned = path.join(tmpdir(), "ceraui-curl-Zk3LmQ");
		files.directories.add(abandoned);
		files.changed.set(abandoned, NOW - 60 * 60_000);
		const fresh = path.join(tmpdir(), "ceraui-curl-fresh1");
		files.directories.add(fresh);
		files.changed.set(fresh, NOW - 5_000);
		// Other names in the same place are nobody's business here.
		files.directories.add(path.join(tmpdir(), "ceraui-update-index-a1"));
		files.directories.add(path.join(tmpdir(), "someone-elses"));
		await sweepPrivateCurlFiles(undefined, now);
		expect([...files.directories].sort()).toEqual(
			[
				fresh,
				path.join(tmpdir(), "ceraui-update-index-a1"),
				path.join(tmpdir(), "someone-elses"),
			].sort(),
		);
		expect(errors.lines).toHaveLength(1);
		errors.restore();
	});

	it("leaves the config of a run in flight alone", async () => {
		const files = privateFiles();
		let during: string[] = [];
		await runCurlWithPrivateUrl(["curl"], URL, async (argv) => {
			await sweepPrivateCurlFiles();
			during = [...files.directories];
			return curl(argv);
		});
		expect(during).toHaveLength(1);
		expect([...files.directories]).toEqual([]);
	});

	it("reports again what it still cannot remove, also for an owner that has ended", async () => {
		const files = privateFiles();
		const errors = logged("error");
		const stray = path.join(tmpdir(), "ceraui-curl-Zk3LmQ");
		files.directories.add(stray);
		files.changed.set(stray, NOW - 60 * 60_000);
		files.stuck.add(stray);
		await sweepPrivateCurlFiles(ended, now);
		expect(errors.lines).toHaveLength(1);
		expect(errors.lines[0]).toStartWith(PRIVATE_FILE_LEFT_BEHIND);
		expect(errors.lines[0]).not.toContain("Zk3LmQ");
		// It is remembered: the next sweep tries again without a listing.
		files.stuck.clear();
		files.unlistable = true;
		const warnings = logged("warn");
		await sweepPrivateCurlFiles(ended);
		expect([...files.directories]).toEqual([]);
		// A listing that fails is nothing an ended owner reports.
		expect(warnings.lines).toEqual([]);
		await sweepPrivateCurlFiles();
		expect(warnings.lines).toHaveLength(1);
		expect(warnings.lines[0]).toStartWith(
			"Private curl configs could not be looked for",
		);
		warnings.restore();
		errors.restore();
	});
});
