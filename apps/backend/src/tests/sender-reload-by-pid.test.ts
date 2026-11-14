import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessSignalRunnerForTest } from "@ceraui/srtla-send/process-signals";
import { restartSrtla } from "../modules/streaming/srtla.ts";
import {
	type StreamingProcess,
	signalSenders,
	spawnStreamingLoop,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";

// The bond reload must reach the sender this backend supervises, and nothing
// else that happens to share its process name. Both "senders" here are the
// test's own children: a shell script named `srtla_send` that records every
// SIGHUP it receives. Nothing is signalled by name, so the test is safe outside
// a PID namespace.

let dir: string;
let script: string;
const nameSignals: string[][] = [];
const children: Bun.Subprocess[] = [];
const tracked: StreamingProcess[] = [];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sender-reload-by-pid-"));
	script = join(dir, "srtla_send");
	writeFileSync(
		script,
		[
			"#!/bin/sh",
			`trap 'echo hup >> "$1"' HUP`,
			': > "$1"',
			'echo ready > "$1.ready"',
			"while :; do sleep 0.02; done",
			"",
		].join("\n"),
	);
	chmodSync(script, 0o755);
	setProcessSignalRunnerForTest(async (binary, args) => {
		nameSignals.push([binary, ...args]);
	});
});

afterEach(async () => {
	for (const sp of tracked.splice(0)) await stopProcessAndWait(sp);
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGTERM");
		await child.exited;
	}
	nameSignals.length = 0;
});

afterAll(() => {
	setProcessSignalRunnerForTest(async () => {});
	rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await Bun.sleep(10);
	}
	return predicate();
}

function hups(marker: string): number {
	if (!existsSync(marker)) return 0;
	return readFileSync(marker, "utf8")
		.split("\n")
		.filter((l) => l === "hup").length;
}

async function startTracked(
	name: string,
): Promise<{ sp: StreamingProcess; marker: string }> {
	const marker = join(dir, name);
	const sp = spawnStreamingLoop(script, [marker], () => {});
	tracked.push(sp);
	expect(await waitUntil(() => existsSync(`${marker}.ready`))).toBe(true);
	return { sp, marker };
}

async function startForeign(
	name: string,
): Promise<{ child: Bun.Subprocess; marker: string }> {
	const marker = join(dir, name);
	const child = Bun.spawn([script, marker], {
		stdout: "ignore",
		stderr: "ignore",
	});
	children.push(child);
	expect(await waitUntil(() => existsSync(`${marker}.ready`))).toBe(true);
	return { child, marker };
}

describe("bond reload signals the supervised sender by PID", () => {
	test("the tracked sender reloads and a second process named srtla_send is untouched", async () => {
		const mine = await startTracked("tracked");
		const other = await startForeign("foreign");

		expect(await restartSrtla()).toBe(true);

		expect(await waitUntil(() => hups(mine.marker) === 1)).toBe(true);
		// Give a stray signal time to land before judging the bystander.
		await Bun.sleep(150);
		expect(hups(other.marker)).toBe(0);
		expect(other.child.exitCode).toBeNull();
		expect(other.child.signalCode).toBeNull();
		expect(hups(mine.marker)).toBe(1);
		expect(nameSignals).toEqual([]);
	});

	test("with no supervised sender the reload reports a failed delivery", async () => {
		const other = await startForeign("bystander");

		expect(await restartSrtla()).toBe(false);

		await Bun.sleep(150);
		expect(hups(other.marker)).toBe(0);
		expect(nameSignals).toEqual([]);
	});

	test("a sender that has exited is not signalled and the delivery is reported as failed", async () => {
		const mine = await startTracked("exited");
		mine.sp.proc.kill("SIGTERM");
		await mine.sp.proc.exited;

		expect(await restartSrtla()).toBe(false);
		expect(nameSignals).toEqual([]);
	});
});

describe("signalSenders", () => {
	function fake(
		spawnfile: string,
		kill: (signal: string) => void,
	): StreamingProcess {
		return {
			spawnfile,
			exitListeners: [],
			proc: {
				exitCode: null,
				signalCode: null,
				kill,
			} as unknown as StreamingProcess["proc"],
		};
	}

	test("only live sender processes are signalled; a throwing kill counts as undelivered", () => {
		const sent: string[] = [];
		const procs = [
			fake("/usr/bin/srtla_send", (s) => sent.push(`sender:${s}`)),
			fake("/usr/bin/srt-live-transmit", (s) => sent.push(`other:${s}`)),
			fake("/opt/srtla_send", () => {
				throw new Error("ESRCH");
			}),
		];
		expect(signalSenders("SIGHUP", procs)).toBe(1);
		expect(sent).toEqual(["sender:SIGHUP"]);
	});

	test("a sender that already exited is skipped, not signalled", () => {
		const sent: string[] = [];
		const done = fake("/usr/bin/srtla_send", (s) => sent.push(s));
		(done.proc as { exitCode: number | null }).exitCode = 0;
		expect(signalSenders("SIGHUP", [done])).toBe(0);
		expect(sent).toEqual([]);
	});
});
