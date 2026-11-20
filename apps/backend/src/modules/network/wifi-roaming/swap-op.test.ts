import { describe, expect, test } from "bun:test";
import type { Effect, Epoch } from "../two-radio/reducer.ts";
import {
	CANDIDATE,
	HOLDER,
	type SpanOutcome,
	SWAP_TIMINGS,
	SwapOperation,
	type SwapTimings,
} from "./swap-op.ts";

const epoch = (bssid: string): Epoch => ({
	bssid,
	lease: `lease-${bssid}`,
	routeGeneration: 1,
	activation: `/act/${bssid}`,
});
const H = epoch("aa:aa:aa:aa:aa:01");
const C = epoch("bb:bb:bb:bb:bb:02");
const T0 = 1_000_000;

const pass: SpanOutcome = {
	candidate: "pass",
	holder: "pass",
	independentFailed: false,
};

function operation(timings?: SwapTimings): SwapOperation {
	return new SwapOperation({
		holder: "wlan1",
		candidate: "wlan2",
		holderEpoch: H,
		candidateEpoch: C,
		target: "receiver",
		now: T0,
		timings,
	});
}

/** Prove the candidate over one span ending at `at`. */
function prove(op: SwapOperation, at: number, outcome = pass) {
	op.startSpan(at - 3_000, "c-epoch", "h-epoch");
	return op.endSpan(at, outcome, "c-epoch", "h-epoch");
}

const only = (effects: readonly Effect[]): Effect => {
	expect(effects).toHaveLength(1);
	return effects[0] as Effect;
};

/** Drive a whole swap with renewals every second; returns the release effect. */
function runSwap(op: SwapOperation, renewEverySecond = true) {
	let t = T0 + 3_000;
	expect(prove(op, t).conclusion).toBe("proven");
	const promote = only(op.swap(t));
	expect(promote.action).toBe("promote");
	expect(promote.radio).toBe(CANDIDATE);
	op.ack(t, promote.command, true);
	const demote = only(op.traffic(t, C));
	expect(demote.action).toBe("demote");
	expect(demote.radio).toBe(HOLDER);
	op.ack(t, demote.command, true);
	expect(op.phase).toBe("linger");
	const effects: Effect[] = [];
	for (let i = 1; i <= 10; i++) {
		t += 1_000;
		if (renewEverySecond) effects.push(...op.renew(t, "c-epoch"));
		effects.push(...op.tick(t));
	}
	return { t, effects };
}

describe("swap timings", () => {
	test("the defaults are explicit", () => {
		expect(SWAP_TIMINGS.operationMs).toBe(30_000);
		expect(SWAP_TIMINGS.lingerMs).toBe(10_000);
		expect(SWAP_TIMINGS.emergencyMs).toBe(2_000);
	});

	test("a 10 s linger completes and releases the old holder", () => {
		const op = operation();
		const { t, effects } = runSwap(op);
		const release = only(effects);
		expect(release.action).toBe("disconnect");
		expect(release.radio).toBe(HOLDER);
		expect(op.state.holder).toBe(CANDIDATE);
		op.ack(t, release.command, true);
		expect(op.ended).toBe(true);
	});

	test("the reducer's own 5 s operation default would abort a 10 s linger", () => {
		const op = operation({ ...SWAP_TIMINGS, operationMs: 5_000 });
		const { effects } = runSwap(op);
		expect(effects.map((e) => e.action)).toContain("cancel-drain-restore");
		expect(op.state.holder).toBe(HOLDER);
	});

	test("without renewals the proof expires and the linger cancels", () => {
		const op = operation();
		const { effects } = runSwap(op, false);
		const cancel = only(effects);
		expect(cancel.action).toBe("cancel-drain-restore");
		expect(cancel.restore?.radio).toBe(HOLDER);
		expect(op.state.holder).toBe(HOLDER);
	});

	test("an operation that overruns its 30 s ends in a restore", () => {
		const op = operation();
		const t = T0 + 3_000;
		prove(op, t);
		const promote = only(op.swap(t));
		op.ack(t, promote.command, true);
		// The candidate never shows traffic; renewals keep its proof alive.
		let restore: Effect | undefined;
		for (let s = 1; s <= 31 && !restore; s++) {
			restore = [
				...op.renew(t + s * 1_000, "c-epoch"),
				...op.tick(t + s * 1_000),
			].find((e) => e.action === "cancel-drain-restore");
			if (restore) expect(s).toBe(30);
		}
		expect(restore).toBeDefined();
	});
});

describe("acks come from evidence", () => {
	test("a command without evidence by its deadline aborts", () => {
		const op = operation();
		const t = T0 + 3_000;
		prove(op, t);
		const promote = only(op.swap(t));
		op.ack(t, promote.command, true);
		const demote = only(op.traffic(t, C));
		op.expect(demote.command, t + 5_000);
		expect(op.tick(t + 4_999)).toHaveLength(0);
		const restore = only(op.tick(t + 5_000));
		expect(restore.action).toBe("cancel-drain-restore");
		// The demote's deadline is gone; the restore now has its own.
		expect(op.pendingCommands).toEqual([restore.command]);
	});

	test("evidence in time clears the deadline", () => {
		const op = operation();
		const t = T0 + 3_000;
		prove(op, t);
		const promote = only(op.swap(t));
		op.expect(promote.command, t + 5_000);
		op.ack(t + 1_000, promote.command, true);
		expect(op.pendingCommands).toHaveLength(0);
		expect(op.phase).toBe("traffic");
	});
});

describe("proof spans", () => {
	test("an inconclusive span proves nothing and a swap does nothing", () => {
		const op = operation();
		const step = prove(op, T0 + 3_000, {
			candidate: "inconclusive",
			holder: "pass",
			independentFailed: false,
		});
		expect(step.conclusion).toBe("inconclusive");
		expect(op.candidateProven).toBe(false);
		expect(op.swap(T0 + 3_000)).toHaveLength(0);
	});

	test("a failed span leaves the candidate unproven", () => {
		const op = operation();
		const step = prove(op, T0 + 3_000, {
			candidate: "fail",
			holder: "pass",
			independentFailed: false,
		});
		expect(step.conclusion).toBe("candidate-failed");
		expect(op.candidateProven).toBe(false);
	});

	test("both failing without a witness is the candidate's failure, not the receiver's", () => {
		const op = operation();
		const both = { candidate: "fail", holder: "fail" } as const;
		const step = prove(op, T0 + 3_000, { ...both, independentFailed: false });
		expect(step.conclusion).toBe("candidate-failed");
		expect(op.state.suspectTargets).toHaveLength(0);
		// A later proof still works: nothing was marked suspect.
		expect(prove(op, T0 + 7_000).conclusion).toBe("proven");
		expect(op.swap(T0 + 7_000)).toHaveLength(1);
	});

	test("both failing next to a failing independent link marks the receiver suspect", () => {
		const op = operation();
		const step = prove(op, T0 + 3_000, {
			candidate: "fail",
			holder: "fail",
			independentFailed: true,
		});
		expect(step.conclusion).toBe("common-target");
		expect(op.state.suspectTargets).toEqual(["receiver"]);
		prove(op, T0 + 7_000);
		expect(op.swap(T0 + 7_000)).toHaveLength(0);
	});

	test("a new operation starts with no suspect receiver", () => {
		const first = operation();
		prove(first, T0 + 3_000, {
			candidate: "fail",
			holder: "fail",
			independentFailed: true,
		});
		const second = operation();
		expect(second.state.suspectTargets).toHaveLength(0);
	});
});

describe("emergency promotion", () => {
	test("a holder failing next to a proven candidate is promoted after exactly 2 s", () => {
		const op = operation();
		const t = T0 + 3_000;
		const step = prove(op, t, {
			candidate: "pass",
			holder: "fail",
			independentFailed: false,
		});
		expect(step.conclusion).toBe("proven");
		op.renew(t + 1_000, "c-epoch");
		expect(op.tick(t + 1_999)).toHaveLength(0);
		const promote = only(op.tick(t + 2_000));
		expect(promote.action).toBe("promote");
		expect(promote.radio).toBe(CANDIDATE);
	});

	test("a holder that passes never triggers it", () => {
		const op = operation();
		const t = T0 + 3_000;
		prove(op, t);
		op.renew(t + 1_000, "c-epoch");
		expect(op.tick(t + 2_500)).toHaveLength(0);
	});
});

describe("identity changes", () => {
	test("losing the old holder mid-operation aborts it", () => {
		const op = operation();
		const t = T0 + 3_000;
		prove(op, t);
		const promote = only(op.swap(t));
		op.ack(t, promote.command, true);
		const restore = only(op.identity(t + 500, HOLDER, null));
		expect(restore.action).toBe("cancel-drain-restore");
	});

	test("an ended operation ignores everything", () => {
		const op = operation();
		op.end();
		expect(op.ended).toBe(true);
		expect(prove(op, T0 + 3_000).effects).toHaveLength(0);
		expect(op.swap(T0 + 3_000)).toHaveLength(0);
	});
});

describe("how an operation ends", () => {
	/** Prove, promote and demote; returns the time at the start of the linger. */
	function intoLinger(op: SwapOperation): number {
		const t = T0 + 3_000;
		prove(op, t);
		const promote = only(op.swap(t));
		op.ack(t, promote.command, true);
		const demote = only(op.traffic(t, C));
		op.ack(t, demote.command, true);
		return t;
	}

	test("a completed swap ends as released", () => {
		const op = operation();
		const { t, effects } = runSwap(op);
		op.ack(t, only(effects).command, true);
		expect(op.endReason).toBe("released");
	});

	test("a confirmed restore ends as restored", () => {
		const op = operation();
		const t = intoLinger(op);
		const restore = only(op.cancel(t + 1_000));
		op.ack(t + 2_000, restore.command, true);
		expect(op.ended).toBe(true);
		expect(op.endReason).toBe("restored");
	});

	test("a restore without evidence by its deadline ends the operation as restore-failed", () => {
		const op = operation();
		const t = intoLinger(op);
		const restore = only(op.cancel(t + 1_000));
		expect(restore.action).toBe("cancel-drain-restore");
		op.expect(restore.command, t + 11_000);
		expect(op.tick(t + 10_999)).toHaveLength(0);
		expect(op.ended).toBe(false);
		expect(op.tick(t + 11_000)).toHaveLength(0);
		expect(op.ended).toBe(true);
		expect(op.endReason).toBe("restore-failed");
		expect(op.phase).toBe("done");
	});

	test("every restore gets the 10 s evidence deadline without the caller arming it", () => {
		expect(SWAP_TIMINGS.restoreEvidenceMs).toBe(10_000);
		const op = operation();
		const t = intoLinger(op);
		const restore = only(op.cancel(t + 1_000));
		expect(op.pendingCommands).toEqual([restore.command]);
		op.tick(t + 10_999);
		expect(op.ended).toBe(false);
		op.tick(t + 11_000);
		expect(op.endReason).toBe("restore-failed");
	});

	test("a restore the reducer starts on its own is armed too", () => {
		const op = operation();
		const { effects } = runSwap(op, false);
		const restore = only(effects);
		expect(restore.action).toBe("cancel-drain-restore");
		expect(op.pendingCommands).toEqual([restore.command]);
	});

	test("a refused restore ends the operation as restore-failed", () => {
		const op = operation();
		const t = intoLinger(op);
		const restore = only(op.cancel(t + 1_000));
		op.ack(t + 1_500, restore.command, false);
		expect(op.endReason).toBe("restore-failed");
	});

	test("dropping an operation records it", () => {
		const op = operation();
		op.end();
		expect(op.endReason).toBe("dropped");
	});
});

describe("renewals", () => {
	test("a renewal keeps the proof exactly renewMs ahead", () => {
		const op = operation();
		const t = T0 + 3_000;
		prove(op, t);
		op.renew(t + 1_000, "c-epoch");
		op.tick(t + 3_999);
		expect(op.candidateProven).toBe(true);
		op.tick(t + 4_000);
		expect(op.candidateProven).toBe(false);
	});

	test("a renewal under another sender epoch is refused", () => {
		const op = operation();
		const t = T0 + 3_000;
		op.startSpan(t - 3_000, "c-epoch-1", null);
		op.endSpan(
			t,
			{ candidate: "pass", holder: "inconclusive", independentFailed: false },
			"c-epoch-1",
			null,
		);
		// The span's own proof lapses at +9 s; a renewal at +8 s under another
		// epoch must not carry it past that.
		expect(op.renew(t + 8_000, "c-epoch-2")).toHaveLength(0);
		op.tick(t + 10_000);
		expect(op.candidateProven).toBe(false);
	});

	test("a lapsed proof is not renewed; the candidate has to prove itself again", () => {
		const op = operation();
		const t = T0 + 3_000;
		op.startSpan(t - 3_000, "c-epoch", null);
		op.endSpan(
			t,
			{ candidate: "pass", holder: "inconclusive", independentFailed: false },
			"c-epoch",
			null,
		);
		// No event between the lapse and the renewal: the expired proof is still
		// in the reducer's state when the renewal looks at it.
		expect(op.renew(t + 14_000, "c-epoch")).toHaveLength(0);
		// `candidateProven` answers as of the last event; bring it to now.
		op.tick(t + 14_000);
		expect(op.candidateProven).toBe(false);
	});
});
