import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFile as appendFileReal,
	chmod,
	chmod as chmodReal,
	mkdir,
	mkdir as mkdirReal,
	mkdtemp,
	readdir as readdirReal,
	readFile,
	readFile as readFileReal,
	rename as renameReal,
	rm,
	stat,
	unlink as unlinkReal,
	writeFile,
	writeFile as writeFileReal,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOSS_TICK_MS, type LossEvent } from "./loss-watch.ts";
import type { RadioRead, RadioView } from "./radio-port.ts";
import {
	createObserverRuntime,
	type FileOps,
	fileIo,
	JOURNAL_MAX_LINES,
	JOURNAL_MAX_PENDING,
	type LossPort,
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
	mapping: { unmapped: 0, ambiguous: 0, uncounted: 0, key: "k1" },
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type FakeDeps = Mutable<Omit<RuntimeDeps, "sender" | "io">> & {
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
						seenBssids: 1,
						scanRule: "rare",
						addresses: ["192.0.2.11"],
						sharedAddress: false,
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
	const lossEvents: LossEvent[] = [];
	const watched: string[][] = [];
	const loss: LossPort = {
		watch: (radios) => {
			watched.push(radios.map((r) => r.ifname));
		},
		tick: async () => {},
		settled: async () => {},
		drain: () => lossEvents.splice(0),
		dropped: () => 0,
		status: () => null,
	};
	const deps: FakeDeps = {
		loss,
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
		lossEvents,
		watched,
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
		expect(f.journal.map((l) => JSON.parse(l).event)).toEqual([
			"radio-added",
			"seen-bssids",
		]);
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

describe("the dead-link watch", () => {
	test("is told every admitted client radio, ticks on its own timer, and its losses reach the journal", async () => {
		const f = fakeDeps();
		const intervals: number[] = [];
		f.deps.setInterval = (_fn, ms) => {
			intervals.push(ms);
			return intervals.length;
		};
		const rt = createObserverRuntime(f.deps);
		expect(intervals.sort((a, b) => a - b)).toEqual([LOSS_TICK_MS, 1_000]);
		f.lossEvents.push({
			at: 5_000,
			radio: "02:00:00:00:f0:01",
			id: "02:00:00:00:f0:01/1:1:p",
			ifname: "wlan1",
			event: "ap-lost",
			bssid: "aa:00:00:00:00:01",
			lostAt: 2_600,
			outcome: "left-bond",
			durationMs: 2_400,
		});
		const base = (await f.deps.radios.read()).radios[0] as RadioView;
		f.deps.radios.read = async () => ({
			radios: [
				base,
				// Lost its access point: still watched, so its loss is measured.
				{ ...base, id: "x/2", ifname: "wlan2", link: null, station: false },
				// Serving a hotspot: not a client radio.
				{ ...base, id: "x/3", ifname: "wlan3", reserved: true },
				// Phy state unknown: not watched either.
				{ ...base, id: "x/4", ifname: "wlan4", reserved: null },
			],
			skipped: [],
		});
		await rt.round();
		expect(f.watched).toEqual([["wlan1", "wlan2"]]);
		await rt.stop();
		expect(f.journal.map((l) => JSON.parse(l).event)).toContain("ap-lost");
	});
});

describe("losses at stop", () => {
	test("a loss a tick in flight finishes during stop is joined before the drain", async () => {
		const f = fakeDeps();
		const finishing = Promise.withResolvers<void>();
		f.deps.loss = {
			...f.deps.loss,
			// The tick in flight ends only now, with a loss it found.
			settled: async () => {
				await finishing.promise;
				f.lossEvents.push({
					at: 6_000,
					radio: "02:00:00:00:f0:01",
					id: "02:00:00:00:f0:01/1:1:p",
					ifname: "wlan1",
					event: "ap-lost",
					bssid: null,
					lostAt: 5_900,
					outcome: "left-bond",
					durationMs: 100,
				});
			},
		};
		const rt = createObserverRuntime(f.deps);
		await rt.round();
		const stopping = rt.stop();
		await Bun.sleep(20);
		finishing.resolve();
		await stopping;
		expect(f.journal.map((l) => JSON.parse(l).event)).toContain("ap-lost");
	});

	test("a loss that ended since the last round still reaches the journal", async () => {
		const f = fakeDeps();
		const rt = createObserverRuntime(f.deps);
		await rt.round();
		f.lossEvents.push({
			at: 6_000,
			radio: "02:00:00:00:f0:01",
			id: "02:00:00:00:f0:01/1:1:p",
			ifname: "wlan1",
			event: "ap-lost",
			bssid: null,
			lostAt: 5_500,
			outcome: "recovered",
			durationMs: 500,
		});
		await rt.stop();
		expect(f.journal.map((l) => JSON.parse(l).event)).toContain("ap-lost");
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
					seenBssids: null,
					scanRule: null,
					addresses: [],
					sharedAddress: false,
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

describe("sealed file io, with the file operations held", () => {
	/** Real file operations under `root`, one of them held until released. */
	function heldOps(hold: "writeFile" | "readFile") {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const calls: string[] = [];
		const wrap = <F extends (...a: never[]) => Promise<unknown>>(
			name: string,
			f: F,
		) =>
			(async (...a: Parameters<F>) => {
				calls.push(name);
				if (name === hold) {
					entered.resolve();
					await gate.promise;
				}
				return f(...a);
			}) as unknown as F;
		const ops: FileOps = {
			appendFile: wrap("appendFile", appendFileReal),
			chmod: wrap("chmod", chmodReal),
			mkdir: wrap("mkdir", mkdirReal),
			readFile: wrap("readFile", readFileReal),
			rename: wrap("rename", renameReal),
			unlink: wrap("unlink", unlinkReal),
			writeFile: wrap("writeFile", writeFileReal),
		};
		return { ops, calls, release: gate.resolve, entered: entered.promise };
	}

	test("a status sealed while its temporary file is being written is never published", async () => {
		const root = await mkdtemp(join(tmpdir(), "wifi-roaming-held-"));
		const dir = join(root, "run");
		try {
			const held = heldOps("writeFile");
			const io = fileIo(dir, held.ops);
			const writing = io.writeStatus('{"v":1}\n');
			await held.entered;
			io.seal?.();
			held.release();
			await writing;
			expect(held.calls).not.toContain("rename");
			expect(held.calls).toContain("unlink");
			expect(await readdirReal(dir)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a journal rotation sealed after its second read writes nothing", async () => {
		const root = await mkdtemp(join(tmpdir(), "wifi-roaming-rot2-"));
		const dir = join(root, "run");
		try {
			await mkdirReal(dir, { recursive: true });
			const full = `${Array.from({ length: JOURNAL_MAX_LINES }, (_, i) => `{"n":${i}}`).join("\n")}\n`;
			await writeFileReal(join(dir, "journal.jsonl"), full, { mode: 0o600 });
			// Hold only the second read: the one rotation makes after the count.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let reads = 0;
			const calls: string[] = [];
			const ops: FileOps = {
				appendFile: async (...a: Parameters<typeof appendFileReal>) => {
					calls.push("appendFile");
					return appendFileReal(...a);
				},
				chmod: chmodReal,
				mkdir: mkdirReal,
				readFile: (async (...a: Parameters<typeof readFileReal>) => {
					reads++;
					if (reads === 2) {
						entered.resolve();
						await gate.promise;
					}
					return readFileReal(...a);
				}) as typeof readFileReal,
				rename: renameReal,
				unlink: unlinkReal,
				writeFile: async (...a: Parameters<typeof writeFileReal>) => {
					calls.push("writeFile");
					return writeFileReal(...a);
				},
			};
			const io = fileIo(dir, ops);
			const appending = io.appendJournal('{"n":"new"}');
			await entered.promise;
			io.seal?.();
			gate.resolve();
			await appending;
			expect(calls).toEqual([]);
			expect(await readFileReal(join(dir, "journal.jsonl"), "utf8")).toBe(full);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a journal rotation sealed after its read writes nothing", async () => {
		const root = await mkdtemp(join(tmpdir(), "wifi-roaming-rot-"));
		const dir = join(root, "run");
		try {
			await mkdirReal(dir, { recursive: true });
			const full = `${Array.from({ length: JOURNAL_MAX_LINES }, (_, i) => `{"n":${i}}`).join("\n")}\n`;
			await writeFileReal(join(dir, "journal.jsonl"), full, { mode: 0o600 });
			const held = heldOps("readFile");
			const io = fileIo(dir, held.ops);
			const appending = io.appendJournal('{"n":"new"}');
			await held.entered;
			io.seal?.();
			held.release();
			await appending;
			expect(held.calls).not.toContain("writeFile");
			expect(held.calls).not.toContain("appendFile");
			expect(await readFileReal(join(dir, "journal.jsonl"), "utf8")).toBe(full);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("sealed file io", () => {
	test("a status write sealed while its file is written is never published", async () => {
		const root = await mkdtemp(join(tmpdir(), "wifi-roaming-seal-"));
		const dir = join(root, "run");
		try {
			const io = fileIo(dir);
			await io.writeStatus('{"v":1}\n');
			// Seal between the start of the write and its rename.
			const writing = io.writeStatus('{"v":2}\n');
			io.seal?.();
			await writing;
			expect(await readFile(join(dir, "status.json"), "utf8")).toBe(
				'{"v":1}\n',
			);
			await io.appendJournal('{"e":1}');
			expect(
				await readFile(join(dir, "journal.jsonl"), "utf8").catch(() => null),
			).toBeNull();
			const { readdir } = await import("node:fs/promises");
			expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual(
				[],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("stop seals the io", async () => {
		const f = fakeDeps();
		let sealed = 0;
		f.deps.io.seal = () => {
			sealed++;
		};
		const rt = createObserverRuntime(f.deps);
		await rt.stop();
		expect(sealed).toBe(1);
	});
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
