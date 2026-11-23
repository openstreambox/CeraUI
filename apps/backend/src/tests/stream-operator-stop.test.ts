/**
 * The operator's Stop is the shipped way out of an unconfirmed stream state.
 * It always sends its own Stop and reports success only on the engine's
 * acknowledgement, it never sends anything once it has reported a timeout, and
 * it never adds a second Stop to one the engine already acknowledged.
 * Review probes, turned into tests.
 */
import { expect, test } from "bun:test";
import type { CerastreamClient } from "@ceralive/cerastream";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { createSessionCleanup } from "../modules/streaming/stream-session-cleanup.ts";
import type { StreamSessionOrchestratorDeps } from "../modules/streaming/stream-session-orchestrator.ts";
import { confirmUnownedEngineStop } from "../modules/streaming/streamloop/stop-evidence.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";

/** confirmUnownedEngineStop with a scripted engine answer and counted stops. */
function evidence(
	runtime: "idle" | "streaming" | "unknown",
	options: {
		confirmUnknown: boolean;
		confirm?: () => Promise<void>;
		signal?: AbortSignal;
	},
) {
	const finished = Promise.withResolvers<{ ok: boolean }>();
	let stops = 0;
	confirmUnownedEngineStop(
		async (outcome) => finished.resolve(outcome),
		{
			query: async () => runtime,
			stop: (onStopped) => {
				stops++;
				onStopped();
				return true;
			},
			confirmStop: async () => {
				stops++;
				await options.confirm?.();
			},
		},
		options.confirmUnknown,
		options.signal,
	);
	return { finished: finished.promise, stops: () => stops };
}

test("an operator Stop beside an idle engine still sends its own Stop and waits for it", async () => {
	const operator = evidence("idle", { confirmUnknown: true });
	expect(await operator.finished).toEqual({ ok: true });
	expect(operator.stops()).toBe(1);

	// A machine stop (engine loss, cleanup) keeps the idle answer as enough.
	const machine = evidence("idle", { confirmUnknown: false });
	expect(await machine.finished).toEqual({ ok: true });
	expect(machine.stops()).toBe(0);
});

test("an operator Stop the engine does not acknowledge is not a success", async () => {
	for (const runtime of ["idle", "unknown"] as const) {
		const refused = evidence(runtime, {
			confirmUnknown: true,
			confirm: async () => {
				throw new Error("stop_not_idle");
			},
		});
		expect((await refused.finished).ok).toBe(false);
		expect(refused.stops()).toBe(1);
	}
});

test("an operator Stop sends nothing once its deadline has passed", async () => {
	const abort = new AbortController();
	abort.abort();
	for (const runtime of ["idle", "unknown"] as const) {
		const late = evidence(runtime, {
			confirmUnknown: true,
			signal: abort.signal,
		});
		expect((await late.finished).ok).toBe(false);
		expect(late.stops()).toBe(0);
	}
});

/** How a promise has settled after a short while, without waiting forever. */
async function settledState(promise: Promise<unknown>) {
	return await Promise.race([
		promise.then(
			() => "resolved",
			() => "rejected",
		),
		Bun.sleep(100).then(() => "pending"),
	]);
}

/** A cleanup owner with manual timers. */
function cleanupWith(
	stopRuntime: StreamSessionOrchestratorDeps["stopRuntime"],
) {
	const timers = new Map<number, () => void>();
	let next = 0;
	const cleanup = createSessionCleanup(
		{ stopRuntime } as StreamSessionOrchestratorDeps,
		{
			schedule: (callback) => {
				timers.set(++next, callback);
				return next;
			},
			cancel: (handle) => {
				timers.delete(handle as number);
			},
			deadlineMs: 12_000,
		},
	);
	return { cleanup, fire: (handle: number) => timers.get(handle)?.() };
}

test("a Stop that waited behind a settle and timed out sends nothing later", async () => {
	let stops = 0;
	const { cleanup, fire } = cleanupWith(async () => {
		stops++;
	});
	const settle = Promise.withResolvers<boolean | undefined>();
	const settling = cleanup.run(0, false, () => settle.promise);
	const operator = cleanup.run(0, true);
	fire(1);
	fire(2);
	expect(await settledState(settling)).toBe("rejected");
	expect(await settledState(operator)).toBe("rejected");
	await expect(operator).rejects.toThrow("stop_timeout");
	settle.resolve(false);
	await flushEvidence();
	expect(stops).toBe(0);
});

test("a Stop behind a settle that stopped nothing sends exactly one Stop of its own", async () => {
	let stops = 0;
	const { cleanup } = cleanupWith(async () => {
		stops++;
	});
	const settle = Promise.withResolvers<boolean | undefined>();
	void cleanup.run(0, false, () => settle.promise);
	const operator = cleanup.run(0, true);
	settle.resolve(false);
	await operator;
	expect(stops).toBe(1);
});

test("a Stop behind a settle the engine acknowledged adds no second Stop", async () => {
	let stops = 0;
	const { cleanup } = cleanupWith(async () => {
		stops++;
	});
	const settle = Promise.withResolvers<boolean | undefined>();
	void cleanup.run(0, false, () => settle.promise);
	const operator = cleanup.run(0, true);
	settle.resolve(true);
	await operator;
	expect(stops).toBe(0);
});

test("the cleanup's own deadline aborts the stop it submitted", async () => {
	let signal: AbortSignal | undefined;
	const held = Promise.withResolvers<void>();
	const { cleanup, fire } = cleanupWith(async (_generation, _confirm, s) => {
		signal = s;
		await held.promise;
	});
	const stopping = cleanup.run(0, true);
	expect(signal?.aborted).toBe(false);
	fire(1);
	await expect(stopping).rejects.toThrow("stop_timeout");
	expect(signal?.aborted).toBe(true);
	held.resolve();
});

/** The engine backend's targeted helpers against a hand-held fake client. */
function binding(
	options: {
		connect?: () => Promise<void>;
		snapshot?: () => Promise<unknown>;
	} = {},
) {
	const calls: string[] = [];
	const timers: Array<() => void> = [];
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.1.0",
			engine_version: "fake",
		},
		listSwitchTargets: async () => {
			calls.push("snapshot");
			return (
				(await options.snapshot?.()) ?? {
					session_id: "cs-1",
					active_input: "a",
					switch_targets: [],
				}
			);
		},
		stop: async () => {
			calls.push("stop");
			return { state: "idle" };
		},
		close: async () => {
			calls.push("close");
		},
	} as unknown as CerastreamClient;
	const backend = new CerastreamBackend({
		connect: async () => {
			calls.push("connect");
			await options.connect?.();
			return client;
		},
		connectOptions: {},
		getConfig: () => ({}),
		saveConfig: () => undefined,
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => undefined,
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		onEngineStatus: () => undefined,
		scheduleTimeout: (callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		},
		cancelTimeout: () => undefined,
	} as unknown as ConstructorParameters<typeof CerastreamBackend>[0]);
	return { backend, calls, expire: () => timers[0]?.() };
}

test("an engine that cannot be reached, or answers too late, never reports no session", async () => {
	const refused = binding({
		connect: async () => {
			throw new Error("connection refused");
		},
	});
	expect(await refused.backend.engineReportsNoSession()).toBe(false);

	const slow = Promise.withResolvers<void>();
	const late = binding({
		connect: () => slow.promise,
		snapshot: async () => ({ switch_targets: [] }),
	});
	const answer = late.backend.engineReportsNoSession();
	await flushEvidence();
	late.expire();
	expect(await answer).toBe(false);
	slow.resolve();
	await flushEvidence();
	expect(late.calls).toContain("close");
});

test("a snapshot or engine re-check that arrives after the deadline sends no stop", async () => {
	const snapshot = Promise.withResolvers<void>();
	const lateSnapshot = binding({
		snapshot: async () => {
			await snapshot.promise;
			return { session_id: "cs-1", switch_targets: [] };
		},
	});
	let rechecks = 0;
	const first = lateSnapshot.backend.stopRecordedSession(
		"cs-1",
		() => true,
		async () => {
			rechecks++;
			return true;
		},
	);
	await flushEvidence();
	lateSnapshot.expire();
	await expect(first).rejects.toThrow("stop_timeout");
	snapshot.resolve();
	await flushEvidence();
	expect(lateSnapshot.calls).not.toContain("stop");
	// Nothing more is asked of the host once the deadline has passed.
	expect(rechecks).toBe(0);

	const recheck = Promise.withResolvers<boolean>();
	const lateRecheck = binding();
	const second = lateRecheck.backend.stopRecordedSession(
		"cs-1",
		() => true,
		() => recheck.promise,
	);
	await flushEvidence();
	lateRecheck.expire();
	await expect(second).rejects.toThrow("stop_timeout");
	recheck.resolve(true);
	await flushEvidence();
	expect(lateRecheck.calls).not.toContain("stop");
});
