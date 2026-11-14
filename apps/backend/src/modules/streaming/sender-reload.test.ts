import { describe, expect, test } from "bun:test";
import { adoptionMatches, verifySenderReload } from "./sender-reload.ts";

describe("sender adoption", () => {
	test("generation is authoritative; sources are a legacy fallback", () => {
		expect(
			adoptionMatches({ generation: 3, sources: ["192.0.2.2"] }, 4, [
				"192.0.2.2",
			]),
		).toBe(false);
		expect(
			adoptionMatches({ generation: 4, sources: [] }, 4, ["192.0.2.2"]),
		).toBe(true);
		expect(adoptionMatches({ sources: ["192.0.2.2"] }, 4, ["192.0.2.2"])).toBe(
			true,
		);
		expect(adoptionMatches({ sources: ["192.0.2.1"] }, 4, ["192.0.2.2"])).toBe(
			false,
		);
		expect(adoptionMatches(undefined, 4, ["192.0.2.2"])).toBe(false);
	});
	test("a stale source fails adoption; a link still binding does not", () => {
		const published = ["192.0.2.2", "198.51.100.7"];
		// Changed link still on its old address: not adopted.
		expect(
			adoptionMatches({ sources: ["192.0.2.1", "198.51.100.7"] }, 4, published),
		).toBe(false);
		// New address not bindable yet, but no old source left: a restart cannot
		// help, so this is adoption.
		expect(adoptionMatches({ sources: ["198.51.100.7"] }, 4, published)).toBe(
			true,
		);
		// Nothing observable is never adoption.
		expect(adoptionMatches({ sources: [] }, 4, published)).toBe(false);
	});
	function fixture(mode: "ok" | "missed" | "stuck") {
		let clock = 0,
			signals = 0,
			restarts = 0,
			notices = 0;
		const signal = new AbortController();
		const deps = {
			signal: signal.signal,
			now: () => clock,
			wait: async (ms: number) => {
				clock += ms;
			},
			hup: async () => {
				signals++;
				return signals !== 1;
			},
			read: async () => ({
				sources:
					mode === "ok" || (mode === "missed" && signals > 1) || restarts > 0
						? ["192.0.2.2"]
						: ["192.0.2.1"],
			}),
			restart: async () => {
				restarts++;
			},
			notice: () => {
				notices++;
			},
			log: (_event: string, _meta: Record<string, unknown>) => {},
		};
		return {
			deps,
			signal,
			counts: () => ({ signals, restarts, notices, clock }),
		};
	}
	test("successful adoption is quiet", async () => {
		const f = fixture("ok");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toBe("adopted");
		expect(f.counts()).toEqual({
			signals: 1,
			restarts: 0,
			notices: 0,
			clock: 0,
		});
	});
	test("withheld first HUP recovers with one retry at ten seconds", async () => {
		const f = fixture("missed");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toBe("adopted");
		expect(f.counts()).toEqual({
			signals: 2,
			restarts: 0,
			notices: 0,
			clock: 10000,
		});
	});
	test("two failed reloads restart exactly once and verify again", async () => {
		const f = fixture("stuck");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toBe(
			"restarted",
		);
		expect(f.counts().restarts).toBe(1);
		expect(f.counts().notices).toBe(1);
	});
	test("stop during backoff cancels restart and notice", async () => {
		const f = fixture("stuck");
		f.deps.wait = async () => {
			f.signal.abort();
		};
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toBe(
			"cancelled",
		);
		expect(f.counts().restarts).toBe(0);
		expect(f.counts().notices).toBe(0);
	});
	test("unverifiable restart is logged as failure, never success", async () => {
		const f = fixture("stuck");
		f.deps.read = async () => ({ sources: [] });
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toBe("failed");
		expect(f.counts().restarts).toBe(1);
		expect(f.counts().notices).toBe(0);
	});
});

test("duplicate publications never double restart; superseding and Stop cancel", async () => {
	const { createReloadQueue } = await import("./sender-reload.ts");
	const q = createReloadQueue();
	let runs = 0;
	q.enqueue("2", async (signal) => {
		if (!signal.aborted) runs++;
	});
	q.enqueue("2", async () => {
		runs++;
	});
	await q.settled();
	expect(runs).toBe(1);
	q.enqueue("3", async () => {
		runs++;
	});
	q.close();
	await q.settled();
	expect(runs).toBe(1);
});
