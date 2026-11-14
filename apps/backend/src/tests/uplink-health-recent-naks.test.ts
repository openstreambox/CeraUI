import { expect, test } from "bun:test";
import { RecentNaks } from "../modules/network/uplink-health/recent-naks.ts";
import type { UplinkHealthRuntimeCoreDeps } from "../modules/network/uplink-health/runtime-core.ts";
import { UplinkHealthRuntimeCore } from "../modules/network/uplink-health/runtime-core.ts";

function harness() {
	let now = 100_000;
	let count = 0;
	let conn = "a";
	let linkId: string | undefined;
	let streaming = true;
	let stale = false;
	let readAt: number | undefined;
	let ip = "192.0.2.1";
	let sibling = false;
	let changed: (() => void) | undefined;
	const core = new UplinkHealthRuntimeCore({
		onInterfacesChange: (cb: () => void) => {
			changed = cb;
			return () => {};
		},
		now: () => now,
		interfaces: () => ({ wan0: { ip } }),
		streaming: () => streaming,
		telemetry: () => ({
			lastReadMs: readAt ?? now,
			links: [
				{
					iface: "wan0",
					link_id: linkId,
					conn_id: conn,
					nak_count: count,
					rtt_ms: 50,
					stale,
				},
				...(sibling
					? [
							{
								iface: "wan0",
								conn_id: "clean",
								nak_count: 0,
								rtt_ms: 50,
								stale: false,
							},
						]
					: []),
			],
		}),
		resolveTarget: async () => undefined,
		probe: async () => {
			throw new Error("unexpected active probe");
		},
		publish: () => {},
		exclusionReason: () => undefined,
		candidates: () => [],
		identity: () => ({ kind: "cellular" }),
	} as unknown as UplinkHealthRuntimeCoreDeps);
	return {
		core,
		sibling() {
			sibling = true;
		},
		changed() {
			changed?.();
		},
		async tick(ms: number, n: number) {
			now = 100_000 + ms;
			count = n;
			await core.tick();
			return core.records()[0]?.weight;
		},
		link(id: string) {
			linkId = id;
		},
		connection(id: string) {
			conn = id;
		},
		streaming(value: boolean) {
			streaming = value;
		},
		stale(value: boolean) {
			stale = value;
		},
		readAt(value: number) {
			readAt = 100_000 + value;
		},
		ip(value: string) {
			ip = value;
		},
	};
}

test("a rough start degrades immediately and recovers within 35 seconds of the last loss", async () => {
	const h = harness();
	await h.tick(0, 0);
	expect(await h.tick(5_000, 25)).toBe(25);
	await h.tick(10_000, 60);
	await h.tick(15_000, 63);
	for (let t = 20_000; t <= 50_000; t += 5_000) await h.tick(t, 63);
	expect(h.core.records()[0]?.weight).toBe(100);
});

test("ongoing loss never regains full weight", async () => {
	const h = harness();
	await h.tick(0, 0);
	for (let t = 5_000; t <= 120_000; t += 5_000)
		expect(await h.tick(t, t / 200)).toBe(25);
});

test("lifetime totals and replacement connections are baselines, not recent loss", async () => {
	const h = harness();
	expect(await h.tick(0, 1_000)).toBe(100);
	expect(await h.tick(5_000, 1_025)).toBe(25);
	h.connection("b");
	for (let t = 10_000; t <= 30_000; t += 5_000) await h.tick(t, 2_000);
	expect(h.core.records()[0]?.weight).toBe(100);
});

test("counter reset clears old deltas but fresh loss has no grace period", async () => {
	const h = harness();
	await h.tick(0, 100);
	expect(await h.tick(5_000, 125)).toBe(25);
	await h.tick(10_000, 0);
	for (let t = 15_000; t <= 30_000; t += 5_000) await h.tick(t, 0);
	expect(h.core.records()[0]?.weight).toBe(100);
	expect(await h.tick(35_000, 25)).toBe(25);
});

test("burst then steady four NAKs per round recovers like steady loss alone", async () => {
	const burst = harness();
	const steady = harness();
	await burst.tick(0, 0);
	await steady.tick(0, 0);
	expect(await burst.tick(5_000, 30)).toBe(25);
	await steady.tick(5_000, 4);
	for (let round = 2; round <= 40; round++) {
		const b = await burst.tick(round * 5_000, 30 + (round - 1) * 4);
		const s = await steady.tick(round * 5_000, round * 4);
		expect(s).toBe(100);
		if (round >= 8) expect(b).toBe(s);
	}
});

test("file position changes retain stable link counter history", async () => {
	const h = harness();
	h.link("stable");
	await h.tick(0, 0);
	await h.tick(5_000, 20);
	h.connection("new-position");
	expect(await h.tick(10_000, 25)).toBe(25);
});

test("stale snapshots cannot turn lifetime totals into a new burst", async () => {
	const h = harness();
	await h.tick(0, 100);
	h.stale(true);
	await h.tick(5_000, 1_000);
	h.stale(false);
	for (let t = 10_000; t <= 40_000; t += 5_000) await h.tick(t, 1_000);
	expect(h.core.records()[0]?.weight).toBe(100);
});

test("stop/start and address replacement discard the old connection baseline", async () => {
	for (const change of ["stream", "ip"] as const) {
		const h = harness();
		await h.tick(0, 0);
		if (change === "stream") {
			h.streaming(false);
			await h.tick(5_000, 0);
			h.streaming(true);
		} else h.ip("192.0.2.2");
		expect(await h.tick(10_000, 1_000)).toBe(100);
	}
});

test("window boundary and entry threshold use recent deltas, never the lifetime count", () => {
	const naks = new RecentNaks();
	expect(naks.observe(0, 1_000)).toBe(false);
	expect(naks.observe(5_000, 1_025)).toBe(true);
	expect(naks.observe(10_000, 1_031)).toBe(true);
	expect(naks.observe(15_000, 1_031)).toBe(false); // six remain, below entry threshold
	expect(naks.observe(20_000, 1_031)).toBe(false);
	expect(naks.observe(25_000, 1_056)).toBe(true);
});

test("repeated snapshots do not add the same burst twice or age it using wall time", () => {
	const naks = new RecentNaks();
	naks.observe(0, 0);
	expect(naks.observe(5_000, 20)).toBe(false);
	expect(naks.observe(5_000, 20)).toBe(false);
	expect(naks.observe(10_000, 24)).toBe(false);
	expect(naks.observe(10_000, 24)).toBe(false);
	expect(naks.observe(14_000, 25)).toBe(true);
});

test("unobserved gaps and counter resets establish a new baseline", () => {
	const naks = new RecentNaks();
	naks.observe(0, 0);
	expect(naks.observe(5_000, 25)).toBe(true);
	expect(naks.observe(20_000, 2_000)).toBe(false);
	expect(naks.observe(25_000, 2_025)).toBe(true);
	expect(naks.observe(30_000, 0)).toBe(false);
	expect(naks.observe(35_000, 25)).toBe(true);
});

test("a clean sibling connection cannot overwrite a losing connection on the same interface", async () => {
	const h = harness();
	h.sibling();
	await h.tick(0, 0);
	for (let t = 5_000; t <= 60_000; t += 5_000)
		expect(await h.tick(t, t / 200)).toBe(25);
});

test("an address round trip between ticks discards the old counter baseline", async () => {
	const h = harness();
	await h.tick(0, 0);
	h.ip("192.0.2.2");
	h.changed();
	h.ip("192.0.2.1");
	h.changed();
	expect(await h.tick(5_000, 1_000)).toBe(100);
	expect(await h.tick(10_000, 1_025)).toBe(25);
});
