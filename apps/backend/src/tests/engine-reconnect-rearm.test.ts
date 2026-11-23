import { afterEach, describe, expect, test } from "bun:test";
import {
	ENGINE_RECONNECT_FLAP_WINDOW_MS,
	ENGINE_RECONNECT_MAX_MS,
	type EngineReconnectLogger,
	initEngineConnection,
	rearmEngineReconnect,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";

// The engine's watchdog restart after boot: the reconnect loop settled once at
// boot, the session then lost its control connection, and nothing asked the
// engine again, so the snapshot stayed "unavailable" until the backend restarted.

type TimerHandle = ReturnType<typeof setTimeout>;

function harness() {
	let reachable = false;
	/** What the next refresh finds; flipped by the test to move the engine. */
	let engineUp = true;
	let clock = 0;
	let nextHandle = 0;
	const timers = new Map<number, () => void>();
	const delays: number[] = [];
	const cleared: number[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	let refreshes = 0;
	let heals = 0;
	let offline = 0;
	let gate: Promise<void> | undefined;

	const logger: EngineReconnectLogger = {
		info: (message) => infos.push(message),
		warn: (message) => warnings.push(message),
	};

	const deps = {
		refreshCapabilities: async () => {
			refreshes += 1;
			// The answer is read when the request goes out; a loss reported while
			// it is in flight must not be hidden by it.
			const answer = engineUp;
			if (gate) await gate;
			reachable = answer;
		},
		isEngineReachable: () => reachable,
		broadcastEngineState: () => {
			heals += 1;
		},
		broadcastEngineOffline: () => {
			offline += 1;
		},
		reportEngineState: () => {},
		awaitsIdleWitness: () => false,
		reconcileSession: async () => undefined,
		logger,
		random: () => 0.5,
		now: () => clock,
		setTimer: (fn: () => void, ms: number): TimerHandle => {
			nextHandle += 1;
			timers.set(nextHandle, fn);
			delays.push(ms);
			return nextHandle as unknown as TimerHandle;
		},
		clearTimer: (timer: TimerHandle) => {
			const id = timer as unknown as number;
			cleared.push(id);
			timers.delete(id);
		},
		baseDelayMs: 2_000,
		maxDelayMs: ENGINE_RECONNECT_MAX_MS,
		flapWindowMs: ENGINE_RECONNECT_FLAP_WINDOW_MS,
	};

	return {
		deps,
		/** What `invalidateCapabilities()` does on a proven loss. */
		lose(site = "list-devices-poll") {
			reachable = false;
			rearmEngineReconnect(site);
		},
		setEngineUp(up: boolean) {
			engineUp = up;
		},
		advance(ms: number) {
			clock += ms;
		},
		holdRefresh() {
			let release!: () => void;
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				gate = undefined;
				release();
			};
		},
		/** Run the one pending timer, as the event loop would after its delay. */
		fire() {
			const [first] = timers.entries();
			if (!first) throw new Error("no pending timer");
			const [id, fn] = first;
			timers.delete(id);
			advance(delays.at(-1) ?? 0);
			fn();
			return settleEngineReconnect();
		},
		get pending() {
			return timers.size;
		},
		get delays() {
			return delays;
		},
		get cleared() {
			return cleared;
		},
		get refreshes() {
			return refreshes;
		},
		get heals() {
			return heals;
		},
		get offline() {
			return offline;
		},
		get reachable() {
			return reachable;
		},
		warnings,
		infos,
	};

	function advance(ms: number) {
		clock += ms;
	}
}

async function bootedReachable() {
	const h = harness();
	await initEngineConnection(h.deps);
	expect(h.reachable).toBe(true);
	expect(h.pending).toBe(0);
	return h;
}

afterEach(() => {
	stopEngineReconnect();
});

describe("rearmEngineReconnect — drop and recovery", () => {
	test("a loss after boot is rechecked until the engine answers, then clients are healed", async () => {
		const h = await bootedReachable();
		h.advance(120_000);

		h.setEngineUp(false);
		h.lose();
		// Clients that stay connected learn the engine is gone.
		expect(h.offline).toBe(1);
		expect(h.pending).toBe(1);
		expect(h.delays.at(-1)).toBe(1_500); // starts again at the base delay
		expect(h.warnings.some((w) => w.includes("list-devices-poll"))).toBe(true);

		// Still restarting on the first recheck.
		await h.fire();
		expect(h.heals).toBe(0);
		expect(h.pending).toBe(1);
		expect(h.offline).toBe(1); // once per outage, not per recheck

		// systemd brought it back.
		h.setEngineUp(true);
		await h.fire();
		expect(h.reachable).toBe(true);
		expect(h.heals).toBe(1);
		expect(h.pending).toBe(0);
		expect(h.infos.some((i) => /engine back after \d+s/.test(i))).toBe(true);
	});

	test("every later loss re-arms the loop again", async () => {
		const h = await bootedReachable();
		for (let round = 1; round <= 3; round++) {
			h.advance(5 * ENGINE_RECONNECT_FLAP_WINDOW_MS);
			h.lose();
			expect(h.pending).toBe(1);
			await h.fire();
			expect(h.heals).toBe(round);
			expect(h.pending).toBe(0);
		}
		expect(h.offline).toBe(3);
	});

	test("a start that could not reach the engine re-arms it too, and an engine still up just settles", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		// No session held a connection, so the snapshot was never invalidated.
		rearmEngineReconnect("start");
		expect(h.offline).toBe(0); // the snapshot still reads reachable
		expect(h.pending).toBe(1);
		await h.fire();
		expect(h.heals).toBe(1);
		expect(h.pending).toBe(0);
	});

	test("a start that could not reach an engine that is really gone shows it offline", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		rearmEngineReconnect("start");
		await h.fire();
		expect(h.reachable).toBe(false);
		expect(h.offline).toBe(1);
		expect(h.pending).toBe(1);
	});
});

describe("rearmEngineReconnect — engine absent for a long time", () => {
	test("backoff caps at the ceiling, one timer at a time, no extra broadcasts", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();
		for (let i = 0; i < 40; i++) {
			await h.fire();
			expect(h.pending).toBe(1);
		}
		// 0.75 × min(2000·2^n, 30000) with random()=0.5
		expect(h.delays.slice(-41, -35)).toEqual([
			1_500, 3_000, 6_000, 12_000, 22_500, 22_500,
		]);
		expect(Math.max(...h.delays)).toBeLessThanOrEqual(ENGINE_RECONNECT_MAX_MS);
		expect(h.refreshes).toBe(41); // boot + 40 rechecks, nothing in between
		expect(h.offline).toBe(1);
		expect(h.heals).toBe(0);

		// A loss reported again during the outage does not stack a second timer
		// or restart the backoff.
		const before = h.delays.length;
		h.lose("change-config");
		expect(h.pending).toBe(1);
		expect(h.delays.length).toBe(before);

		h.setEngineUp(true);
		await h.fire();
		expect(h.heals).toBe(1);
		expect(h.pending).toBe(0);
	});
});

describe("rearmEngineReconnect — flapping engine", () => {
	test("a loss soon after a heal keeps the previous backoff; a quiet minute resets it", async () => {
		const h = await bootedReachable();
		h.advance(120_000);

		// First crash: base delay, engine down for two rechecks.
		h.setEngineUp(false);
		h.lose();
		expect(h.delays.at(-1)).toBe(1_500);
		await h.fire();
		await h.fire();
		h.setEngineUp(true);
		await h.fire();
		expect(h.heals).toBe(1);

		// Crashes again right away: the next recheck waits longer, not 1.5 s.
		h.advance(5_000);
		h.lose();
		expect(h.delays.at(-1)).toBe(12_000);
		expect(h.warnings.at(-1)).toContain("previous backoff");
		await h.fire();
		expect(h.heals).toBe(2);

		// And again: still slower, capped.
		h.advance(5_000);
		h.lose();
		expect(h.delays.at(-1)).toBe(22_500);
		await h.fire();
		expect(h.heals).toBe(3);

		// Stable for longer than the flap window: back to the base delay.
		h.advance(ENGINE_RECONNECT_FLAP_WINDOW_MS + 1);
		h.lose();
		expect(h.delays.at(-1)).toBe(1_500);
	});
});

describe("rearmEngineReconnect — first loss soon after boot", () => {
	test("is not taken for a flap: it starts at the base delay", async () => {
		const h = await bootedReachable();
		h.advance(5_000);
		h.lose();
		expect(h.delays.at(-1)).toBe(1_500);
		expect(h.warnings.at(-1)).not.toContain("previous backoff");
	});
});

describe("rearmEngineReconnect — loss during an attempt (reconnect during a Start)", () => {
	test("an attempt that read the engine before it went away does not settle", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();

		// The engine is back for this refresh, but a Start that dials it while
		// the refresh is in flight finds it gone again.
		h.setEngineUp(true);
		const release = h.holdRefresh();
		const tick = h.fire();
		h.setEngineUp(false);
		h.lose("start");
		release();
		await tick;

		expect(h.pending).toBe(1); // still reconnecting, not settled
		expect(
			h.warnings.some((w) => w.includes("lost again during the recheck")),
		).toBe(true);

		// The next recheck finds it gone and tells the clients again, since the
		// heal above had told them it was back.
		await h.fire();
		expect(h.offline).toBe(2);
		expect(h.pending).toBe(1);

		h.setEngineUp(true);
		await h.fire();
		expect(h.pending).toBe(0);
		expect(h.reachable).toBe(true);
	});

	test("a loss while the boot attempt is in flight is not taken as reachable", async () => {
		const h = harness();
		const release = h.holdRefresh();
		const boot = initEngineConnection(h.deps);
		rearmEngineReconnect("list-devices-poll");
		release();
		await boot;
		expect(h.pending).toBe(1);
	});
});

describe("rearmEngineReconnect — shutdown", () => {
	test("shutting down while reconnecting clears the timer and nothing runs after", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.setEngineUp(false);
		h.lose();
		expect(h.pending).toBe(1);

		stopEngineReconnect();
		expect(h.pending).toBe(0);
		expect(h.cleared.length).toBe(1);

		// A loss reported during teardown starts nothing.
		const refreshes = h.refreshes;
		rearmEngineReconnect("list-devices-poll");
		expect(h.pending).toBe(0);
		expect(h.refreshes).toBe(refreshes);
	});

	test("shutting down during an in-flight recheck does not heal or reschedule", async () => {
		const h = await bootedReachable();
		h.advance(120_000);
		h.lose();
		const release = h.holdRefresh();
		const tick = h.fire();
		stopEngineReconnect();
		release();
		await tick;
		expect(h.heals).toBe(0);
		expect(h.pending).toBe(0);
	});

	test("a loss before the boot attempt ever ran starts nothing", () => {
		stopEngineReconnect();
		rearmEngineReconnect("start");
		// No state, no timers: the boot path owns the first attempt.
	});
});
