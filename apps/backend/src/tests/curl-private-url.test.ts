/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import {
	type EffectOwner,
	type OwnedFileBackend,
	ownedFiles,
	setOwnedFileBackendForTest,
} from "../helpers/effect-owner.ts";
import { logger } from "../helpers/logger.ts";
import {
	PRIVATE_CURL_DIRECTORY,
	PRIVATE_FILE_LEFT_BEHIND,
	runCurlWithPrivateUrl,
	setPrivateCurlDirectoryForTest,
	wipePrivateCurlConfigs,
} from "../modules/system/curl-private-url.ts";

const TOKEN = "k7Qm2xV9pL4sT8wZb3Nc";
const URL = `https://updates.example.org/${TOKEN}/apt/dists/suite/InRelease`;

/** Files as an object: every file step is recorded, removals can fail. */
function privateFiles() {
	const state = {
		files: new Map<string, { data: string; mode: number }>(),
		/** Every step, in order: what was done to which path. */
		steps: [] as string[],
		/** Removals fail (EBUSY). */
		stuck: false,
	};
	const never = async () => {
		throw new Error("not used by a private curl run");
	};
	const busy = (target: string) =>
		Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), {
			code: "EBUSY",
		});
	const backend: OwnedFileBackend = {
		inspect: never,
		setMode: never,
		createExclusive: never,
		makeTempDirectory: async (prefix) => {
			state.steps.push(`mkdtemp ${prefix}`);
			return `${prefix}Xy12`;
		},
		makeDirectory: async (directory, mode) => {
			state.steps.push(`mkdir ${mode.toString(8)} ${directory}`);
		},
		writeNew: async (file, data, mode) => {
			state.steps.push(`write ${mode.toString(8)} ${file}`);
			state.files.set(file, { data, mode });
		},
		removeFile: async (file) => {
			state.steps.push(`rm ${file}`);
			if (state.stuck) throw busy(file);
			state.files.delete(file);
		},
		removeTree: async (directory) => {
			state.steps.push(`rm -r ${directory}`);
			if (state.stuck) throw busy(directory);
			for (const file of state.files.keys())
				if (path.dirname(file) === directory) state.files.delete(file);
		},
	};
	setOwnedFileBackendForTest(backend);
	return state;
}

/** Everything logged as an error, as it would be printed. */
function errors() {
	const lines: string[] = [];
	const spy = spyOn(logger, "error").mockImplementation(
		(message: unknown, meta?: unknown) => {
			lines.push(`${String(message)} ${inspect(meta, { depth: 6 })}`);
			return logger;
		},
	);
	return { lines, restore: () => spy.mockRestore() };
}

const curl = async (argv: string[]) => ({ exitCode: 0, argv });

beforeEach(() => {
	// The service's backend: it holds the single-instance lock.
	setPrivateCurlDirectoryForTest(PRIVATE_CURL_DIRECTORY);
});
afterEach(() => {
	setOwnedFileBackendForTest(null);
	setPrivateCurlDirectoryForTest(null);
});

describe("a private curl config", () => {
	it("is written only in the service's own directory and removed by its exact path", async () => {
		const files = privateFiles();
		const logged = errors();
		let during: string[] = [];
		const result = await runCurlWithPrivateUrl(
			["curl", "-sS"],
			URL,
			async (argv) => {
				during = [...files.files.keys()];
				return curl(argv);
			},
		);
		// curl got the file, never the URL.
		expect(result.argv.slice(0, 3)).toEqual(["curl", "-sS", "-K"]);
		expect(result.argv.join(" ")).not.toContain(TOKEN);
		const [file] = during as [string];
		expect(result.argv[3]).toBe(file);
		expect(path.dirname(file)).toBe(PRIVATE_CURL_DIRECTORY);
		expect(PRIVATE_CURL_DIRECTORY).toBe("/run/ceralive/curl-private");
		// The directory 0700, the file 0600, and that one file removed again.
		expect(files.steps).toEqual([
			`mkdir 700 ${PRIVATE_CURL_DIRECTORY}`,
			`write 600 ${file}`,
			`rm ${file}`,
		]);
		expect([...files.files]).toEqual([]);
		expect(logged.lines).toEqual([]);
		logged.restore();
	});

	it.each(["a live owner", "an owner that has ended", "nobody"] as const)(
		"that cannot be removed is reported as a security line for %s, and the run's result stands",
		async (whom) => {
			const files = privateFiles();
			const logged = errors();
			let over = false;
			const owner: EffectOwner | undefined =
				whom === "nobody" ? undefined : { ended: () => over };
			const result = await runCurlWithPrivateUrl(
				["curl"],
				URL,
				async (argv) => {
					// The removal is the run's teardown: made although the owner
					// has ended, and it fails.
					over = whom === "an owner that has ended";
					files.stuck = true;
					return curl(argv);
				},
				owner,
			);
			expect(result.exitCode).toBe(0);
			expect(logged.lines).toHaveLength(1);
			const [report] = logged.lines as [string];
			const [left] = [...files.files.keys()] as [string];
			expect(report).toStartWith(PRIVATE_FILE_LEFT_BEHIND);
			// Which directory and what failed; not which file, not the token.
			expect(report).toContain(PRIVATE_CURL_DIRECTORY);
			expect(report).toContain("EBUSY");
			expect(report).not.toContain(path.basename(left));
			expect(report).not.toContain(TOKEN);
			logged.restore();
		},
	);

	it("is not written for an owner that has ended, and then nothing is removed", async () => {
		const files = privateFiles();
		let over = false;
		const owner: EffectOwner = { ended: () => over };
		const backend = files.steps;
		// The owner ends while the directory is made sure of.
		const original = backend.push.bind(backend);
		backend.push = (...steps: string[]) => {
			over = true;
			return original(...steps);
		};
		await expect(
			runCurlWithPrivateUrl(["curl"], URL, curl, owner),
		).rejects.toThrow("not done for an owner that has ended");
		expect(files.steps).toEqual([`mkdir 700 ${PRIVATE_CURL_DIRECTORY}`]);
	});
});

describe("an instance that is not the sole backend", () => {
	it("keeps its configs in a directory of its own, where the service's start removes nothing", async () => {
		const files = privateFiles();
		// No lease: source development, or a boot without the lock.
		setPrivateCurlDirectoryForTest(null);
		await wipePrivateCurlConfigs(false);
		const prefix = path.join(tmpdir(), `ceraui-curl-${process.pid}-`);
		const own = `${prefix}Xy12`;
		let during: string[] = [];
		const run = async (argv: string[]) => {
			during = [...files.files.keys()];
			return curl(argv);
		};
		await runCurlWithPrivateUrl(["curl"], URL, run);
		const [first] = during as [string];
		expect(path.dirname(first)).toBe(own);
		expect(first.startsWith(PRIVATE_CURL_DIRECTORY)).toBe(false);
		// Made once for the process, and each file removed by its own path.
		await runCurlWithPrivateUrl(["curl"], URL, run);
		expect(path.dirname(during[0] as string)).toBe(own);
		expect(files.steps.filter((step) => step.startsWith("mkdtemp"))).toEqual([
			`mkdtemp ${prefix}`,
		]);
		expect(files.steps.some((step) => step.startsWith("mkdir"))).toBe(false);
		expect([...files.files]).toEqual([]);

		// The service starts beside it while one of its probes is in flight:
		// the wipe takes the service's directory, not this instance's file.
		let survived = false;
		await runCurlWithPrivateUrl(["curl"], URL, async (argv) => {
			const [mine] = [...files.files.keys()] as [string];
			await ownedFiles(undefined).removeTree(
				"private-file:remove",
				PRIVATE_CURL_DIRECTORY,
			);
			survived = files.files.has(mine);
			return curl(argv);
		});
		expect(survived).toBe(true);
	});

	it("the process that holds the lease writes into the service's directory from its start on", async () => {
		const files = privateFiles();
		setPrivateCurlDirectoryForTest(null);
		await wipePrivateCurlConfigs(true);
		let during: string[] = [];
		await runCurlWithPrivateUrl(["curl"], URL, async (argv) => {
			during = [...files.files.keys()];
			return curl(argv);
		});
		expect(path.dirname(during[0] as string)).toBe(PRIVATE_CURL_DIRECTORY);
		expect(files.steps[0]).toBe(`rm -r ${PRIVATE_CURL_DIRECTORY}`);
	});
});

describe("the backend's start", () => {
	it("wipes that one directory, by its fixed path, and looks at nothing else", async () => {
		const files = privateFiles();
		const logged = errors();
		// What an earlier process left there, and files that are not its business.
		files.files.set(`${PRIVATE_CURL_DIRECTORY}/left.conf`, {
			data: URL,
			mode: 0o600,
		});
		files.files.set("/run/ceralive/clock-gate-open", { data: "", mode: 0o644 });
		files.files.set("/tmp/ceraui-curl-abc/url", { data: URL, mode: 0o600 });
		await wipePrivateCurlConfigs(true);
		expect(files.steps).toEqual([`rm -r ${PRIVATE_CURL_DIRECTORY}`]);
		expect([...files.files.keys()].sort()).toEqual([
			"/run/ceralive/clock-gate-open",
			"/tmp/ceraui-curl-abc/url",
		]);
		expect(logged.lines).toEqual([]);
		logged.restore();
	});

	it("removes nothing when this process is not the sole backend", async () => {
		const files = privateFiles();
		// A second instance beside the running service (source development):
		// the service's probes may be in flight.
		files.files.set(`${PRIVATE_CURL_DIRECTORY}/in-flight.conf`, {
			data: URL,
			mode: 0o600,
		});
		await wipePrivateCurlConfigs(false);
		expect(files.steps).toEqual([]);
		expect([...files.files.keys()]).toEqual([
			`${PRIVATE_CURL_DIRECTORY}/in-flight.conf`,
		]);
	});

	it("is asked for at boot with the lock this process actually holds", () => {
		const main = readFileSync(
			path.join(import.meta.dir, "..", "main.ts"),
			"utf8",
		);
		expect(main.match(/wipePrivateCurlConfigs\(/g)).toHaveLength(1);
		// Not the policy that a lock applies: boot goes on without one when its
		// directory is unavailable, and then nothing is wiped.
		expect(main).toContain(
			"wipePrivateCurlConfigs(holdsBackendSingletonLease())",
		);
	});

	it("reports a wipe that fails, and goes on", async () => {
		const files = privateFiles();
		const logged = errors();
		files.stuck = true;
		await wipePrivateCurlConfigs(true);
		expect(logged.lines).toHaveLength(1);
		expect(logged.lines[0]).toStartWith(PRIVATE_FILE_LEFT_BEHIND);
		logged.restore();
	});
});
