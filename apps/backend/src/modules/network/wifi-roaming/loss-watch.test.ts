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
};
const B: WatchedRadio = {
	id: "02:00:00:00:b0:02/61:6:p6",
	permanentMac: "02:00:00:00:b0:02",
	ifname: "wlan2",
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
