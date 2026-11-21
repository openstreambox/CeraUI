import { afterEach, beforeEach, expect, test } from "bun:test";
import { setForwardActive } from "../streaming/forward-activity.ts";
import {
	resetLifecycleInterlock,
	setMutationBlocks,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	resetRecoveryBarrier,
} from "../streaming/recovery-barrier.ts";
import { withBackgroundModemLease } from "./mutation-lease.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";

beforeEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setForwardActive(false);
	setMutationBlocks([]);
});
afterEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setForwardActive(false);
	setMutationBlocks([]);
});

test("a background lease leaves Stream Start admitted and excludes the same modem", async () => {
	const outcome = await withBackgroundModemLease(KEY, async () => {
		const start = tryAcquireLifecycle("streaming");
		expect(start.admitted).toBe(true);
		if (start.admitted) start.lease.release();
		const save = tryAcquireModemMutation(KEY);
		expect(save).toMatchObject({
			admitted: false,
			refusal: "mutation_in_progress",
		});
		expect(tryAcquireModemMutation(`${KEY}.other`).admitted).toBe(true);
		return "ran";
	});
	expect(outcome).toEqual({ ok: true, value: "ran" });
	expect(tryAcquireModemMutation(KEY).admitted).toBe(true);
});

test("a background lease never starts under replay, a block, a launch, forwarding or a held key", async () => {
	let ran = 0;
	const run = async () => {
		ran++;
	};
	expect(await withBackgroundModemLease(undefined, run)).toEqual({
		ok: false,
		refusal: "identity_unresolved",
	});
	beginRecoveryBarrier();
	expect(await withBackgroundModemLease(KEY, run)).toEqual({
		ok: false,
		refusal: "recovery_pending",
	});
	resetRecoveryBarrier();
	setMutationBlocks([
		{ stableKey: KEY, refusal: "mutation_blocked", blocksStreaming: true },
	]);
	expect(await withBackgroundModemLease(KEY, run)).toEqual({
		ok: false,
		refusal: "mutation_blocked",
	});
	setMutationBlocks([]);
	const launch = tryAcquireLifecycle("streaming");
	if (!launch.admitted) throw new Error("launch refused");
	expect(await withBackgroundModemLease(KEY, run)).toEqual({
		ok: false,
		refusal: "streaming_active",
	});
	launch.lease.release();
	setForwardActive(true);
	expect(await withBackgroundModemLease(KEY, run)).toEqual({
		ok: false,
		refusal: "streaming_active",
	});
	setForwardActive(false);
	const held = tryAcquireModemMutation(KEY);
	if (!held.admitted) throw new Error("lease refused");
	expect(await withBackgroundModemLease(KEY, run)).toEqual({
		ok: false,
		refusal: "mutation_in_progress",
	});
	held.lease.release();
	expect(ran).toBe(0);
	expect(await withBackgroundModemLease(KEY, run)).toEqual({
		ok: true,
		value: undefined,
	});
	expect(ran).toBe(1);
});
