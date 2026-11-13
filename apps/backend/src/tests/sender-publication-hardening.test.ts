/**
 * Hardening for the serialized bind-map publisher and the reload that follows it.
 *
 * - a write that never settles must not stall later publications or stream start,
 *   and a late rename from the abandoned write must never be the last one to land;
 * - a flapping interface must not turn into one fsynced write and one SIGHUP per
 *   event (one publication in flight, one pending slot, latest wins);
 * - a failed reload gets one bounded re-signal while the stream is still live;
 * - strict capability flags count only alongside exactly contract 2;
 * - publications and the bond record they leave behind complete in submission order;
 * - the delivery seam a tracked-PID reload plugs into keeps the failed-delivery
 *   invalidation.
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
import { logger } from "../helpers/logger.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	type BindMapPublication,
	type BindMapWriterDeps,
	publishBondMapping,
	resetBindMapWriter,
	whenBindMapWriterIdle,
} from "../modules/streaming/bind-map-writer.ts";
import {
	getLastPublishedBond,
	publishSrtlaBond,
	resetPublishedBond,
	resetSrtlaReloadForTest,
	restartSrtla,
	supervisedSenderDelivery,
} from "../modules/streaming/srtla.ts";
import { classifyCapabilityDocument } from "../modules/streaming/srtla-capabilities.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/srtla-ip-preparation.ts";

const IPS = "/tmp/hardening-ips";
const MAP = "/tmp/hardening-map";

interface SidecarDocument {
	readonly generation: number;
	readonly ips_file_sha256: string;
	readonly links: readonly { readonly iface: string }[];
}

/** An in-memory filesystem that records every effect in order. */
function memoryFs(deadlineMs = 25) {
	const files = new Map<string, string>();
	const writes: string[] = [];
	const renames: string[] = [];
	const documents: SidecarDocument[] = [];
	const deps = {
		ipsFile: IPS,
		sidecarFile: MAP,
		deadlineMs,
		writeFile: async (path: string, bytes: string) => {
			writes.push(path);
			files.set(path, bytes);
			if (path.startsWith(MAP)) documents.push(JSON.parse(bytes));
		},
		renameFile: async (from: string, to: string) => {
			const bytes = files.get(from);
			if (bytes === undefined) throw new Error(`ENOENT ${from}`);
			renames.push(from);
			files.delete(from);
			files.set(to, bytes);
		},
		removeFile: async (path: string) => {
			files.delete(path);
		},
	} satisfies BindMapWriterDeps;
	const sidecar = (): SidecarDocument => JSON.parse(files.get(MAP) ?? "null");
	return { files, writes, renames, documents, deps, sidecar };
}

const link = (iface: string, ip = "192.0.2.1"): BondEntry[] => [
	{ ip, iface, linkId: "lnk_example" },
];

/** Every generation the writer ever produced names exactly one document. */
function expectOneDocumentPerGeneration(documents: readonly SidecarDocument[]) {
	const byGeneration = new Map<number, string>();
	for (const document of documents) {
		const body = JSON.stringify(document.links);
		const seen = byGeneration.get(document.generation);
		if (seen !== undefined) expect(body).toBe(seen);
		byGeneration.set(document.generation, body);
	}
}

const notStreaming = { isStreaming: async () => false, retryDelayMs: 0 };
const streaming = { isStreaming: async () => true, retryDelayMs: 0 };

// Timeouts and failed deliveries are expected here; keep the run quiet.
let quiet: Mock<(...args: unknown[]) => unknown>[] = [];
beforeEach(() => {
	quiet = [
		spyOn(logger, "error").mockImplementation(() => logger),
		spyOn(logger, "warn").mockImplementation(() => logger),
	] as Mock<(...args: unknown[]) => unknown>[];
	resetBindMapWriter();
	resetPublishedBond();
	resetSrtlaReloadForTest();
});
afterEach(() => {
	resetBindMapWriter();
	resetSrtlaReloadForTest();
	for (const spy of quiet) spy.mockRestore();
});

describe("a publication that never settles", () => {
	test("times out with a failure receipt and does not stall later publications or stream start", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0"), fs.deps);
		let hang = true;
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (hang && path.startsWith(IPS)) {
					hang = false;
					return new Promise<void>(() => {});
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		const stuck = publishBondMapping(link("wwan0"), deps);
		// Stream start awaits the same chain.
		const start = prepareSrtlaIpAddresses("198.51.100.7", {
			isLocal: () => false,
			localList: () => [],
			bondedList: () => link("eth1"),
			writeList: (entries) => publishBondMapping(entries, deps),
		});
		expect(await stuck).toEqual({
			ok: false,
			reason: "timed_out",
			changed: false,
		});
		const started = await start;
		expect(started.ok && started.changed).toBe(true);
		expect(fs.sidecar().links[0]?.iface).toBe("eth1");
		expect(fs.files.get(IPS)).toBe("192.0.2.1");
	});

	test("clears reuse and republishes the newest snapshot when nothing newer is queued", async () => {
		const fs = memoryFs();
		const first = await publishBondMapping(link("eth0"), fs.deps);
		let hang = true;
		const republished: BindMapPublication[] = [];
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (hang && path.startsWith(IPS)) {
					hang = false;
					return new Promise<void>(() => {});
				}
				await fs.deps.writeFile(path, bytes);
			},
			onSettled: (
				_entries: readonly BondEntry[],
				publication: BindMapPublication,
				origin: { readonly republished: boolean },
			) => {
				if (origin.republished) republished.push(publication);
			},
		};
		// The same mapping that already succeeded: without the timeout clearing
		// reuse, the republication would be a silent no-op at generation 1.
		expect((await publishBondMapping(link("eth0"), deps)).ok).toBe(false);
		await whenBindMapWriterIdle();
		expect(republished).toHaveLength(1);
		const [again] = republished;
		expect(again?.ok && again.changed).toBe(true);
		expect(again?.ok && first.ok && again.generation > first.generation).toBe(
			true,
		);
		expect(fs.sidecar().generation).toBe(again?.ok ? again.generation : -1);
	});

	test("a hung IP write that wakes after its deadline never renames into place", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0"), fs.deps);
		const release = Promise.withResolvers<void>();
		let hang = true;
		let abandonedTemp = "";
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (hang && path.startsWith(IPS)) {
					hang = false;
					abandonedTemp = path;
					await release.promise;
					fs.files.set(path, "198.51.100.99");
					return;
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		expect((await publishBondMapping(link("wwan0"), deps)).ok).toBe(false);
		const next = await publishBondMapping(link("eth1"), deps);
		release.resolve();
		await whenBindMapWriterIdle();
		await Bun.sleep(5);
		await whenBindMapWriterIdle();
		expect(fs.renames).not.toContain(abandonedTemp);
		expect(fs.files.has(abandonedTemp)).toBe(false);
		expect(fs.files.get(IPS)).toBe("192.0.2.1");
		expect(fs.sidecar().links[0]?.iface).toBe("eth1");
		expect(next.ok && fs.sidecar().generation).toBe(
			next.ok ? next.generation : -1,
		);
	});

	test("a late rename from the timed-out write is repaired by a newer generation", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0"), fs.deps); // generation 1
		const release = Promise.withResolvers<void>();
		let hang = true;
		const repairs: BindMapPublication[] = [];
		const deps = {
			...fs.deps,
			renameFile: async (from: string, to: string) => {
				if (hang && to === MAP) {
					hang = false;
					await release.promise;
				}
				await fs.deps.renameFile(from, to);
			},
			onSettled: (
				_entries: readonly BondEntry[],
				publication: BindMapPublication,
				origin: { readonly republished: boolean },
			) => {
				if (origin.republished) repairs.push(publication);
			},
		};
		// Generation 2 (wwan0) hangs in its sidecar rename and is abandoned.
		expect((await publishBondMapping(link("wwan0"), deps)).ok).toBe(false);
		await whenBindMapWriterIdle(); // republished wwan0 at generation 3
		const latest = await publishBondMapping(link("eth1"), deps); // generation 4
		expect(latest.ok && latest.generation).toBe(4);
		expect(fs.sidecar().links[0]?.iface).toBe("eth1");

		// The stale generation-2 rename finally lands on top of generation 4 ...
		release.resolve();
		await Bun.sleep(5);
		await whenBindMapWriterIdle();

		// ... and the newest snapshot is published again, above everything that landed.
		const finalDocument = fs.sidecar();
		expect(finalDocument.links[0]?.iface).toBe("eth1");
		expect(finalDocument.generation).toBe(5);
		expect(repairs.at(-1)).toMatchObject({ ok: true, generation: 5 });
		expect(repairs.at(-1)?.changed).toBe(true);
		expectOneDocumentPerGeneration(fs.documents);
	});
});

describe("a flapping interface", () => {
	test("200 alternating submissions coalesce into a bounded number of writes and reloads", async () => {
		const fs = memoryFs(5_000);
		await publishBondMapping(link("eth0"), fs.deps);
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let hold = true;
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (hold && path.startsWith(IPS)) {
					hold = false;
					entered.resolve();
					await release.promise;
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		const writesBefore = fs.writes.length;
		let deliveries = 0;
		const deliver = async () => {
			deliveries += 1;
			await Bun.sleep(1);
			return true;
		};
		const storm = Array.from({ length: 200 }, (_, i) =>
			link(i % 2 === 0 ? "wwan0" : "eth0"),
		);
		const callers = storm.map((entries) =>
			publishBondMapping(entries, deps).then(async (publication) => {
				if (publication.changed) await restartSrtla(deliver, notStreaming);
				return publication;
			}),
		);
		await entered.promise;
		release.resolve();
		const receipts = await Promise.all(callers);

		// One in flight (wwan0) plus one pending slot that ended on the newest (eth0).
		expect(fs.writes.length - writesBefore).toBe(4);
		expect(deliveries).toBeLessThanOrEqual(2);
		expect(fs.sidecar().links[0]?.iface).toBe("eth0");
		expect(receipts[0]).toMatchObject({ ok: true, generation: 2 });
		for (const receipt of receipts.slice(1)) {
			// Superseded callers resolve from the receipt that replaced them.
			expect(receipt).toBe(receipts[199] as BindMapPublication);
		}
		expect(receipts[199]).toMatchObject({ ok: true, generation: 3 });
		expectOneDocumentPerGeneration(fs.documents);
		expect(await publishBondMapping(link("eth0"), fs.deps)).toEqual({
			...(receipts[199] as BindMapPublication),
			changed: false,
		});
	});
});

describe("a failed reload", () => {
	test("is re-signalled once while still streaming, covering a no-op publication made during it", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0"), fs.deps);
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const outcomes = [false, true];
		let deliveries = 0;
		const deliver = async () => {
			deliveries += 1;
			if (deliveries === 1) {
				entered.resolve();
				await release.promise;
			}
			return outcomes.shift() ?? false;
		};
		const reload = restartSrtla(deliver, streaming);
		await entered.promise;
		// An identical publication while the SIGHUP is in flight owes no reload ...
		expect((await publishBondMapping(link("eth0"), fs.deps)).changed).toBe(
			false,
		);
		release.resolve();
		// ... so the failed SIGHUP must be re-sent, or nobody reloads.
		expect(await reload).toBe(true);
		expect(deliveries).toBe(2);
	});

	test("the re-signal is bounded and the failure still invalidates reuse", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0"), fs.deps);
		let deliveries = 0;
		expect(
			await restartSrtla(async () => {
				deliveries += 1;
				return false;
			}, streaming),
		).toBe(false);
		expect(deliveries).toBe(2);
		expect((await publishBondMapping(link("eth0"), fs.deps)).changed).toBe(
			true,
		);
	});

	test("is not re-signalled once the stream has stopped", async () => {
		let deliveries = 0;
		expect(
			await restartSrtla(async () => {
				deliveries += 1;
				return false;
			}, notStreaming),
		).toBe(false);
		expect(deliveries).toBe(1);
	});

	test("requests made during an in-flight reload collapse into one follow-up", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let deliveries = 0;
		const deliver = async () => {
			deliveries += 1;
			if (deliveries === 1) {
				entered.resolve();
				await release.promise;
			}
			return true;
		};
		const first = restartSrtla(deliver, notStreaming);
		await entered.promise;
		const later = Array.from({ length: 5 }, () =>
			restartSrtla(deliver, notStreaming),
		);
		release.resolve();
		expect(await Promise.all([first, ...later])).toEqual(Array(6).fill(true));
		expect(deliveries).toBe(2);
	});
});

describe("strict capability flags", () => {
	test.each([
		["contract 3", 3],
		["contract absent", undefined],
		['contract "2"', "2"],
		["contract 1", 1],
	])(
		"%s with bind_map_required:true does not report strict support",
		(_label, version) => {
			expect(
				classifyCapabilityDocument(
					0,
					JSON.stringify({
						capabilities: {
							bind_map: true,
							...(version === undefined ? {} : { bind_map_contract: version }),
							bind_map_required: true,
							bind_map_required_empty_reload: true,
						},
					}),
				),
			).toEqual({ bindMap: true, bindMapSchemaVersion: 1 });
		},
	);

	test("exactly contract 2 keeps the strict flags", () => {
		expect(
			classifyCapabilityDocument(
				0,
				JSON.stringify({
					capabilities: {
						bind_map: true,
						bind_map_contract: 2,
						bind_map_required: true,
					},
				}),
			),
		).toEqual({
			bindMap: true,
			bindMapSchemaVersion: 1,
			bindMapContract: 2,
			bindMapRequired: true,
		});
	});
});

describe("publication order", () => {
	test("a slow earlier publication cannot finish after, or land over, a later one", async () => {
		const fs = memoryFs(5_000);
		const release = Promise.withResolvers<void>();
		let slow = true;
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (slow && path.startsWith(IPS)) {
					slow = false;
					await release.promise;
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		const order: string[] = [];
		const a = publishBondMapping(link("eth0", "192.0.2.1"), deps).then(() =>
			order.push("a"),
		);
		const b = publishBondMapping(link("eth1", "192.0.2.2"), deps).then(() =>
			order.push("b"),
		);
		await Bun.sleep(5);
		release.resolve();
		await Promise.all([a, b]);
		expect(order).toEqual(["a", "b"]);
		expect(fs.files.get(IPS)).toBe("192.0.2.2");
		expect(fs.sidecar().links[0]?.iface).toBe("eth1");
	});

	test("the published bond record follows submission order for every caller", async () => {
		const fs = memoryFs(5_000);
		const release = Promise.withResolvers<void>();
		let slow = true;
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (slow && path.startsWith(IPS)) {
					slow = false;
					await release.promise;
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		const a = link("eth0", "192.0.2.1"),
			b = link("eth1", "192.0.2.2"),
			c = link("eth2", "192.0.2.3");
		const pa = publishSrtlaBond(a, deps, notStreaming);
		const pb = publishSrtlaBond(b, deps, notStreaming);
		const pc = publishSrtlaBond(c, deps, notStreaming);
		await Bun.sleep(5);
		release.resolve();
		const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
		expect(ra).toMatchObject({ ok: true, generation: 1 });
		// b was superseded by c while waiting: both answer with c's receipt.
		expect(rb).toBe(rc);
		expect(rc).toMatchObject({ ok: true, generation: 2 });
		expect(getLastPublishedBond()).toEqual({ entries: c, publication: rc });
		expect(fs.files.get(IPS)).toBe("192.0.2.3");
	});

	test("a background republication owes its own reload while streaming", async () => {
		const fs = memoryFs();
		let hang = true;
		const deps = {
			...fs.deps,
			writeFile: async (path: string, bytes: string) => {
				if (hang && path.startsWith(IPS)) {
					hang = false;
					return new Promise<void>(() => {});
				}
				await fs.deps.writeFile(path, bytes);
			},
		};
		const reloads: BindMapPublication[] = [];
		const receipt = await publishSrtlaBond(link("wwan0"), deps, {
			...streaming,
			reload: async (publication) => {
				reloads.push(publication);
			},
		});
		expect(receipt).toMatchObject({ ok: false, reason: "timed_out" });
		await whenBindMapWriterIdle();
		await Bun.sleep(1);
		expect(reloads).toHaveLength(1);
		expect(reloads[0]).toMatchObject({ ok: true, changed: true });
		expect(getLastPublishedBond()?.publication).toBe(
			reloads[0] as BindMapPublication,
		);
	});
});

describe("delivery by tracked sender handle", () => {
	// A tracked-PID reload reports how many supervised senders received SIGHUP.
	// "Delivered" means at least one did; the failed-delivery invalidation stays.
	test.each([
		[0, false, true],
		[1, true, false],
		[2, true, false],
	])(
		"%p supervised senders signalled: delivered=%p, next identical publication reloads=%p",
		async (count, delivered, reloads) => {
			const fs = memoryFs();
			await publishBondMapping(link("eth0"), fs.deps);
			expect(
				await restartSrtla(
					supervisedSenderDelivery(() => count),
					notStreaming,
				),
			).toBe(delivered);
			expect((await publishBondMapping(link("eth0"), fs.deps)).changed).toBe(
				reloads,
			);
		},
	);

	test("a signalling error counts as undelivered", async () => {
		const fs = memoryFs();
		await publishBondMapping(link("eth0"), fs.deps);
		expect(
			await restartSrtla(
				supervisedSenderDelivery(() => {
					throw new Error("kill failed");
				}),
				notStreaming,
			),
		).toBe(false);
		expect((await publishBondMapping(link("eth0"), fs.deps)).changed).toBe(
			true,
		);
	});
});
