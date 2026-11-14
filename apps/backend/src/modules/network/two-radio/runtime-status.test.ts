import { afterEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../../helpers/logger.ts";
import * as configuration from "../../config.ts";
import { initTwoRadioLive, type startLive } from "./runtime.ts";
import { statusPath } from "./status.ts";
import { config, state } from "./synthetic.fixture.ts";

const roots: string[] = [];
const previous = process.env.CERALIVE_RUN_DIR;
afterEach(() => {
	mock.restore();
	if (previous === undefined) delete process.env.CERALIVE_RUN_DIR;
	else process.env.CERALIVE_RUN_DIR = previous;
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

test("startup publishes normal and failed live cycles only to runtime storage", async () => {
	const root = fs.mkdtempSync(join(tmpdir(), "runtime-status-"));
	roots.push(root);
	process.env.CERALIVE_RUN_DIR = join(root, "run");
	spyOn(configuration, "getConfig").mockReturnValue({
		two_radio_enabled: true,
	} as ReturnType<typeof configuration.getConfig>);
	spyOn(configuration, "getConfigFilePath").mockReturnValue(
		join(root, "config.json"),
	);
	fs.writeFileSync(join(root, "two-radio.json"), JSON.stringify(config));
	const directory = join(root, "two-radio");
	fs.mkdirSync(directory);
	const legacy = join(directory, "status.json");
	fs.writeFileSync(legacy, "stale");
	const warnings = spyOn(logger, "warn").mockImplementation(() => {});
	const timers: (() => void)[] = [];
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
	) => {
		timers.push(callback);
		return { unref() {} };
	}) as unknown as typeof setTimeout);
	let cycles = 0;
	const view = { holder: "a", now: 1000 };
	const start = mock(async () => ({
		session: "session",
		identities: new Map([["a", state("a")]]),
		coordinator: { view: () => view },
		cycle: async () => {
			if (++cycles === 2) throw new Error("lost radio");
		},
	})) as unknown as typeof startLive;
	await initTwoRadioLive(start);
	expect(JSON.parse(fs.readFileSync(statusPath(), "utf8"))).toEqual({
		session: "session",
		identities: { a: state("a").identity },
		...view,
	});
	expect(fs.existsSync(legacy)).toBe(false);
	expect(timers).toHaveLength(1);
	timers[0]?.();
	for (let turn = 0; turn < 20 && cycles < 2; turn++) await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(JSON.parse(fs.readFileSync(statusPath(), "utf8"))).toEqual({
		session: "session",
		error: "Error: lost radio",
		state: view,
	});
	expect(fs.existsSync(legacy)).toBe(false);
	expect(warnings).toHaveBeenCalledTimes(1);
	expect(timers).toHaveLength(1);
});

test("disabled startup removes legacy status without starting live IO", async () => {
	const root = fs.mkdtempSync(join(tmpdir(), "runtime-status-disabled-"));
	roots.push(root);
	spyOn(configuration, "getConfig").mockReturnValue({
		two_radio_enabled: false,
	} as ReturnType<typeof configuration.getConfig>);
	spyOn(configuration, "getConfigFilePath").mockReturnValue(
		join(root, "config.json"),
	);
	fs.mkdirSync(join(root, "two-radio"));
	const legacy = join(root, "two-radio", "status.json");
	fs.writeFileSync(legacy, "stale");
	const log = spyOn(logger, "info").mockImplementation(() => {});
	const start = mock(async () => null);
	await initTwoRadioLive(start);
	expect(fs.existsSync(legacy)).toBe(false);
	expect(start).not.toHaveBeenCalled();
	expect(log).toHaveBeenCalledTimes(1);
});
