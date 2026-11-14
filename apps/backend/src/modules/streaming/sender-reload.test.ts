import { describe, expect, test } from "bun:test";
import {
	classifyAdoption,
	createObservationFailureLog,
	createReloadQueue,
	type ReloadDeps,
	verifySenderReload,
} from "./sender-reload.ts";

describe("sender adoption", () => {
	test("generation is authoritative; sources are a legacy fallback", () => {
		expect(
			classifyAdoption({ generation: 3, sources: ["192.0.2.2"] }, 4, [
				"192.0.2.2",
			]).state,
		).toBe("stale");
		expect(
			classifyAdoption({ generation: 4, sources: [] }, 4, ["192.0.2.2"]).state,
		).toBe("adopted");
		expect(
			classifyAdoption({ sources: ["192.0.2.2"] }, 4, ["192.0.2.2"]).state,
		).toBe("adopted");
		expect(
			classifyAdoption({ sources: ["192.0.2.1"] }, 4, ["192.0.2.2"]),
		).toEqual({ state: "stale", stale: ["192.0.2.1"] });
	});

	test("a stale source fails adoption; a link still binding does not", () => {
		const published = ["192.0.2.2", "198.51.100.7"];
		// Changed link still on its old address: stale, and only that source.
		expect(
			classifyAdoption(
				{ sources: ["192.0.2.1", "198.51.100.7"] },
				4,
				published,
			),
		).toEqual({ state: "stale", stale: ["192.0.2.1"] });
		// New address not bindable yet, but no old source left: adopted.
		expect(
			classifyAdoption({ sources: ["198.51.100.7"] }, 4, published).state,
		).toBe("adopted");
	});

	test("nothing observable is 'can't tell', never stale and never adopted", () => {
		const published = ["192.0.2.2"];
		expect(classifyAdoption(undefined, 4, published).state).toBe("unknown");
		// A local relay bond where every source is loopback is filtered to nothing.
		expect(classifyAdoption({ sources: [] }, 4, published).state).toBe(
			"unknown",
		);
	});
});

type Mode = "ok" | "missed" | "stuck" | "unknown" | "throws";

function fixture(mode: Mode) {
	let clock = 0,
		signals = 0;
	const lines: Array<Record<string, unknown>> = [];
	const controller = new AbortController();
	const failures = createObservationFailureLog(60_000, () => clock);
	const deps: ReloadDeps = {
		signal: controller.signal,
		now: () => clock,
		wait: async (ms: number) => {
			clock += ms;
		},
		hup: async () => {
			signals++;
			return signals !== 1;
		},
		read: async () => {
			if (mode === "unknown") return undefined;
			if (mode === "throws") throw new Error("EACCES: hidepid");
			return {
				sources:
					mode === "ok" || (mode === "missed" && signals > 1)
						? ["192.0.2.2"]
						: ["192.0.2.1"],
			};
		},
		log: (_event, meta) => {
			lines.push(meta);
		},
		observationFailed: (error) => failures.report(error, deps.log),
	};
	return {
		deps,
		controller,
		lines,
		advance: (ms: number) => {
			clock += ms;
		},
		counts: () => ({ signals, clock }),
	};
}

describe("verifySenderReload", () => {
	test("successful adoption is quiet", async () => {
		const f = fixture("ok");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "adopted",
		});
		expect(f.counts()).toEqual({ signals: 1, clock: 0 });
	});

	test("withheld first HUP recovers with one retry at ten seconds", async () => {
		const f = fixture("missed");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "adopted",
		});
		expect(f.counts()).toEqual({ signals: 2, clock: 10_000 });
	});

	test("a source still stale after the one retry is reported, never replaced", async () => {
		const f = fixture("stuck");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "stale",
			stale: ["192.0.2.1"],
		});
		// Exactly one retry, then the decision goes to the operator.
		expect(f.counts().signals).toBe(2);
		expect(f.counts().clock).toBe(20_000);
		expect(f.lines.map((line) => line.outcome)).toEqual([
			"signal",
			"signal",
			"stale",
		]);
	});

	test("an unknown observation never escalates: no retry, no stale report", async () => {
		const f = fixture("unknown");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "unknown",
		});
		expect(f.counts().signals).toBe(1);
	});

	test("an unreadable /proc is unknown and logs at most once a minute", async () => {
		const f = fixture("throws");
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "unknown",
		});
		expect(f.counts().signals).toBe(1);
		const failed = () =>
			f.lines.filter((line) => line.outcome === "observation_failed").length;
		// Forty polls in the window, one line.
		expect(failed()).toBe(1);
		// A second publication 30 s later stays quiet; after a minute it logs again.
		f.advance(20_000);
		await verifySenderReload(3, ["192.0.2.2"], f.deps);
		expect(failed()).toBe(1);
		f.advance(60_000);
		await verifySenderReload(4, ["192.0.2.2"], f.deps);
		expect(failed()).toBe(2);
		const last = f.lines.filter(
			(line) => line.outcome === "observation_failed",
		)[1];
		expect(last?.suppressed).toBeGreaterThan(0);
	});

	test("the last observation of the retry window decides", async () => {
		const f = fixture("stuck");
		let reads = 0;
		f.deps.read = async () => {
			reads++;
			// Stale through the first window, then the sender vanishes.
			return reads <= 41 ? { sources: ["192.0.2.1"] } : undefined;
		};
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "unknown",
		});
		expect(f.counts().signals).toBe(2);
	});

	test("cancellation during the retry window reports nothing", async () => {
		const f = fixture("stuck");
		const wait = f.deps.wait;
		f.deps.wait = async (ms) => {
			await wait(ms);
			if (f.counts().clock >= 15_000) f.controller.abort();
		};
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "cancelled",
		});
	});

	test("cancellation after the last observation still reports nothing", async () => {
		const f = fixture("stuck");
		const read = f.deps.read;
		f.deps.read = async () => {
			const observed = await read();
			if (f.counts().clock >= 20_000) f.controller.abort();
			return observed;
		};
		expect(await verifySenderReload(2, ["192.0.2.2"], f.deps)).toEqual({
			outcome: "cancelled",
		});
	});
});

describe("reload queue", () => {
	test("a duplicate publication neither aborts nor repeats the running check", async () => {
		const q = createReloadQueue();
		const release = Promise.withResolvers<void>();
		const signals: AbortSignal[] = [];
		let runs = 0;
		q.enqueue("2", async (signal) => {
			runs++;
			signals.push(signal);
			await release.promise;
		});
		await Promise.resolve();
		await Promise.resolve();
		q.enqueue("2", async (signal) => {
			runs++;
			signals.push(signal);
		});
		release.resolve();
		await q.settled();
		expect(runs).toBe(1);
		expect(signals[0]?.aborted).toBe(false);
	});

	test("a newer publication aborts the older check before running", async () => {
		const q = createReloadQueue();
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		let first: AbortSignal | undefined;
		q.enqueue("2", async (signal) => {
			first = signal;
			order.push("2");
			await release.promise;
		});
		await Promise.resolve();
		await Promise.resolve();
		q.enqueue("3", async () => {
			order.push("3");
		});
		expect(first?.aborted).toBe(true);
		release.resolve();
		await q.settled();
		expect(order).toEqual(["2", "3"]);
	});

	test("close aborts the running check and refuses new work", async () => {
		const q = createReloadQueue();
		const release = Promise.withResolvers<void>();
		let first: AbortSignal | undefined;
		let runs = 0;
		q.enqueue("2", async (signal) => {
			runs++;
			first = signal;
			await release.promise;
		});
		await Promise.resolve();
		await Promise.resolve();
		q.close();
		q.enqueue("3", async () => {
			runs++;
		});
		release.resolve();
		await q.settled();
		expect(first?.aborted).toBe(true);
		expect(runs).toBe(1);
	});
});
