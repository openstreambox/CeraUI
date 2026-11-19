/**
 * Recovery after a bind-map publication times out or fails, and the reload a
 * launch is owed.
 *
 * - a republication that times out again, or a write that fails, is retried on
 *   a capped backoff until the newest snapshot is on disk or a newer
 *   submission supersedes it; the stale state is visible while it lasts;
 * - storage that hangs for good holds at most two abandoned attempts' file
 *   operations, and every caller still gets an answer within its deadline;
 * - a writer repair after uncertain disk state always reports `changed`;
 * - a timed-out publication never registers rows that were not written;
 * - a reload delivery that never settles cannot wedge later reloads;
 * - a publication that lands after the launch read its bond, but before the
 *   launch is committed as streaming, is reloaded once it commits.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import { logger } from "../helpers/logger.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	defaultBindMapSpawnDeps,
	resolveBindMapArgs,
} from "../modules/streaming/bind-map-spawn.ts";
import {
	BIND_MAP_RETRY_DELAYS_MS,
	type BindMapPublication,
	type BindMapWriterDeps,
	getBindMapPublicationHealth,
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import {
	noteSenderLaunchBond,
	publishSrtlaBond,
	reloadOwedAtLaunchCommit,
	resetPublishedBond,
	resetSrtlaReloadForTest,
	restartSrtla,
} from "../modules/streaming/srtla.ts";

const IPS = "/tmp/recovery-ips";
const MAP = "/tmp/recovery-map";

interface SidecarDocument {
	readonly generation: number;
	readonly ips_file_sha256: string;
	readonly links: readonly { readonly iface: string }[];
}

/** An in-memory filesystem that records every effect in order. */
function memoryFs(deadlineMs = 20) {
	const files = new Map<string, string>();
	const documents: SidecarDocument[] = [];
	const deps = {
		ipsFile: IPS,
		sidecarFile: MAP,
		deadlineMs,
		writeFile: async (path: string, bytes: string) => {
			files.set(path, bytes);
			if (path.startsWith(MAP)) documents.push(JSON.parse(bytes));
		},
		renameFile: async (from: string, to: string) => {
			const bytes = files.get(from);
			if (bytes === undefined) throw new Error(`ENOENT ${from}`);
			files.delete(from);
			files.set(to, bytes);
		},
		removeFile: async (path: string) => {
			files.delete(path);
		},
	} satisfies BindMapWriterDeps;
	const sidecar = (): SidecarDocument => JSON.parse(files.get(MAP) ?? "null");
	return { files, documents, deps, sidecar };
}

const link = (iface: string, ip = "192.0.2.1"): BondEntry[] => [
	{ ip, iface, linkId: "lnk_example" },
];

const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

function expectOneDocumentPerGeneration(documents: readonly SidecarDocument[]) {
	const byGeneration = new Map<number, string>();
	for (const document of documents) {
		const body = JSON.stringify([document.links, document.ips_file_sha256]);
		const seen = byGeneration.get(document.generation);
		if (seen !== undefined) expect(body).toBe(seen);
		byGeneration.set(document.generation, body);
	}
}

/** Wait for a condition the writer reaches on its own timers, with a bound. */
async function eventually(condition: () => boolean, withinMs = 2_000) {
	const until = performance.now() + withinMs;
	while (!condition()) {
		if (performance.now() > until) throw new Error("condition not reached");
		await Bun.sleep(5);
	}
}

const notStreaming = { isStreaming: async () => false, retryDelayMs: 0 };

let errors: Mock<(...args: unknown[]) => unknown>;
let infos: Mock<(...args: unknown[]) => unknown>;
let quiet: Mock<(...args: unknown[]) => unknown>[] = [];
beforeEach(() => {
	errors = spyOn(logger, "error").mockImplementation(() => logger) as Mock<
		(...args: unknown[]) => unknown
	>;
	infos = spyOn(logger, "info").mockImplementation(() => logger) as Mock<
		(...args: unknown[]) => unknown
	>;
	quiet = [
		errors,
		infos,
		spyOn(logger, "warn").mockImplementation(() => logger) as Mock<
			(...args: unknown[]) => unknown
		>,
	];
	resetBindMapWriter();
	resetPublishedBond();
	resetSrtlaReloadForTest();
});
afterEach(() => {
	resetBindMapWriter();
	resetSrtlaReloadForTest();
	for (const spy of quiet) spy.mockRestore();
});

const logged = (spy: Mock<(...args: unknown[]) => unknown>, text: string) =>
	spy.mock.calls.some(([message]) => String(message).includes(text));

describe("a publication that stays stale", () => {
	test("a republication that also times out is retried until the newest snapshot lands", async () => {
		const fs = memoryFs();
		// What the previous session left on disk.
		await publishBondMapping(link("eth0", "192.0.2.1"), fs.deps);
		let stalls = 2;
		const deps = {
			...fs.deps,
			retryDelaysMs: [30],
			writeFile: async (path: string, bytes: string) => {
				if (stalls > 0 && path.startsWith(IPS)) {
					stalls -= 1;
					await Bun.sleep(60); // storage recovers after the deadline
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		expect(
			await publishBondMapping(link("eth0", "192.0.2.2"), deps),
		).toMatchObject({ ok: false, reason: "timed_out" });
		expect(getBindMapPublicationHealth().stale).toBe(true);

		await eventually(() => !getBindMapPublicationHealth().stale);
		expect(fs.files.get(IPS)).toBe("192.0.2.2");
		expect(fs.sidecar().ips_file_sha256).toBe(sha256("192.0.2.2"));
		expectOneDocumentPerGeneration(fs.documents);
	});

	test("a failed write is retried on a capped backoff and the stale state is visible meanwhile", async () => {
		const fs = memoryFs();
		const attempts: number[] = [];
		let failures = 3;
		const deps = {
			...fs.deps,
			retryDelaysMs: [10, 20, 40],
			writeFile: async (path: string, bytes: string) => {
				if (path.startsWith(IPS)) {
					attempts.push(performance.now());
					if (failures > 0) {
						failures -= 1;
						throw new Error("EIO");
					}
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		expect(await publishBondMapping(link("eth0"), deps)).toMatchObject({
			ok: false,
			reason: "ips_write_failed",
		});
		expect(getBindMapPublicationHealth()).toMatchObject({
			stale: true,
			lastFailure: "ips_write_failed",
			retryScheduled: true,
		});
		expect(logged(errors, "stale")).toBe(true);

		await eventually(() => !getBindMapPublicationHealth().stale);
		expect(attempts).toHaveLength(4);
		const gaps = attempts.slice(1).map((at, i) => at - (attempts[i] ?? 0));
		expect(gaps[0]).toBeGreaterThanOrEqual(9);
		expect(gaps[1]).toBeGreaterThanOrEqual(19);
		expect(gaps[2]).toBeGreaterThanOrEqual(39);
		expect(fs.sidecar().links[0]?.iface).toBe("eth0");
		expect(getBindMapPublicationHealth()).toMatchObject({
			stale: false,
			failures: 0,
			retryScheduled: false,
		});
		expect(logged(infos, "current again")).toBe(true);
	});

	test("storage that keeps failing is retried on its capped schedule, never in a busy loop", async () => {
		expect(BIND_MAP_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000, 60_000]);
		const fs = memoryFs();
		let attempts = 0;
		const deps = {
			...fs.deps,
			retryDelaysMs: [5, 10, 20],
			writeFile: async (path: string) => {
				if (path.startsWith(IPS)) attempts += 1;
				throw new Error("EIO");
			},
		};
		await publishBondMapping(link("eth0"), deps);
		await Bun.sleep(150);
		// 0, +5, +10, then every 20 ms: about nine in 150 ms.
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(attempts).toBeLessThanOrEqual(12);
		expect(getBindMapPublicationHealth().stale).toBe(true);
		resetBindMapWriter();
		const after = attempts;
		await Bun.sleep(50);
		expect(attempts).toBe(after);
	});

	test("a newer submission supersedes a scheduled retry", async () => {
		const fs = memoryFs();
		let fail = true;
		let writes = 0;
		const deps = {
			...fs.deps,
			retryDelaysMs: [40],
			writeFile: async (path: string, bytes: string) => {
				writes += 1;
				if (fail && path.startsWith(IPS)) {
					fail = false;
					throw new Error("EIO");
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		expect((await publishBondMapping(link("wwan0"), deps)).ok).toBe(false);
		expect((await publishBondMapping(link("eth0"), deps)).ok).toBe(true);
		expect(getBindMapPublicationHealth().stale).toBe(false);
		const settled = writes;
		await Bun.sleep(80);
		expect(writes).toBe(settled);
		expect(fs.sidecar().links[0]?.iface).toBe("eth0");
	});
});

describe("a late rename during a newer publication", () => {
	test("is repaired even though the newer publication itself succeeded", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0", "192.0.2.1"), fs.deps);
		const releaseLate = Promise.withResolvers<void>(),
			releaseNewer = Promise.withResolvers<void>(),
			newerHeld = Promise.withResolvers<void>();
		let holdLate = true,
			holdNewer = true;
		const deps = {
			...fs.deps,
			renameFile: async (from: string, to: string) => {
				if (holdLate && to === IPS) {
					holdLate = false; // the stale write's IP rename lands much later
					await releaseLate.promise;
				}
				const bytes = fs.files.get(from) ?? "";
				if (holdNewer && to === MAP && bytes.includes(sha256("192.0.2.3"))) {
					holdNewer = false; // the newer publication is between its renames
					newerHeld.resolve();
					await releaseNewer.promise;
				}
				await fs.deps.renameFile(from, to);
			},
		};
		expect(
			await publishBondMapping(link("wwan0", "192.0.2.2"), deps),
		).toMatchObject({ reason: "timed_out" });
		const newer = publishBondMapping(link("eth1", "192.0.2.3"), deps);
		await newerHeld.promise;
		expect(fs.files.get(IPS)).toBe("192.0.2.3");
		// The abandoned 192.0.2.2 rename lands over the newer IP list ...
		releaseLate.resolve();
		await Bun.sleep(5);
		expect(fs.files.get(IPS)).toBe("192.0.2.2");
		// ... and only then does the newer publication commit its sidecar.
		releaseNewer.resolve();
		expect((await newer).ok).toBe(true);
		await eventually(() => !getBindMapPublicationHealth().stale);
		expect(fs.files.get(IPS)).toBe("192.0.2.3");
		expect(fs.sidecar().ips_file_sha256).toBe(sha256("192.0.2.3"));
		expect(fs.sidecar().links[0]?.iface).toBe("eth1");
		expectOneDocumentPerGeneration(fs.documents);
	});
});

for (const capped of [false, true]) {
	test(`overlapped successful publication repairs immediately (capped=${capped})`, async () => {
		const fs = memoryFs(200);
		await publishBondMapping(link("eth0", "192.0.2.1"), fs.deps);
		const releaseLate = Promise.withResolvers<void>(),
			releaseNewer = Promise.withResolvers<void>(),
			newerHeld = Promise.withResolvers<void>();
		let warming = capped;
		let failures = 0;
		const repaired: BindMapPublication[] = [];
		let holdLate = true,
			holdNewer = true;
		const deps: BindMapWriterDeps = {
			...fs.deps,
			...(capped ? { retryDelaysMs: [100, 200, 1_000] } : {}),
			onSettled: (_entries, publication, { republished }) => {
				if (republished && publication.ok) repaired.push(publication);
			},
			writeFile: async (path: string, bytes: string) => {
				if (warming) {
					failures += 1;
					throw new Error("EIO");
				}
				await fs.deps.writeFile(path, bytes);
			},
			renameFile: async (from: string, to: string) => {
				if (holdLate && to === IPS) {
					holdLate = false; // the stale write's IP rename lands much later
					await releaseLate.promise;
				}
				const bytes = fs.files.get(from) ?? "";
				if (holdNewer && to === MAP && bytes.includes(sha256("192.0.2.3"))) {
					holdNewer = false; // the newer publication is between its renames
					newerHeld.resolve();
					await releaseNewer.promise;
				}
				await fs.deps.renameFile(from, to);
			},
		};
		if (capped) {
			await publishBondMapping(link("wwan0", "192.0.2.2"), deps);
			// Four failures schedule 100/200/1000/1000 ms: the backoff is capped.
			await eventually(() => failures >= 4, 4_000);
			expect(getBindMapPublicationHealth().retryScheduled).toBe(true);
			warming = false;
		}
		expect(
			await publishBondMapping(link("wwan0", "192.0.2.2"), deps),
		).toMatchObject({ reason: "timed_out" });
		const newer = publishBondMapping(link("eth1", "192.0.2.3"), deps);
		await newerHeld.promise;
		expect(fs.files.get(IPS)).toBe("192.0.2.3");
		// The abandoned 192.0.2.2 rename lands over the newer IP list ...
		releaseLate.resolve();
		await eventually(
			() => getBindMapPublicationHealth().abandonedUnsettled === 0,
		);
		expect(fs.files.get(IPS)).toBe("192.0.2.2");
		// ... and only then does the newer publication commit its sidecar.
		releaseNewer.resolve();
		expect((await newer).ok).toBe(true);
		// Neither the production 2 s step nor the scaled 1 s cap may delay repair.
		await eventually(() => !getBindMapPublicationHealth().stale, 250);
		expect(repaired).toContainEqual(expect.objectContaining({ changed: true }));
		expect(fs.files.get(IPS)).toBe("192.0.2.3");
		expect(fs.sidecar().ips_file_sha256).toBe(sha256("192.0.2.3"));
		expect(fs.sidecar().links[0]?.iface).toBe("eth1");
		expectOneDocumentPerGeneration(fs.documents);
	});
}

describe("random stalls, late wakes and write errors", () => {
	/** Small seeded generator, so a failing run can be replayed by its seed. */
	const generator = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};

	test("60 seeded runs all end with the newest snapshot on disk at the highest generation", async () => {
		const choices = [
			link("eth0", "192.0.2.1"),
			link("eth1", "192.0.2.1"),
			link("wwan0", "192.0.2.2"),
			[...link("eth0", "192.0.2.1"), ...link("wwan0", "192.0.2.2")],
		];
		for (let seed = 1; seed <= 60; seed += 1) {
			resetBindMapWriter();
			const random = generator(seed);
			const fs = memoryFs(6);
			let faulty = 40; // file operations that may stall or fail
			const disturb = async () => {
				if (faulty <= 0) return;
				faulty -= 1;
				const roll = random();
				if (roll < 0.1) throw new Error("EIO");
				if (roll < 0.45) await Bun.sleep(Math.floor(random() * 15));
			};
			const deps = {
				...fs.deps,
				retryDelaysMs: [3],
				writeFile: async (path: string, bytes: string) => {
					await disturb();
					await fs.deps.writeFile(path, bytes);
				},
				renameFile: async (from: string, to: string) => {
					await disturb();
					await fs.deps.renameFile(from, to);
				},
			};
			const receipts: Promise<BindMapPublication>[] = [];
			let last: BondEntry[] = [];
			for (let i = 0; i < 8; i += 1) {
				last = choices[Math.floor(random() * choices.length)] ?? [];
				receipts.push(publishBondMapping(last, deps));
				await Bun.sleep(Math.floor(random() * 8));
			}
			await Promise.all(receipts);
			await eventually(() => {
				const health = getBindMapPublicationHealth();
				return !health.stale && health.abandonedUnsettled === 0;
			}, 3_000);
			const expected = last.map((entry) => entry.ip).join("\n");
			const label = `seed ${seed}`;
			expect([label, fs.files.get(IPS)]).toEqual([label, expected]);
			const sidecar = fs.sidecar();
			expect([label, sidecar.links.map((row) => row.iface)]).toEqual([
				label,
				last.map((entry) => entry.iface),
			]);
			expect([label, sidecar.ips_file_sha256]).toEqual([
				label,
				sha256(expected),
			]);
			const highest = Math.max(...fs.documents.map((d) => d.generation));
			expect([label, sidecar.generation]).toEqual([label, highest]);
			expectOneDocumentPerGeneration(fs.documents);
		}
	}, 30_000);
});

describe("storage that hangs for good", () => {
	test("holds at most two abandoned attempts' file operations and still answers every caller", async () => {
		const fs = memoryFs(10);
		await publishBondMapping(link("eth0"), fs.deps);
		let outstanding = 0;
		let peak = 0;
		const deps = {
			...fs.deps,
			retryDelaysMs: [5],
			writeFile: () => {
				outstanding += 1;
				peak = Math.max(peak, outstanding);
				return new Promise<void>(() => {});
			},
		};
		const receipts: BindMapPublication[] = [];
		for (let i = 0; i < 8; i += 1) {
			const started = performance.now();
			receipts.push(
				await publishBondMapping(link(i % 2 ? "eth0" : "wwan0"), deps),
			);
			// One deadline, plus at most one more while waiting behind a live write.
			expect(performance.now() - started).toBeLessThan(200);
		}
		await Bun.sleep(40);
		for (const receipt of receipts) {
			expect(receipt).toMatchObject({ ok: false, reason: "timed_out" });
		}
		expect(peak).toBeLessThanOrEqual(2);
		expect(getBindMapPublicationHealth()).toMatchObject({
			stale: true,
			abandonedUnsettled: 2,
		});
	});
});

describe("a repair after uncertain disk state", () => {
	test("reports changed even when the snapshot cannot be mapped", async () => {
		const fs = memoryFs();
		const unmappable: BondEntry[] = [{ ip: "192.0.2.1", iface: "eth0" }];
		expect(await publishBondMapping(unmappable, fs.deps)).toMatchObject({
			ok: false,
			reason: "unmappable",
			changed: true,
		});
		let hang = true;
		const republished: BindMapPublication[] = [];
		const deps = {
			...fs.deps,
			renameFile: async (from: string, to: string) => {
				if (hang && to === IPS) {
					hang = false;
					await Bun.sleep(40);
				}
				await fs.deps.renameFile(from, to);
			},
			onSettled: (
				_entries: readonly BondEntry[],
				publication: BindMapPublication,
				origin: { readonly republished: boolean },
			) => {
				if (origin.republished) republished.push(publication);
			},
		};
		expect(await publishBondMapping(unmappable, deps)).toMatchObject({
			reason: "timed_out",
		});
		await eventually(() => republished.length > 0);
		await Bun.sleep(50); // the late rename lands and is repaired too
		for (const publication of republished) {
			expect(publication).toMatchObject({
				ok: false,
				reason: "unmappable",
				changed: true,
			});
		}
	});
});

describe("telemetry after a timeout", () => {
	test("rows that were never written are not registered", async () => {
		const fs = memoryFs(10);
		const registered: string[][] = [];
		const options = {
			...notStreaming,
			registerBond: (entries: readonly BondEntry[]) =>
				registered.push(entries.map((entry) => entry.iface)),
		};
		// A written publication registers its rows ...
		expect((await publishSrtlaBond(link("eth0"), fs.deps, options)).ok).toBe(
			true,
		);
		expect(registered).toEqual([["eth0"]]);
		const deps = {
			...fs.deps,
			retryDelaysMs: [1_000],
			writeFile: () => new Promise<void>(() => {}),
		};
		// ... one that timed out keeps the rows the sender can still be reading.
		expect(await publishSrtlaBond(link("wwan0"), deps, options)).toMatchObject({
			reason: "timed_out",
		});
		await Bun.sleep(40);
		expect(registered).toEqual([["eth0"]]);
	});
});

describe("reload delivery", () => {
	test("a delivery that never settles cannot wedge later reloads", async () => {
		const first = restartSrtla(() => new Promise<boolean>(() => {}), {
			...notStreaming,
			deliveryDeadlineMs: 20,
		});
		expect(
			await Promise.race([first, Bun.sleep(500).then(() => "wedged")]),
		).toBe(false);
		let delivered = 0;
		const next = restartSrtla(
			async () => {
				delivered += 1;
				return true;
			},
			{ ...notStreaming, deliveryDeadlineMs: 20 },
		);
		expect(
			await Promise.race([next, Bun.sleep(500).then(() => "wedged")]),
		).toBe(true);
		expect(delivered).toBe(1);
	});
});

describe("the reload a launch is owed", () => {
	const counting = () => {
		let deliveries = 0;
		return {
			deliver: async () => {
				deliveries += 1;
				return true;
			},
			get count() {
				return deliveries;
			},
		};
	};

	test("a refresh that lands before the launch commits is reloaded once it commits", async () => {
		const fs = memoryFs();
		await publishSrtlaBond(link("eth0"), fs.deps, notStreaming); // the launch's own
		noteSenderLaunchBond(); // the spawn read the bond
		// Not streaming yet, so the refresh's caller does not signal.
		expect(
			(await publishSrtlaBond(link("wwan0"), fs.deps, notStreaming)).changed,
		).toBe(true);
		const reload = counting();
		expect(
			await reloadOwedAtLaunchCommit(() => true, reload.deliver, notStreaming),
		).toBe(true);
		expect(reload.count).toBe(1);
		// Owed once: a second commit check does not signal again.
		expect(
			await reloadOwedAtLaunchCommit(() => true, reload.deliver, notStreaming),
		).toBe(false);
		expect(reload.count).toBe(1);
	});

	test("nothing is owed when no publication changed since the spawn read the bond", async () => {
		const fs = memoryFs();
		await publishSrtlaBond(link("eth0"), fs.deps, notStreaming);
		noteSenderLaunchBond();
		expect(
			(await publishSrtlaBond(link("eth0"), fs.deps, notStreaming)).changed,
		).toBe(false);
		const reload = counting();
		expect(
			await reloadOwedAtLaunchCommit(() => true, reload.deliver, notStreaming),
		).toBe(false);
		expect(reload.count).toBe(0);
	});

	test("a launch that is no longer current does not signal", async () => {
		const fs = memoryFs();
		await publishSrtlaBond(link("eth0"), fs.deps, notStreaming);
		noteSenderLaunchBond();
		await publishSrtlaBond(link("wwan0"), fs.deps, notStreaming);
		const reload = counting();
		expect(
			await reloadOwedAtLaunchCommit(() => false, reload.deliver, notStreaming),
		).toBe(false);
		expect(reload.count).toBe(0);
	});

	test("a launch on a timed-out publication is reloaded at commit once the retry lands", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0", "192.0.2.1"), fs.deps);
		let stalls = 2;
		const deps = {
			...fs.deps,
			retryDelaysMs: [30],
			writeFile: async (path: string, bytes: string) => {
				if (stalls > 0 && path.startsWith(IPS)) {
					stalls -= 1;
					await Bun.sleep(60);
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		const writerReloads: BindMapPublication[] = [];
		expect(
			await publishSrtlaBond(link("eth0", "192.0.2.2"), deps, {
				...notStreaming,
				reload: async (publication) => {
					writerReloads.push(publication);
				},
			}),
		).toMatchObject({ reason: "timed_out" });
		noteSenderLaunchBond(); // the sender starts on the unconfirmed list
		await eventually(() => !getBindMapPublicationHealth().stale);
		expect(fs.files.get(IPS)).toBe("192.0.2.2");
		expect(writerReloads).toEqual([]); // still not streaming
		const reload = counting();
		expect(
			await reloadOwedAtLaunchCommit(() => true, reload.deliver, notStreaming),
		).toBe(true);
		expect(reload.count).toBe(1);
	});

	test("the spawn records the bond it launches with, also on a failed publication", async () => {
		let noted = 0;
		const deps = {
			...defaultBindMapSpawnDeps(() => undefined),
			noteLaunch: () => {
				noted += 1;
			},
			probe: async () => ({ bindMap: true }) as const,
			announce: () => {},
		};
		expect(await resolveBindMapArgs("unused", deps)).toEqual([]);
		expect(noted).toBe(1);
		expect(defaultBindMapSpawnDeps(() => undefined).noteLaunch).toBe(
			noteSenderLaunchBond,
		);
	});

	test("a launch on a timed-out publication says it starts on an unconfirmed list", async () => {
		const warn = quiet[2] as Mock<(...args: unknown[]) => unknown>;
		await resolveBindMapArgs("unused", {
			getBond: () => ({
				entries: link("eth0"),
				publication: { ok: false, reason: "timed_out", changed: false },
			}),
			probe: async () => ({ bindMap: true }),
			announce: () => {},
		});
		expect(logged(warn, "unconfirmed")).toBe(true);
	});

	test("the production commit hook asks for the owed reload", async () => {
		const owed = spyOn(srtla, "reloadOwedAtLaunchCommit").mockImplementation(
			async () => false,
		);
		try {
			const { streamSessionProductionDeps } = await import(
				"../modules/streaming/stream-session-production.ts"
			);
			streamSessionProductionDeps.onStreamCommitted?.(() => false);
			await eventually(() => owed.mock.calls.length > 0, 1_000);
		} finally {
			owed.mockRestore();
		}
	});
});

for (const streaming of [true, false]) {
	test(`failed IP writes neither reload nor accrue a launch reload (streaming=${streaming})`, async () => {
		const fs = memoryFs();
		await publishSrtlaBond(link("eth0"), fs.deps, notStreaming);
		noteSenderLaunchBond();
		let attempts = 0;
		let reloads = 0;
		const deps = {
			...fs.deps,
			retryDelaysMs: [10],
			writeFile: async () => {
				attempts += 1;
				throw new Error("EIO");
			},
		};
		await publishSrtlaBond(link("wwan0"), deps, {
			isStreaming: async () => streaming,
			reload: async () => {
				reloads += 1;
			},
		});
		await eventually(() => attempts >= 3);
		expect(reloads).toBe(0);
		let deliveries = 0;
		expect(
			await reloadOwedAtLaunchCommit(
				() => true,
				async () => {
					deliveries += 1;
					return true;
				},
				notStreaming,
			),
		).toBe(false);
		expect(deliveries).toBe(0);
		expect(fs.files.get(IPS)).toBe("192.0.2.1");
	});
}

test("repeated late renames retain capped backoff and recover after storage settles", async () => {
	const fs = memoryFs(20);
	const attempts: number[] = [];
	let slow = true;
	const deps = {
		...fs.deps,
		retryDelaysMs: [50, 100, 150],
		renameFile: async (from: string, to: string) => {
			if (to === IPS) {
				attempts.push(performance.now());
				if (slow) await Bun.sleep(30);
			}
			await fs.deps.renameFile(from, to);
		},
	};
	await publishBondMapping(link("eth0"), deps);
	await eventually(() => attempts.length >= 6);
	const gaps = attempts.slice(1).map((at, i) => at - (attempts[i] ?? 0));
	// One immediate retry is allowed; subsequent retries reach and retain the cap.
	expect(gaps.at(-1)).toBeGreaterThanOrEqual(145);
	expect(gaps.at(-2)).toBeGreaterThanOrEqual(145);
	slow = false;
	await eventually(() => !getBindMapPublicationHealth().stale);
	expect(fs.files.get(IPS)).toBe("192.0.2.1");
	expect(fs.sidecar().links[0]?.iface).toBe("eth0");
});
