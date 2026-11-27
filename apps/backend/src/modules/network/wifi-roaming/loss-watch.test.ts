import { describe, expect, test } from "bun:test";
import {
	LOSS_TICK_MS,
	LOSS_TIMEOUT_MS,
	LossWatch,
	type LossWatchDeps,
	type WatchedRadio,
} from "./loss-watch.ts";

const A: WatchedRadio = {
	id: "02:00:00:00:b0:01/51:5:p5",
	permanentMac: "02:00:00:00:b0:01",
	ifname: "wlan1",
	bssid: "aa:00:00:00:00:01",
};
const B: WatchedRadio = {
	id: "02:00:00:00:b0:02/61:6:p6",
	permanentMac: "02:00:00:00:b0:02",
	ifname: "wlan2",
	bssid: "aa:00:00:00:00:02",
};

/** Carrier and bond membership per interface, on a hand-driven clock. */
function world() {
	const w = {
		now: 0,
		carrier: new Map<string, boolean | undefined>(),
		bond: new Set<string>() as Set<string> | undefined,
	};
	const deps: LossWatchDeps = {
		now: () => w.now,
		carrier: async (ifname) => w.carrier.get(ifname),
		inBond: (ifname) => (w.bond ? w.bond.has(ifname) : undefined),
	};
	return { w, watch: new LossWatch(deps) };
}

/** Advance in ticks until `ms` has passed. */
async function run(
	watch: LossWatch,
	w: { now: number },
	ms: number,
	each: (t: number) => void = () => {},
) {
	for (let t = 0; t < ms; t += LOSS_TICK_MS) {
		w.now += LOSS_TICK_MS;
		each(w.now);
		await watch.tick();
	}
}

describe("the dead-link window", () => {
	test("from the carrier going down to the published bond losing the interface", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 500);
		w.carrier.set("wlan1", false);
		const lostAt = w.now + LOSS_TICK_MS;
		// CeraUI republishes the bond 2.4 s later.
		await run(watch, w, 3_000, (t) => {
			if (t >= lostAt + 2_400) w.bond?.delete("wlan1");
		});
		const [event, ...rest] = watch.drain();
		expect(rest).toEqual([]);
		expect(event).toMatchObject({
			event: "ap-lost",
			radio: A.permanentMac,
			id: A.id,
			ifname: "wlan1",
			lostAt,
			outcome: "left-bond",
		});
		expect(event?.durationMs).toBeGreaterThanOrEqual(2_400);
		expect(event?.durationMs).toBeLessThanOrEqual(2_400 + LOSS_TICK_MS);
		expect(watch.status(A.id)).toMatchObject({ losses: 1, lostSince: null });
	});

	test("a carrier that comes back while still in the bond is a recovery", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		await run(watch, w, 700);
		expect(watch.status(A.id)?.lostSince).not.toBeNull();
		w.carrier.set("wlan1", true);
		await run(watch, w, 100);
		expect(watch.drain()).toMatchObject([
			{ outcome: "recovered", durationMs: 700 },
		]);
	});

	test("a loss on a radio that was not in the bond is recorded as such", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		watch.watch([A]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		await run(watch, w, 100);
		expect(watch.drain()).toMatchObject([
			{ outcome: "not-in-bond", durationMs: 0 },
		]);
	});

	test("a loss that never resolves ends after 30 s", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		await run(watch, w, LOSS_TIMEOUT_MS + 200);
		const events = watch.drain();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ outcome: "timeout" });
	});

	test("an unreadable carrier starts nothing; a carrier first seen down is no loss", async () => {
		const { w, watch } = world();
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 300);
		w.carrier.set("wlan1", false);
		await run(watch, w, 300);
		expect(watch.drain()).toEqual([]);
	});

	test("a radio losing its access point stays watched although the round no longer lists it", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.carrier.set("wlan2", true);
		w.bond?.add("wlan1");
		watch.watch([A, B]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		await run(watch, w, 300);
		// The next round lists only B; A's loss goes on being measured.
		watch.watch([B]);
		w.bond?.delete("wlan1");
		await run(watch, w, 100);
		expect(watch.drain()).toMatchObject([
			{ ifname: "wlan1", outcome: "left-bond" },
		]);
		// Once ended, an unlisted radio is no longer watched.
		expect(watch.status(A.id)).toBeNull();
		expect(watch.status(B.id)).toMatchObject({ losses: 0 });
	});

	test("radios are kept by physical id: a replacement under the name starts fresh", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 200);
		const replacement = { ...A, id: "02:00:00:00:b0:01/52:5:p5" };
		watch.watch([replacement]);
		// The next tick drops the old radio: no loss was in progress.
		await run(watch, w, 100);
		expect(watch.status(A.id)).toBeNull();
		expect(watch.status(replacement.id)).toMatchObject({ losses: 0 });
	});

	test("no bond published yet counts as not in the bond", async () => {
		const { w, watch } = world();
		w.bond = undefined;
		w.carrier.set("wlan1", true);
		watch.watch([A]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		await run(watch, w, 100);
		expect(watch.drain()).toMatchObject([{ outcome: "not-in-bond" }]);
	});
});

describe("losses the order or the radio of which is uncertain", () => {
	test("carrier and bond dropping within one tick are unordered, not out of the bond", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		w.bond?.delete("wlan1");
		await run(watch, w, 100);
		expect(watch.drain()).toMatchObject([
			{ outcome: "unordered", durationMs: 0, bssid: A.bssid },
		]);
	});

	test("another radio taking the name ends the loss as replaced, never as its recovery", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 200);
		w.carrier.set("wlan1", false);
		await run(watch, w, 300);
		// A replacement under the same name, carrier up.
		const replacement = { ...A, id: "02:00:00:00:b0:09/52:5:p5" };
		watch.watch([replacement]);
		w.carrier.set("wlan1", true);
		await run(watch, w, 100);
		expect(watch.drain()).toMatchObject([
			{ id: A.id, outcome: "radio-replaced" },
		]);
		expect(watch.status(replacement.id)).toMatchObject({ losses: 0 });
	});

	test("a radio unlisted while its tick reads the carrier keeps the loss that tick finds", async () => {
		const gate = Promise.withResolvers<void>();
		const w = {
			now: 0,
			carrier: true as boolean,
			hold: false,
		};
		const watch = new LossWatch({
			now: () => w.now,
			carrier: async () => {
				if (w.hold) await gate.promise;
				return w.carrier;
			},
			inBond: () => true,
		});
		watch.watch([A]);
		w.now = 100;
		await watch.tick();
		w.carrier = false;
		w.hold = true;
		w.now = 200;
		const ticking = watch.tick();
		// The round no longer lists A while the tick is reading its carrier.
		watch.watch([]);
		gate.resolve();
		await ticking;
		expect(watch.status(A.id)?.lostSince).toBe(200);
	});

	test("the loss record names the access point the radio was last seen on", async () => {
		const { w, watch } = world();
		w.carrier.set("wlan1", true);
		w.bond?.add("wlan1");
		watch.watch([A]);
		await run(watch, w, 200);
		// The round after the loss sees no association; the last BSSID stays.
		watch.watch([{ ...A, bssid: null }]);
		w.carrier.set("wlan1", false);
		await run(watch, w, 100);
		w.bond?.delete("wlan1");
		await run(watch, w, 100);
		expect(watch.drain()[0]?.bssid).toBe(A.bssid);
	});

	test("at most 256 ended losses wait; older ones are dropped and counted", async () => {
		const { w, watch } = world();
		w.bond = undefined;
		watch.watch([A]);
		for (let i = 0; i < 300; i++) {
			w.carrier.set("wlan1", true);
			await run(watch, w, 100);
			w.carrier.set("wlan1", false);
			await run(watch, w, 100);
		}
		expect(watch.drain()).toHaveLength(256);
		expect(watch.dropped()).toBe(44);
	});
});
