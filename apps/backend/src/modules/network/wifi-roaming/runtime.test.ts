import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RadioRead } from "./radio-port.ts";
import {
	createObserverRuntime,
	fileIo,
	JOURNAL_MAX_LINES,
	type RuntimeDeps,
	type RuntimeIo,
	roamingBlocker,
	STOP_DEADLINE_MS,
} from "./runtime.ts";
import type { SenderPort, SenderView } from "./sender-port.ts";

describe("when the observer starts", () => {
	test("off unless the level is observe, and never next to the two-radio coordinator", () => {
		expect(roamingBlocker(undefined, false)).toBe("off");
		expect(roamingBlocker({ level: "off" }, false)).toBe("off");
		expect(roamingBlocker({ level: "observe" }, true)).toBe(
			"two-radio-coordinator-enabled",
		);
		expect(roamingBlocker({ level: "observe" }, false)).toBeNull();
	});
});

const VIEW: SenderView = {
	reachable: true,
	arrivalReports: true,
	standby: false,
};

function fakeDeps(over: Partial<RuntimeDeps> = {}) {
	const log: string[] = [];
	const statuses: string[] = [];
	const journal: string[] = [];
	let tick: (() => void) | null = null;
	let cleared = false;
	const sender: SenderPort = {
		poll: async () => {
			log.push("poll");
		},
		snapshot: () => undefined,
		view: () => VIEW,
		close: () => {
			log.push("close");
		},
	};
	const radios = {
		read: async (): Promise<RadioRead> => {
			log.push("read");
			return {
				radios: [
					{
						id: "02:00:00:00:f0:01/1:1:p",
						permanentMac: "02:00:00:00:f0:01",
						ifname: "wlan1",
						station: true,
						reserved: false,
						link: { bssid: "aa:00:00:00:00:01", ssid: "venue", signalDbm: -55 },
					},
				],
				skipped: [],
			};
		},
	};
	const io: RuntimeIo = {
		writeStatus: async (json) => {
			statuses.push(json);
		},
		appendJournal: async (line) => {
			journal.push(line);
		},
	};
	const deps: RuntimeDeps = {
		now: () => 5_000,
		sender,
		radios,
		io,
		setInterval: (fn) => {
			tick = fn;
			return 1;
		},
		clearInterval: () => {
			cleared = true;
		},
		...over,
	};
	return {
		deps,
		log,
		statuses,
		journal,
		tick: () => tick?.(),
		cleared: () => cleared,
	};
}

describe("the observer runtime", () => {
	test("a round reads the sender and the radios, then writes the status and journal", async () => {
		const f = fakeDeps();
		const rt = createObserverRuntime(f.deps);
		await rt.round();
		expect(f.log).toEqual(["poll", "read"]);
		const doc = JSON.parse(f.statuses.at(-1) as string);
		expect(doc).toMatchObject({
			level: "observe",
			state: "observing",
			sender: VIEW,
			radios: [{ ifname: "wlan1", decision: "none" }],
		});
		await rt.stop();
		expect(f.journal.map((l) => JSON.parse(l).event)).toEqual(["radio-added"]);
	});

	test("rounds never overlap: a tick during a round joins it", async () => {
		const gate = Promise.withResolvers<void>();
		const f = fakeDeps();
		let polls = 0;
		f.deps.sender.poll = async () => {
			polls++;
			await gate.promise;
		};
		const rt = createObserverRuntime(f.deps);
		const a = rt.round();
		f.tick();
		const b = rt.round();
		gate.resolve();
		await Promise.all([a, b]);
		expect(polls).toBe(1);
		await rt.stop();
	});

	test("stop ends the loop, waits for the round, closes the sender and writes a final status", async () => {
		const gate = Promise.withResolvers<void>();
		const f = fakeDeps();
		f.deps.sender.poll = async () => {
			await gate.promise;
		};
		const rt = createObserverRuntime(f.deps);
		const round = rt.round();
		const stopping = rt.stop();
		gate.resolve();
		await Promise.all([round, stopping]);
		expect(f.cleared()).toBe(true);
		expect(f.log).toContain("close");
		// The round stopped after the sender read: no radio read, no observing status.
		expect(f.log).not.toContain("read");
		expect(JSON.parse(f.statuses.at(-1) as string).state).toBe("stopped");
		await rt.round();
		expect(f.log).not.toContain("read");
	});

	test("stop gives up on a hung round after its deadline", async () => {
		const f = fakeDeps();
		f.deps.sender.poll = () => new Promise<void>(() => {});
		const rt = createObserverRuntime(f.deps);
		void rt.round();
		const started = Date.now();
		await rt.stop();
		const took = Date.now() - started;
		expect(took).toBeGreaterThanOrEqual(STOP_DEADLINE_MS - 50);
		expect(took).toBeLessThan(STOP_DEADLINE_MS + 1_000);
		expect(f.log).toContain("close");
	}, 10_000);

	test("a failing status or journal write loses the round's line, never the loop", async () => {
		const f = fakeDeps();
		f.deps.io.writeStatus = async () => {
			throw new Error("EROFS");
		};
		f.deps.io.appendJournal = async () => {
			throw new Error("EROFS");
		};
		const rt = createObserverRuntime(f.deps);
		await rt.round();
		await rt.round();
		expect(f.log).toEqual(["poll", "read", "poll", "read"]);
		await rt.stop();
	});
});

describe("files under /run", () => {
	let dir = "";
	beforeEach(async () => {
		dir = join(await mkdtemp(join(tmpdir(), "wifi-roaming-")), "run");
	});
	afterEach(async () => {
		await rm(join(dir, ".."), { recursive: true, force: true });
	});

	test("status and journal are 0600 in a 0700 directory, the status replaced atomically", async () => {
		const io = fileIo(dir);
		await io.writeStatus('{"a":1}\n');
		await io.writeStatus('{"a":2}\n');
		await io.appendJournal('{"e":1}');
		expect(await readFile(join(dir, "status.json"), "utf8")).toBe('{"a":2}\n');
		expect((await stat(join(dir, "status.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "journal.jsonl"))).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
	});

	test("the journal is bounded: past the limit it keeps the newer half", async () => {
		const io = fileIo(dir);
		for (let i = 0; i < JOURNAL_MAX_LINES + 1; i++)
			await io.appendJournal(`{"n":${i}}`);
		const lines = (await readFile(join(dir, "journal.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBe(JOURNAL_MAX_LINES / 2 + 1);
		expect(lines.at(-1)).toBe(`{"n":${JOURNAL_MAX_LINES}}`);
	});
});
