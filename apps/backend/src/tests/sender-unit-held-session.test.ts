/*
 * The stream session beside a sender unit held across an owner restart.
 *
 * The orchestrator is the real one; its sender predicates read the real held
 * state through the census, as the production wiring does, and its stop runs
 * the held-unit stop path. The unit itself is the scripted manager.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineRuntimeState } from "../modules/streaming/engine-runtime-state.ts";
import { unownedSenderCensus } from "../modules/streaming/sender-ownership.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	armSenderHostMode,
	onSenderUnitHoldChanged,
	resetSenderHostModeForTest,
	resolveSenderHostMode,
	SENDER_UNIT_EXEC,
	SenderUnitError,
	senderHostBlocked,
	senderUnitKeepsSession,
	settleSenderUnit,
	stopHeldSenderUnit,
} from "../modules/streaming/streamloop/sender-unit.ts";
import { FakeSenderUnit } from "./helpers/fake-sender-unit.ts";

let root = "";
let fake: FakeSenderUnit;
let emptyProc = "";

beforeEach(() => {
	resetSenderHostModeForTest();
	root = mkdtempSync(join(tmpdir(), "sender-unit-held-"));
	const dir = join(root, "srtla-send");
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	emptyProc = join(root, "proc");
	mkdirSync(emptyProc);
	fake = new FakeSenderUnit(dir);
});

afterEach(() => {
	resetSenderHostModeForTest();
	rmSync(root, { recursive: true, force: true });
});

/** The production sender predicates, over the scripted unit. */
function session(
	engine: { state: EngineRuntimeState },
	options: {
		initialLiveness?: "idle" | "unknown";
		stopDeadlineMs?: number;
		engineStop?: () => Promise<void>;
	} = {},
) {
	const census = () => unownedSenderCensus([], emptyProc, process.pid);
	let launches = 0;
	const completed: string[] = [];
	const stopRuntimeCalls: string[] = [];
	const orchestrator = createStreamSessionOrchestrator({
		initialLiveness: options.initialLiveness ?? "unknown",
		createAttemptId: () => "held",
		setStreamingStatus: () => {},
		automaticStopRefused: () => senderUnitKeepsSession(),
		idleStopNeedsRuntime: () => senderHostBlocked() !== null,
		onStreamStopCompleted: (cause) => completed.push(cause),
		stopRuntime: async (_generation, confirmUnknown) => {
			stopRuntimeCalls.push(confirmUnknown ? "operator" : "automatic");
			await options.engineStop?.();
			engine.state = "idle";
			try {
				await stopHeldSenderUnit();
			} catch (error) {
				throw new Error(
					error instanceof SenderUnitError && error.reason === "unit_unresolved"
						? "sender_unit_unresolved"
						: "sender_unit_stop_unconfirmed",
				);
			}
			if (census() !== "absent") throw new Error("sender_ownership_unproven");
		},
		queryRuntime: async () =>
			engine.state === "idle" && census() !== "absent"
				? "unknown"
				: engine.state,
		canReconcileIdle: () => census() === "absent",
		senderAdmissionSafe: () => census() === "absent",
		// No launch of this process: a predecessor's session never confirms.
		canReconcileStreaming: () => false,
		stopDeadlineMs: options.stopDeadlineMs ?? 60_000,
	});
	return {
		orchestrator,
		completed,
		stopRuntimeCalls,
		launches: () => launches,
		start: () =>
			orchestrator.start({
				origin: "ui",
				launch: async () => {
					launches += 1;
				},
			}),
	};
}

async function bootBesideRunningSender() {
	await resolveSenderHostMode(
		{ srtla_send_unit: true },
		SENDER_UNIT_EXEC,
		fake.io(),
	);
	fake.state = {
		...fake.state,
		active: "active",
		sub: "running",
		mainPid: 777,
		invocation: "earlier",
		cgroup: "/system.slice/srtla-send.service",
	};
	expect(await settleSenderUnit()).toBe("held");
}

describe("the session beside a held sender", () => {
	test("engine still streaming: unconfirmed, never streaming or idle, and Start launches nothing", async () => {
		await bootBesideRunningSender();
		const engine = { state: "streaming" as EngineRuntimeState };
		const s = session(engine);
		expect(await s.orchestrator.reconcile()).toBe("reconciling");
		expect(s.orchestrator.streamLiveness()).toBe("unknown");
		const started = await s.start();
		expect(started.result).not.toBe("started");
		expect(s.launches()).toBe(0);
		expect(fake.calls.some(([verb]) => verb === "start")).toBe(false);
		expect(fake.calls.some(([verb]) => verb === "stop")).toBe(false);
	});

	test("operator Stop stops the engine and the held unit, then the session is idle and Start works", async () => {
		await bootBesideRunningSender();
		const engine = { state: "streaming" as EngineRuntimeState };
		const s = session(engine);
		await s.orchestrator.reconcile();
		expect(await s.orchestrator.stop("operator")).toEqual({
			result: "stopped",
		});
		expect(fake.state.active).toBe("inactive");
		expect(s.orchestrator.snapshot().state).toBe("idle");
		expect((await s.start()).result).toBe("started");
		expect(s.launches()).toBe(1);
	});

	test("a Stop the unit does not confirm is a failed stop, and the sender stays held", async () => {
		await bootBesideRunningSender();
		fake.stopFails = true;
		const engine = { state: "streaming" as EngineRuntimeState };
		const s = session(engine);
		await s.orchestrator.reconcile();
		const stopped = await s.orchestrator.stop("operator");
		expect(stopped).toEqual({
			result: "stop_failed",
			reason: "sender_unit_stop_unconfirmed",
		});
		expect(s.orchestrator.snapshot().state).not.toBe("idle");
		expect((await s.start()).result).not.toBe("started");
	});

	test("held sender dies on its own beside an idle engine: the session settles idle and Start works without a Stop", async () => {
		await bootBesideRunningSender();
		const engine = { state: "idle" as EngineRuntimeState };
		const s = session(engine);
		expect(await s.orchestrator.reconcile()).toBe("reconciling");
		fake.giveUp();
		expect(await settleSenderUnit()).toBe("none");
		expect(await s.orchestrator.reconcile()).toBe("idle");
		expect((await s.start()).result).toBe("started");
	});

	test("held sender dies on its own while the engine still streams: still unconfirmed until Stop", async () => {
		await bootBesideRunningSender();
		const engine = { state: "streaming" as EngineRuntimeState };
		const s = session(engine);
		await s.orchestrator.reconcile();
		fake.giveUp();
		await settleSenderUnit();
		expect(await s.orchestrator.reconcile()).toBe("reconciling");
		expect(await s.orchestrator.stop("operator")).toEqual({
			result: "stopped",
		});
		expect(s.orchestrator.snapshot().state).toBe("idle");
	});
});

describe("production wiring", () => {
	test("the production stop path stops a held unit after the engine", async () => {
		const session = await import("../modules/streaming/streamloop/session.ts");
		const { streamSessionProductionDeps } = await import(
			"../modules/streaming/stream-session-production.ts"
		);
		const { spyOn } = await import("bun:test");
		const order: string[] = [];
		const stopGeneration = spyOn(session, "stopGeneration").mockImplementation(
			async () => {
				order.push("engine");
			},
		);
		try {
			await bootBesideRunningSender();
			const before = fake.calls.length;
			// The census reads the test preload's empty process table.
			await streamSessionProductionDeps.stopRuntime(1, true);
			expect(stopGeneration).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["engine"]);
			expect(fake.calls.slice(before).some(([verb]) => verb === "stop")).toBe(
				true,
			);
			expect(fake.state.active).toBe("inactive");
		} finally {
			stopGeneration.mockRestore();
		}
	});
});

describe("review 198 round 1: the session", () => {
	test("an automatic stop (engine loss, reconfigure) never ends a held session; the operator's Stop does", async () => {
		await bootBesideRunningSender();
		const engine = { state: "streaming" as EngineRuntimeState };
		const s = session(engine);
		await s.orchestrator.reconcile();
		for (const cause of ["engine_loss", "reconfigure"] as const)
			expect(await s.orchestrator.stop(cause)).toEqual({
				result: "stop_failed",
				reason: "sender_held",
			});
		expect(s.stopRuntimeCalls).toEqual([]);
		expect(fake.state.active).toBe("active");
		expect(engine.state).toBe("streaming");
		expect(s.completed).toEqual([]);
		expect((await s.orchestrator.stop("operator")).result).toBe("stopped");
		expect(s.completed).toEqual(["operator"]);
	});

	test("Stop during startup on an idle session still settles the unit: no early answer while the host is unresolved", async () => {
		armSenderHostMode({ srtla_send_unit: true }, SENDER_UNIT_EXEC, fake.io());
		fake.state = {
			...fake.state,
			active: "activating",
			sub: "auto-restart",
			invocation: "gap",
		};
		const engine = { state: "idle" as EngineRuntimeState };
		const s = session(engine, { initialLiveness: "idle" });
		expect(await s.orchestrator.stop("operator")).toEqual({
			result: "stopped",
		});
		expect(s.stopRuntimeCalls).toEqual(["operator"]);
		expect(fake.state.active).toBe("inactive");
	});

	test("Stop during startup with the manager unreadable is a failed stop, not a stopped stream", async () => {
		armSenderHostMode({ srtla_send_unit: true }, SENDER_UNIT_EXEC, fake.io());
		fake.showFails = true;
		const engine = { state: "idle" as EngineRuntimeState };
		const s = session(engine, { initialLiveness: "idle" });
		expect(await s.orchestrator.stop("operator")).toEqual({
			result: "stop_failed",
			reason: "sender_unit_unresolved",
		});
		expect(s.completed).toEqual([]);
	});

	test("a Stop that times out before the unit comes down still settles idle once the cleanup finishes", async () => {
		await bootBesideRunningSender();
		const engine = { state: "streaming" as EngineRuntimeState };
		const slowEngine = Promise.withResolvers<void>();
		const s = session(engine, {
			stopDeadlineMs: 20,
			engineStop: () => slowEngine.promise,
		});
		// As main.ts wires it: a hold that ends asks the session to look again.
		onSenderUnitHoldChanged((change) => {
			if (change !== "held") void s.orchestrator.reevaluate();
		});
		await s.orchestrator.reconcile();
		const stopped = await s.orchestrator.stop("operator");
		expect(stopped).toEqual({ result: "stop_failed", reason: "stop_timeout" });
		// The engine and then the unit come down after the deadline answered.
		slowEngine.resolve();
		for (let i = 0; i < 50 && s.orchestrator.snapshot().state !== "idle"; i++)
			await Bun.sleep(2);
		expect(fake.state.active).toBe("inactive");
		expect(s.orchestrator.snapshot().state).toBe("idle");
		expect((await s.start()).result).toBe("started");
	});

	test("a re-evaluation asked for while a Stop is in flight is not lost", async () => {
		await bootBesideRunningSender();
		const engine = { state: "streaming" as EngineRuntimeState };
		const gate = Promise.withResolvers<void>();
		const s = session(engine, { engineStop: () => gate.promise });
		await s.orchestrator.reconcile();
		const stopping = s.orchestrator.stop("operator");
		// Asked while the stop owns the session: deferred, not dropped.
		await s.orchestrator.reevaluate();
		gate.resolve();
		expect((await stopping).result).toBe("stopped");
		await Bun.sleep(5);
		expect(s.orchestrator.snapshot().state).toBe("idle");
	});
});

test("two presses of one Stop complete once, and only after the cleanup is confirmed", async () => {
	await bootBesideRunningSender();
	const engine = { state: "streaming" as EngineRuntimeState };
	const gate = Promise.withResolvers<void>();
	const s = session(engine, { engineStop: () => gate.promise });
	await s.orchestrator.reconcile();
	const first = s.orchestrator.stop("operator");
	const second = s.orchestrator.stop("operator");
	expect(s.completed).toEqual([]);
	gate.resolve();
	expect((await first).result).toBe("stopped");
	expect((await second).result).toBe("stopped");
	expect(s.completed).toEqual(["operator"]);
});
