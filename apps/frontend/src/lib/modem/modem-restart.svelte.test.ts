import type {
	RestartModemInput,
	RestartModemOutput,
} from "@ceraui/rpc/schemas";
import { describe, expect, it, vi } from "vitest";

import type { LoadOutcome } from "./async-surface";
import { ModemRestartFlow, restartTargetFor } from "./modem-restart.svelte";

const TARGET_KEY = "platform-fc800000.usb-usb-0:1.4";

const TARGET = {
	device: "4",
	stableKey: TARGET_KEY,
	name: "DW5821e",
	expectedSeconds: 35,
};

const direct = <T>(run: () => Promise<T>): Promise<LoadOutcome<T>> =>
	run().then(
		(value) => ({ phase: "loaded", value }) as const,
		(error) => ({ phase: "failed", error }) as const,
	);

function flowWith(...answers: RestartModemOutput[]) {
	const call = vi.fn((_input: RestartModemInput) => {
		const next = answers.shift();
		return next
			? Promise.resolve(next)
			: Promise.reject(new Error("no answer scripted"));
	});
	return { call, flow: new ModemRestartFlow(call, () => 1000, direct) };
}

describe("restartTargetFor", () => {
	it("offers the action only for a qualified model with a stable key", () => {
		expect(
			restartTargetFor(
				"2",
				{ model: "RM520N-GL", stable_key: "k" },
				"RM520N-GL",
			),
		).toEqual({
			device: "2",
			stableKey: "k",
			name: "RM520N-GL",
			expectedSeconds: 55,
		});
		expect(restartTargetFor("2", { model: "RM520N-GL" }, "x")).toBeUndefined();
		expect(
			restartTargetFor("3", { model: "FM350-GL", stable_key: "k" }, "x"),
		).toBeUndefined();
		expect(
			restartTargetFor("1", { model: "EM7455", stable_key: "k" }, "x"),
		).toBeUndefined();
	});
});

describe("ModemRestartFlow", () => {
	it("asks first, then restarts and keeps the result by stable key", async () => {
		const { call, flow } = flowWith({
			started: true,
			outcome: "back_connected",
			method: "mm-reset",
			elapsedSeconds: 33,
			device: "5",
		});
		flow.ask(TARGET, false);
		expect(flow.phase.kind).toBe("confirm");
		expect(call).not.toHaveBeenCalled();
		const running = flow.confirm();
		expect(flow.phase.kind).toBe("restarting");
		expect(flow.busy).toBe(true);
		await running;
		expect(call).toHaveBeenCalledWith({
			device: "4",
			stableKey: TARGET_KEY,
			confirm: true,
		});
		expect(flow.phase).toMatchObject({
			kind: "result",
			result: { outcome: "back_connected" },
		});
		expect(flow.stableKey).toBe(TARGET.stableKey);
	});

	it("turns only_link_live into a second confirmation, then sends it confirmed", async () => {
		const { call, flow } = flowWith(
			{ started: false, refusal: "only_link_live" },
			{ started: true, outcome: "back_connected", elapsedSeconds: 34 },
		);
		flow.ask(TARGET, true);
		await flow.confirm();
		expect(flow.phase.kind).toBe("confirm-only-link");
		await flow.confirm();
		expect(call).toHaveBeenLastCalledWith({
			device: "4",
			stableKey: TARGET_KEY,
			confirm: true,
			onlyLinkConfirmed: true,
		});
		expect(flow.phase.kind).toBe("result");
	});

	it("cancelling the second confirmation sends nothing more", async () => {
		const { call, flow } = flowWith({
			started: false,
			refusal: "only_link_live",
		});
		flow.ask(TARGET, true);
		await flow.confirm();
		flow.cancel();
		expect(flow.phase.kind).toBe("idle");
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("reports a refusal with its retry time", async () => {
		const { flow } = flowWith({
			started: false,
			refusal: "cooldown",
			retryAfterSeconds: 120,
		});
		flow.ask(TARGET, false);
		await flow.confirm();
		expect(flow.phase).toMatchObject({
			kind: "refused",
			refusal: "cooldown",
			retryAfterSeconds: 120,
		});
	});

	it("a call that never answers ends as no-answer, never as success", async () => {
		const call = vi.fn(async () => ({ started: true }) as RestartModemOutput);
		const flow = new ModemRestartFlow(
			call,
			() => 0,
			async () => ({ phase: "timed-out", boundMs: 170_000 }),
		);
		flow.ask(TARGET, false);
		await flow.confirm();
		expect(flow.phase.kind).toBe("no-answer");
	});

	it("one at a time: no new question while a restart runs, and it cannot be dismissed", async () => {
		let release: (value: RestartModemOutput) => void = () => {};
		const call = vi.fn(
			() =>
				new Promise<RestartModemOutput>((resolve) => {
					release = resolve;
				}),
		);
		const flow = new ModemRestartFlow(call, () => 0, direct);
		flow.ask(TARGET, false);
		const running = flow.confirm();
		flow.ask({ ...TARGET, device: "2", stableKey: "other" }, false);
		flow.dismiss();
		expect(flow.phase.kind).toBe("restarting");
		release({ started: true, outcome: "not_back", elapsedSeconds: 120 });
		await running;
		expect(flow.phase.kind).toBe("result");
		flow.dismiss();
		expect(flow.phase.kind).toBe("idle");
	});
});
