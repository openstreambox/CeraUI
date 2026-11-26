/// <reference types="bun" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import path from "node:path";
import { inspect } from "node:util";
import {
	type EffectOwner,
	type OwnedFileBackend,
	setOwnedFileBackendForTest,
} from "../helpers/effect-owner.ts";
import { logger } from "../helpers/logger.ts";
import {
	PRIVATE_CURL_DIRECTORY,
	PRIVATE_FILE_LEFT_BEHIND,
	runCurlWithPrivateUrl,
	wipePrivateCurlConfigs,
} from "../modules/system/curl-private-url.ts";

const TOKEN = "k7Qm2xV9pL4sT8wZ";
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
		makeTempDirectory: never,
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

afterEach(() => setOwnedFileBackendForTest(null));

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
		await wipePrivateCurlConfigs();
		expect(files.steps).toEqual([`rm -r ${PRIVATE_CURL_DIRECTORY}`]);
		expect([...files.files.keys()].sort()).toEqual([
			"/run/ceralive/clock-gate-open",
			"/tmp/ceraui-curl-abc/url",
		]);
		expect(logged.lines).toEqual([]);
		logged.restore();
	});

	it("reports a wipe that fails, and goes on", async () => {
		const files = privateFiles();
		const logged = errors();
		files.stuck = true;
		await wipePrivateCurlConfigs();
		expect(logged.lines).toHaveLength(1);
		expect(logged.lines[0]).toStartWith(PRIVATE_FILE_LEFT_BEHIND);
		logged.restore();
	});
});
