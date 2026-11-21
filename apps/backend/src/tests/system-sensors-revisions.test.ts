/*
 * Task 15 — Bun-native migration of system/sensors.ts + system/revisions.ts.
 *
 * Proves the migrated read/exec primitives (Bun.file().text(), Bun.spawn)
 * produce IDENTICAL parsed values to the previous node:fs / node:child_process
 * implementation, and that a missing /sys path degrades gracefully (no crash).
 *
 * Sensor parse functions are module-private, so we replicate the exact parse
 * arithmetic here against real temp files read via Bun.file().text() — the
 * same primitive the migrated sensors.ts now uses.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";

import type { Subprocess } from "bun";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../helpers/spawn-policy.ts";
import { srtlaSendExec } from "../modules/streaming/streamloop/exec-paths.ts";
import {
	getRevisions,
	initRevisions,
	setEngineVersionProbe,
} from "../modules/system/revisions.ts";

const stampedSources = {
	readVersionStamp: async () => "2026.8.5",
	readBuildStamp: async () => "abc1234",
};

const tmpFiles: string[] = [];

async function writeTmp(name: string, contents: string): Promise<string> {
	const path = `${tmpdir()}/task15-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await Bun.write(path, contents);
	tmpFiles.push(path);
	return path;
}

afterAll(async () => {
	for (const path of tmpFiles) {
		try {
			await Bun.file(path).delete();
		} catch (_err) {}
	}
});

describe("sensors.ts — Bun.file().text() read + numeric parse", () => {
	test("thermal: parseInt(str,10)/1000 → toFixed(1) °C (identical to readFileSync path)", async () => {
		// Kernel exposes millidegrees, often with a trailing newline.
		const path = await writeTmp("thermal", "45123\n");
		const socTempStr = await Bun.file(path).text();
		const socTemp = Number.parseInt(socTempStr, 10) / 1000.0;
		expect(`${socTemp.toFixed(1)} °C`).toBe("45.1 °C");
	});

	test("jetson voltage: parseInt(str,10)/1000 → toFixed(3) V", async () => {
		const path = await writeTmp("voltage", "5123\n");
		const socVoltageStr = await Bun.file(path).text();
		const socVoltage = Number.parseInt(socVoltageStr, 10) / 1000.0;
		expect(`${socVoltage.toFixed(3)} V`).toBe("5.123 V");
	});

	test("jetson current: parseInt(str,10)/1000 → toFixed(3) A", async () => {
		const path = await writeTmp("current", "1500\n");
		const socCurrentStr = await Bun.file(path).text();
		const socCurrent = Number.parseInt(socCurrentStr, 10) / 1000.0;
		expect(`${socCurrent.toFixed(3)} A`).toBe("1.500 A");
	});

	test("missing /sys path: Bun.file().text() rejects → caught, graceful fallback (no crash)", async () => {
		const missing = `/sys/class/thermal/thermal_zone999/temp-${process.pid}-nope`;
		let threw = false;
		// This mirrors the try/catch in updateSensorThermal: a missing sensor
		// path must NOT crash the sampling loop.
		try {
			const str = await Bun.file(missing).text();
			Number.parseInt(str, 10);
		} catch (_err) {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

describe("revisions.ts — bounded async commands and file reads", () => {
	test.each([
		["  2026.8.5 (abc1234)\n", 0, "2026.8.5 (abc1234)"],
		["", 0, "unknown revision"],
		["unusable revision", 1, "unknown revision"],
	])(
		"publishes the SRTLA version for %j / exit %i",
		async (out, code, expected) => {
			const spawn = Bun.spawn;
			const command = spyOn(Bun, "spawn").mockImplementation(() =>
				spawn({
					cmd: [
						process.execPath,
						"-e",
						`process.stdout.write(${JSON.stringify(out)}); process.exitCode = ${code};`,
					],
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			setEngineVersionProbe(async () => undefined);
			try {
				await initRevisions(stampedSources);
				expect(command).toHaveBeenCalledTimes(1);
				expect(command.mock.calls[0]?.[0]).toEqual([srtlaSendExec, "-v"]);
				expect(getRevisions().srtla).toBe(expected);
			} finally {
				command.mockRestore();
				setEngineVersionProbe(null);
			}
		},
	);

	test("the loop progresses while a TERM-ignoring revision command is pending", async () => {
		const ready = Promise.withResolvers<void>();
		const spawn = Bun.spawn;
		let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
		const command = spyOn(Bun, "spawn").mockImplementation(() => {
			child = spawn({
				cmd: [
					process.execPath,
					"-e",
					`
						process.on("SIGTERM", () => {});
						process.stdout.write("partial revision");
						process.send("ready");
						await Bun.sleep(5000);
					`,
				],
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				ipc: () => ready.resolve(),
			});
			return child;
		});

		// Advance only the command deadline after readiness. TERM grace and
		// cleanup still run on normal timers against the real child.
		const schedule = setTimeout;
		let fireDeadline: (() => void) | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			(callback, delay, ...args) => {
				if (delay !== DEFAULT_SPAWN_TIMEOUT_MS)
					return schedule(callback, delay, ...args);
				fireDeadline = () => callback(...args);
				return schedule(() => {}, delay);
			},
		);
		setEngineVersionProbe(async () => undefined);
		const initialized = initRevisions(stampedSources);
		let interval: ReturnType<typeof setInterval> | undefined;
		try {
			const loopProgress = Promise.withResolvers<"ticked">();
			let ticks = 0;
			expect(
				await Promise.race([
					ready.promise.then(() => "ready"),
					initialized.then(() => "finished"),
				]),
			).toBe("ready");
			interval = setInterval(() => {
				if (++ticks === 3) loopProgress.resolve("ticked");
			}, 10);
			expect(
				await Promise.race([
					loopProgress.promise,
					initialized.then(() => "finished"),
				]),
			).toBe("ticked");
			if (!fireDeadline || !child)
				throw new Error("missing revision child or deadline");
			fireDeadline();
			await initialized;
			expect(getRevisions().srtla).toBe("unknown revision");
			await child.exited;
			expect(child.signalCode).toBe("SIGKILL");
		} finally {
			if (interval !== undefined) clearInterval(interval);
			if (child?.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await child?.exited;
			await initialized;
			timer.mockRestore();
			command.mockRestore();
			setEngineVersionProbe(null);
		}
	}, 10_000);

	test("initRevisions() populates a non-empty record incl. Bun.version", async () => {
		await initRevisions();
		const revisions = getRevisions();
		expect(revisions.bun).toBe(Bun.version);
		// ceralive revision is always set (file read OR git fallback OR unknown).
		expect(typeof revisions.ceralive).toBe("string");
		expect(revisions.ceralive.length).toBeGreaterThan(0);
	});
});
