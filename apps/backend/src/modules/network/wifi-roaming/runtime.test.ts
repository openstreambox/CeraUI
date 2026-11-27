import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RadioRead } from "./radio-port.ts";
import {
	createObserverRuntime,
	fileIo,
	JOURNAL_MAX_LINES,
	JOURNAL_MAX_PENDING,
	type RuntimeDeps,
	type RuntimeIo,
	roamingBlocker,
	STATUS_REFRESH_MS,
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
	mapping: { unmapped: 0, ambiguous: 0, uncounted: 0 },
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type FakeDeps = Omit<RuntimeDeps, "sender" | "io"> & {
	sender: Mutable<SenderPort>;
	io: Mutable<RuntimeIo>;
};

function fakeDeps(over: Partial<RuntimeDeps> = {}) {
	const log: string[] = [];
	const statuses: string[] = [];
	const journal: string[] = [];
	let tick: (() => void) | null = null;
	let cleared = false;
	const sender: Mutable<SenderPort> = {
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
	const io: Mutable<RuntimeIo> = {
		writeStatus: async (json) => {
			statuses.push(json);
		},
		appendJournal: async (line) => {
			journal.push(line);
		},
	};
	const clock = { now: 5_000 };
	const deps: FakeDeps = {
		now: () => clock.now,
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
		clock,
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

describe("bounded writes", () => {
	test("an unchanged status is written again only every 10 s", async () => {
		const f = fakeDeps();
		const rt = createObserverRuntime(f.deps);
		await rt.round();
		f.clock.now += 1_000;
		await rt.round();
		f.clock.now += 1_000;
		await rt.round();
		expect(f.statuses).toHaveLength(1);
		f.clock.now += STATUS_REFRESH_MS;
		await rt.round();
		expect(f.statuses).toHaveLength(2);
		await rt.stop();
	});

	test("a stalled journal holds at most its pending bound; the rest is dropped and counted", async () => {
		const f = fakeDeps();
		const never = new Promise<void>(() => {});
		f.deps.io.appendJournal = () => never;
		// Every round replaces the radio: a radio-gone and a radio-added event.
		let n = 0;
		f.deps.radios.read = async () => ({
			radios: [
				{
					id: `02:00:00:00:f0:01/${n++}:1:p`,
					permanentMac: "02:00:00:00:f0:01",
					ifname: "wlan1",
					station: true,
					reserved: false,
					link: null,
				},
			],
			skipped: [],
		});
		const rt = createObserverRuntime(f.deps);
		for (let i = 0; i < JOURNAL_MAX_PENDING; i++) {
			f.clock.now += STATUS_REFRESH_MS;
			await rt.round();
		}
		const doc = JSON.parse(f.statuses.at(-1) as string);
		expect(doc.journalDropped).toBeGreaterThan(0);
		const started = Date.now();
		await rt.stop();
		expect(Date.now() - started).toBeLessThan(STOP_DEADLINE_MS + 500);
	}, 10_000);

	test("nothing is written after the stop deadline", async () => {
		const f = fakeDeps();
		const gate = Promise.withResolvers<void>();
		f.deps.sender.poll = () => gate.promise;
		const rt = createObserverRuntime(f.deps);
		void rt.round();
		await rt.stop();
		const written = f.statuses.length + f.journal.length;
		gate.resolve();
		await Bun.sleep(20);
		expect(f.statuses.length + f.journal.length).toBe(written);
	}, 10_000);
});

describe("modes of existing files", () => {
	test("an existing directory and journal get their modes back", async () => {
		const root = await mkdtemp(join(tmpdir(), "wifi-roaming-modes-"));
		const dir = join(root, "run");
		try {
			await mkdir(dir, { mode: 0o755 });
			await chmod(dir, 0o755);
			await writeFile(join(dir, "journal.jsonl"), "", { mode: 0o644 });
			await chmod(join(dir, "journal.jsonl"), 0o644);
			const io = fileIo(dir);
			await io.appendJournal('{"e":1}');
			expect((await stat(dir)).mode & 0o777).toBe(0o700);
			expect((await stat(join(dir, "journal.jsonl"))).mode & 0o777).toBe(0o600);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
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
