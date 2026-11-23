import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkInterface } from "../network-interfaces.ts";
import { fileCloneRegistry } from "./clone-registry.ts";
import type { CoordinatorPorts, CoordinatorStatus } from "./coordinator.ts";
import { isCoordinatorOwnedRadio } from "./ownership.ts";
import {
	countOtherUplinks,
	fileIo,
	initWifiRoaming,
	JOURNAL_MAX_LINES,
	journalEntry,
	lifetimeKey,
	type RoamingHandle,
	roamingBlocker,
	startRoaming,
	stopWifiRoaming,
} from "./runtime.ts";
import { protectRadiosFromScans, setScanGateModeReader } from "./scan-gate.ts";

afterEach(() => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
});

describe("boot gate", () => {
	const radios = [{ id: "a" }, { id: "b" }];
	test("off unless enabled; never next to the two-radio coordinator; needs two client radios", () => {
		expect(roamingBlocker(undefined, false)).toBe("disabled");
		expect(roamingBlocker({ enabled: false, radios }, false)).toBe("disabled");
		expect(roamingBlocker({ enabled: true, radios }, true)).toBe(
			"two-radio-coordinator-enabled",
		);
		expect(
			roamingBlocker(
				{
					enabled: true,
					radios: [{ id: "a" }, { id: "h", reserved: "hotspot" }],
				},
				false,
			),
		).toBe("needs-two-client-radios");
		expect(roamingBlocker({ enabled: true, radios }, false)).toBeNull();
	});
});

describe("pure parts", () => {
	test("a lifetime is one comparable string that changes on replug", () => {
		const l = { ifindex: 4, wiphy: 1, phyPath: "/sys/devices/x/phy1" };
		expect(lifetimeKey(l)).toBe(lifetimeKey({ ...l }));
		expect(lifetimeKey({ ...l, ifindex: 5 })).not.toBe(lifetimeKey(l));
	});

	test("other uplinks count bond candidates that are not coordinated radios", () => {
		const netif = {
			wlan1: {},
			wlan2: {},
			wwan0: {},
			eth0: {},
		} as unknown as Record<string, NetworkInterface>;
		const candidate = (name: string) => name !== "eth0";
		expect(
			countOtherUplinks(netif, new Set(["wlan1", "wlan2"]), candidate),
		).toBe(1);
	});

	const status = (
		over: Partial<CoordinatorStatus> = {},
		role = "holder",
	): CoordinatorStatus => ({
		radios: [
			{
				id: "a",
				ifname: "wlan1",
				present: true,
				role: role as CoordinatorStatus["radios"][number]["role"],
				bssid: null,
				ssid: null,
				diversity: null,
				joined: null,
				verified: false,
				bssidLocked: false,
			},
		],
		searches: 0,
		lastSearchAt: null,
		lastOutcome: null,
		swap: null,
		lastSwapOutcome: null,
		...over,
	});

	test("the journal records role and outcome changes, and nothing when nothing changed", () => {
		expect(journalEntry(status(), status(), 5)).toBeNull();
		expect(journalEntry(null, status(), 5)).toEqual({
			at: 5,
			roles: { a: "holder@wlan1" },
		});
		expect(
			journalEntry(
				status(),
				status({ lastOutcome: "joining:continuity" }, "searcher"),
				6,
			),
		).toEqual({
			at: 6,
			roles: { a: "searcher@wlan1" },
			outcome: "joining:continuity",
		});
		expect(
			journalEntry(status(), status({ lastSwapOutcome: "released" }), 7),
		).toEqual({
			at: 7,
			swap: "released",
		});
	});
});

describe("files in the run directory", () => {
	let dir = "";
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("status is replaced whole; the journal stays bounded", async () => {
		dir = await mkdtemp(join(tmpdir(), "roaming-"));
		const io = fileIo(dir);
		await io.writeStatus('{"n":1}');
		await io.writeStatus('{"n":2}');
		expect(await readFile(join(dir, "status.json"), "utf8")).toBe('{"n":2}');
		for (let i = 0; i < JOURNAL_MAX_LINES + 10; i++)
			await io.appendJournal(`{"i":${i}}`);
		const lines = (await readFile(join(dir, "journal.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBeLessThanOrEqual(JOURNAL_MAX_LINES);
		expect(lines.at(-1)).toBe(`{"i":${JOURNAL_MAX_LINES + 9}}`);
	});
});

describe("the loop", () => {
	/** Two idle client radios that observe as unassociated; nothing to do. */
	const fakePorts = (calls: string[]): CoordinatorPorts => ({
		now: () => 0,
		resolve: (id) => ({
			ifname: id === "a" ? "wlan1" : "wlan2",
			lifetime: "1",
		}),
		observe: async (ifname) => {
			calls.push(`observe:${ifname}`);
			return undefined;
		},
		scan: async () => undefined,
		savedSsids: async () => new Set(),
		join: async () => undefined,
		radioMode: async () => undefined,
		abandon: async () => true,
		uplinkOf: async () => ({
			gateway: null,
			gatewayMac: null,
			subnet: null,
			egress: null,
		}),
		holderHealth: () => ({
			signalDbm: null,
			attributedBps: null,
			encoderBps: null,
			nakRatio: null,
		}),
		otherUplinks: () => 0,
		holdOutOfBond: () => {},
		releaseBondHold: () => {},
		withRadioLock: async () => ({ ok: false }),
	});

	test("each round reads the sender, steps, and writes status; stop releases everything", async () => {
		const calls: string[] = [];
		const written: string[] = [];
		const journal: string[] = [];
		let fire: (() => void) | null = null;
		let cancelled = false;
		let closed = false;
		const h = startRoaming(
			{ enabled: true, radios: [{ id: "a" }, { id: "b" }] },
			() => ({
				ports: fakePorts(calls),
				sender: {
					poll: async () => {
						calls.push("poll");
					},
					close: () => {
						closed = true;
					},
				},
			}),
			{
				writeStatus: async (j) => {
					written.push(j);
				},
				appendJournal: async (l) => {
					journal.push(l);
				},
			},
			(fn) => {
				fire = fn;
				return {
					cancel: () => {
						cancelled = true;
					},
				};
			},
		);
		expect(fire).not.toBeNull();
		await h.round();
		await h.round();
		expect(calls.filter((c) => c === "poll").length).toBe(2);
		expect(calls[0]).toBe("poll");
		expect(written.length).toBe(2);
		expect(
			JSON.parse(written[1] as string).radios.map(
				(r: { ifname: string }) => r.ifname,
			),
		).toEqual(["wlan1", "wlan2"]);
		// The first round's roles are journalled; the unchanged second is not.
		expect(journal.length).toBe(1);
		expect(isCoordinatorOwnedRadio("wlan1")).toBe(true);
		await h.stop();
		expect(cancelled).toBe(true);
		expect(closed).toBe(true);
		expect(isCoordinatorOwnedRadio("wlan1")).toBe(false);
		await h.round();
		expect(written.length).toBe(2);
	});
});

describe("boot entry and loop hygiene", () => {
	const twoRadios = { enabled: true, radios: [{ id: "a" }, { id: "b" }] };
	const handle = (log: string[]): RoamingHandle =>
		({
			coordinator: {} as RoamingHandle["coordinator"],
			round: async () => {},
			stop: async () => {
				log.push("stopped");
			},
		}) as RoamingHandle;

	test("init starts only when allowed, once, and stopWifiRoaming stops it", async () => {
		const log: string[] = [];
		const start = () => {
			log.push("started");
			return handle(log);
		};
		await initWifiRoaming(undefined, false, start);
		await initWifiRoaming(twoRadios, true, start);
		await initWifiRoaming(
			{ enabled: true, radios: [{ id: "a" }, { id: "a" }] },
			false,
			start,
		);
		expect(log).toEqual([]);
		await initWifiRoaming(twoRadios, false, start);
		await initWifiRoaming(twoRadios, false, start);
		expect(log).toEqual(["started"]);
		await stopWifiRoaming();
		await stopWifiRoaming();
		expect(log).toEqual(["started", "stopped"]);
	});

	test("shutdown waits for a hung stop no longer than its deadline", async () => {
		let stopCalled = false;
		await initWifiRoaming(twoRadios, false, () => ({
			coordinator: {} as RoamingHandle["coordinator"],
			round: async () => {},
			stop: () => {
				stopCalled = true;
				return new Promise<void>(() => {
					// A round stuck in a NetworkManager call never settles.
				});
			},
		}));
		const started = performance.now();
		await stopWifiRoaming(30);
		expect(stopCalled).toBe(true);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	const quietPorts = (): CoordinatorPorts => ({
		now: () => 0,
		resolve: (id) => ({
			ifname: id === "a" ? "wlan1" : "wlan2",
			lifetime: "1",
		}),
		observe: async () => undefined,
		scan: async () => undefined,
		savedSsids: async () => new Set(),
		join: async () => undefined,
		radioMode: async () => undefined,
		abandon: async () => true,
		uplinkOf: async () => ({
			gateway: null,
			gatewayMac: null,
			subnet: null,
			egress: null,
		}),
		holderHealth: () => ({
			signalDbm: null,
			attributedBps: null,
			encoderBps: null,
			nakRatio: null,
		}),
		otherUplinks: () => 0,
		holdOutOfBond: () => {},
		releaseBondHold: () => {},
		withRadioLock: async () => ({ ok: false }),
	});

	test("a timer tick during a long round is skipped, not run alongside", async () => {
		const poll = Promise.withResolvers<void>();
		let polls = 0;
		let fire: (() => void) | null = null;
		const h = startRoaming(
			twoRadios,
			() => ({
				ports: quietPorts(),
				sender: {
					poll: () => {
						polls++;
						return poll.promise;
					},
					close: () => {},
				},
			}),
			{ writeStatus: async () => {}, appendJournal: async () => {} },
			(fn) => {
				fire = fn;
				return { cancel: () => {} };
			},
		);
		(fire as unknown as () => void)();
		(fire as unknown as () => void)();
		await Promise.resolve();
		expect(polls).toBe(1);
		poll.resolve();
		await h.stop();
	});

	test("a failed journal line is kept and written first, even if the change it records reverted", async () => {
		const lines: string[] = [];
		let fail = false;
		const names = new Map([
			["a", "wlan1"],
			["b", "wlan2"],
		]);
		const ports = {
			...quietPorts(),
			resolve: (id: string) => {
				const ifname = names.get(id);
				return ifname ? { ifname, lifetime: "1" } : undefined;
			},
		};
		const h = startRoaming(
			twoRadios,
			() => ({ ports, sender: { poll: async () => {}, close: () => {} } }),
			{
				writeStatus: async () => {},
				appendJournal: async (l) => {
					if (fail) {
						fail = false;
						throw new Error("disk full");
					}
					lines.push(l);
				},
			},
			() => ({ cancel: () => {} }),
		);
		await h.round(); // the first roles go out
		names.set("a", "wlan5"); // a rename, whose line fails
		fail = true;
		await h.round();
		names.set("a", "wlan1"); // and back again
		await h.round();
		const roles = lines.map((l) => JSON.parse(l).roles?.a);
		expect(roles).toEqual([
			"searcher@wlan1",
			"searcher@wlan5",
			"searcher@wlan1",
		]);
		await h.stop();
	});

	test("stop drains the round's status and journal writes", async () => {
		const events: string[] = [];
		const status = Promise.withResolvers<void>();
		const h = startRoaming(
			twoRadios,
			() => ({
				ports: quietPorts(),
				sender: { poll: async () => {}, close: () => events.push("close") },
			}),
			{
				writeStatus: async () => {
					events.push("status-start");
					await status.promise;
					events.push("status-done");
				},
				appendJournal: async () => {
					events.push("journal");
				},
			},
			() => ({ cancel: () => {} }),
		);
		const round = h.round();
		await Bun.sleep(5);
		const stopped = h.stop().then(() => events.push("stopped"));
		await Bun.sleep(5);
		expect(events).toEqual(["status-start"]);
		status.resolve();
		await Promise.all([round, stopped]);
		expect(events).toEqual([
			"status-start",
			"status-done",
			"journal",
			"close",
			"stopped",
		]);
	});
});

describe("the clone record in /run", () => {
	let dir = "";
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("survives a new instance (a restart), and concurrent writes lose nothing", async () => {
		dir = await mkdtemp(join(tmpdir(), "clones-"));
		const path = join(dir, "clones.json");
		const a = fileCloneRegistry(path);
		await Promise.all(["u1", "u2", "u3"].map((u) => a.add(u)));
		await a.remove("u2");
		const b = fileCloneRegistry(path);
		expect([...(await b.list())].sort()).toEqual(["u1", "u3"]);
		expect(await b.has("u1")).toBe(true);
		expect(await b.has("u2")).toBe(false);
	});
});
