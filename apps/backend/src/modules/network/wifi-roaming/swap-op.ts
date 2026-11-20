/**
 * One holder/candidate swap, run through the two-radio reducer's safety rules.
 *
 * The reducer (`two-radio/reducer.ts`) already enforces the rules a swap needs:
 * one operation at a time, holders never depart, proofs bound to an epoch and
 * expiring, traffic before demotion, linger, a cancel that restores the old
 * holder, and no swap when both paths fail against the same target. This adapter
 * fixes how the roaming coordinator drives it:
 *
 * - One reducer state per operation. It is created when a proof starts for a
 *   pair and discarded when the operation ends, so `suspectTargets` and the
 *   used-challenge lists never outlive one swap. Slot `a` is the holder and slot
 *   `b` the candidate.
 * - Explicit timings. The reducer fixes an operation's deadline when it is
 *   created, so `operationMs` covers promote, traffic, demote, the linger,
 *   release and their acks.
 * - One challenge covers a whole proof span. The proof module decides when a
 *   span is proven or failed; the challenge is answered then. While the
 *   candidate keeps passing, a renewal (a fresh challenge answered at once)
 *   keeps its proof alive a few seconds ahead, through traffic and linger.
 * - Common-target failures need a witness. Holder and candidate failing the
 *   same span only marks the receiver suspect when a second, independent link
 *   failed too. Otherwise it is the candidate's failure.
 * - Acks come from evidence. A command the coordinator cannot confirm before
 *   its deadline is acked as failed, which aborts.
 *
 * Pure apart from what callers pass in: no IO, no clock.
 */

import {
	type Effect,
	type Epoch,
	initialState,
	type Radio,
	reduce,
	type State,
	useful,
} from "../two-radio/reducer.ts";
import { RESTORE_EVIDENCE_MS } from "./sender-links.ts";

export type SwapTimings = Readonly<{
	/** The whole operation, fixed when it is created. */
	operationMs: number;
	/** The old holder stays associated this long after demotion. */
	lingerMs: number;
	/** A holder that failed a round next to a proven candidate is promoted after this. */
	emergencyMs: number;
	/** A proof span's challenge must be answered within this. */
	proofChallengeMs: number;
	/** How far ahead a passing candidate's proof is renewed. */
	renewMs: number;
	/**
	 * Every restore the adapter emits must be confirmed within this, or the
	 * operation ends as `restore-failed`. Armed automatically; `expect()` can
	 * change it.
	 */
	restoreEvidenceMs: number;
}>;

export const SWAP_TIMINGS: SwapTimings = {
	operationMs: 30_000,
	lingerMs: 10_000,
	emergencyMs: 2_000,
	proofChallengeMs: 12_000,
	renewMs: 3_000,
	restoreEvidenceMs: RESTORE_EVIDENCE_MS,
};

export const HOLDER: Radio = "a";
export const CANDIDATE: Radio = "b";

/** What one span's evaluation said about each link of the pair. */
export type SpanVerdict = "pass" | "fail" | "inconclusive";

export type SpanOutcome = Readonly<{
	candidate: SpanVerdict;
	holder: SpanVerdict;
	/** A link outside the pair (cellular, Ethernet, another assister) failed in the same span. */
	independentFailed: boolean;
}>;

/** What the coordinator should conclude from a span besides the reducer's effects. */
export type SpanConclusion =
	| "proven"
	| "candidate-failed"
	| "common-target"
	| "inconclusive";

export type SwapStep = Readonly<{
	effects: readonly Effect[];
	conclusion?: SpanConclusion;
}>;

type PendingAck = { command: number; deadline: number };

/**
 * How an operation ended: the old holder released, the old holder restored
 * after an abort, a restore that could not be confirmed (the coordinator
 * re-releases the hold and treats the old holder through the abrupt-loss path
 * if it stays absent), or dropped by the caller.
 */
export type SwapEnd = "released" | "restored" | "restore-failed" | "dropped";

export class SwapOperation {
	readonly holder: string;
	readonly candidate: string;
	readonly target: string;
	readonly timings: SwapTimings;
	#state: State;
	#origin: number;
	#span: { round: string; started: number } | null = null;
	#renewals = 0;
	#spans = 0;
	#pending: PendingAck[] = [];
	#ended = false;
	#endReason: SwapEnd | null = null;

	constructor(
		opts: Readonly<{
			holder: string;
			candidate: string;
			holderEpoch: Epoch;
			candidateEpoch: Epoch;
			/** The receiver the bond sends to. */
			target: string;
			now: number;
			timings?: SwapTimings;
		}>,
	) {
		this.holder = opts.holder;
		this.candidate = opts.candidate;
		this.target = opts.target;
		this.timings = opts.timings ?? SWAP_TIMINGS;
		this.#origin = opts.now;
		this.#state = initialState({
			operationMs: this.timings.operationMs,
			lingerMs: this.timings.lingerMs,
			emergencyMs: this.timings.emergencyMs,
		});
		this.#feed(opts.now, {
			type: "identity",
			radio: HOLDER,
			epoch: opts.holderEpoch,
		});
		this.#feed(opts.now, {
			type: "identity",
			radio: CANDIDATE,
			epoch: opts.candidateEpoch,
		});
	}

	/** The reducer's view, for status and tests. */
	get state(): Readonly<State> {
		return this.#state;
	}

	/** Phase of the running operation, `idle` before promotion, `done` after. */
	get phase(): string {
		if (this.#ended) return "done";
		return this.#state.op?.phase ?? "idle";
	}

	/** The candidate holds a live proof, as of the last event fed in. */
	get candidateProven(): boolean {
		return useful(this.#state, CANDIDATE);
	}

	/** The reducer finished an operation, or the caller dropped this one. */
	get ended(): boolean {
		return this.#ended;
	}

	/** How the operation ended, `null` while it runs. */
	get endReason(): SwapEnd | null {
		return this.#endReason;
	}

	/** Drop the operation (abrupt holder loss): nothing it says applies any more. */
	end(): void {
		this.#finish("dropped");
	}

	#finish(reason: SwapEnd): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#endReason = reason;
		this.#pending = [];
	}

	/**
	 * Open a proof span for the pair. `holderSocket`/`candidateSocket` are the
	 * links' `srtla_ack_epoch`s; the holder is challenged only when its link is
	 * mapped.
	 */
	startSpan(
		now: number,
		candidateSocket: string,
		holderSocket: string | null,
	): readonly Effect[] {
		if (this.#ended) return [];
		const round = `span-${++this.#spans}`;
		this.#span = { round, started: now };
		const expiresAt = this.#at(now) + this.timings.proofChallengeMs;
		const effects = this.#challenge(
			now,
			CANDIDATE,
			candidateSocket,
			round,
			expiresAt,
		);
		if (holderSocket !== null)
			effects.push(
				...this.#challenge(now, HOLDER, holderSocket, round, expiresAt),
			);
		return effects;
	}

	/**
	 * Answer the open span. A passing candidate becomes `useful` in the reducer.
	 * Both failing reaches the reducer as a completed round only with an
	 * independent witness; otherwise it is the candidate's failure.
	 */
	endSpan(
		now: number,
		outcome: SpanOutcome,
		candidateSocket: string,
		holderSocket: string | null,
	): SwapStep {
		const span = this.#span;
		if (this.#ended || !span) return { effects: [] };
		this.#span = null;
		const effects: Effect[] = [];
		if (outcome.candidate === "inconclusive")
			return { effects, conclusion: "inconclusive" };
		effects.push(
			...this.#respond(
				now,
				CANDIDATE,
				candidateSocket,
				span.round,
				outcome.candidate === "pass",
			),
		);
		const holderAnswered =
			holderSocket !== null && outcome.holder !== "inconclusive";
		if (holderAnswered)
			effects.push(
				...this.#respond(
					now,
					HOLDER,
					holderSocket,
					span.round,
					outcome.holder === "pass",
				),
			);
		const bothFailed =
			outcome.candidate === "fail" && outcome.holder === "fail";
		let conclusion: SpanConclusion =
			outcome.candidate === "pass" ? "proven" : "candidate-failed";
		if (holderAnswered && (!bothFailed || outcome.independentFailed)) {
			effects.push(
				...this.#feed(now, {
					type: "round-complete",
					target: this.target,
					round: span.round,
				}),
			);
			if (bothFailed) conclusion = "common-target";
		}
		return { effects, conclusion };
	}

	/** Keep a passing candidate's proof alive `renewMs` ahead. */
	renew(now: number, candidateSocket: string): readonly Effect[] {
		if (this.#ended) return [];
		// Only a live proof taken under this same sender epoch is extended: a
		// candidate whose connection was replaced, or whose proof lapsed, has to
		// prove itself again over a new span.
		const proof = this.#state.paths[CANDIDATE].proof;
		if (
			!proof ||
			proof.socket !== candidateSocket ||
			proof.expiresAt <= this.#at(now) ||
			!useful(this.#state, CANDIDATE)
		)
			return [];
		const round = `renew-${++this.#renewals}`;
		return [
			...this.#challenge(
				now,
				CANDIDATE,
				candidateSocket,
				round,
				this.#at(now) + this.timings.renewMs,
			),
			...this.#respond(now, CANDIDATE, candidateSocket, round, true),
		];
	}

	/** Promote the proven candidate. No effect unless it holds a live proof. */
	swap(now: number): readonly Effect[] {
		return this.#feed(now, { type: "swap" });
	}

	/** The candidate carries traffic as the new holder-designate. */
	traffic(now: number, epoch: Epoch): readonly Effect[] {
		const op = this.#state.op;
		if (!op) return [];
		return this.#feed(now, {
			type: "traffic",
			operation: op.id,
			radio: CANDIDATE,
			epoch,
		});
	}

	/** Confirm (or refuse) a command from evidence. */
	ack(now: number, command: number, ok: boolean): readonly Effect[] {
		const op = this.#state.op;
		if (!op) return [];
		this.#pending = this.#pending.filter((p) => p.command !== command);
		// The reducer's abort is a no-op in cleanup, so a restore that fails
		// would leave the operation there for good and block every later move.
		if (!ok && op.phase === "cleanup" && command === op.command) {
			this.#finish("restore-failed");
			return [];
		}
		return this.#feed(now, { type: "ack", operation: op.id, command, ok });
	}

	cancel(now: number): readonly Effect[] {
		const op = this.#state.op;
		if (!op) return [];
		return this.#feed(now, { type: "cancel", operation: op.id });
	}

	/** A radio's activation epoch changed, or it is gone (`null`). */
	identity(now: number, radio: Radio, epoch: Epoch | null): readonly Effect[] {
		return this.#feed(now, { type: "identity", radio, epoch });
	}

	/**
	 * Advance time: the emergency promotion, the linger's end, the operation
	 * deadline, and commands whose evidence did not arrive in time.
	 */
	tick(now: number): readonly Effect[] {
		if (this.#ended) return [];
		const out: Effect[] = [];
		const late = this.#pending.filter((p) => now >= p.deadline);
		for (const p of late) out.push(...this.ack(now, p.command, false));
		out.push(...this.#feed(now, { type: "tick" }));
		return out;
	}

	/**
	 * Expect evidence for a command by `deadline` (absolute). Without one, a
	 * command is acked only by an explicit `ack`.
	 */
	expect(command: number, deadline: number): void {
		const pending = this.#pending.find((p) => p.command === command);
		if (pending) pending.deadline = deadline;
		else this.#pending.push({ command, deadline });
	}

	/** Commands still waiting for evidence. */
	get pendingCommands(): readonly number[] {
		return this.#pending.map((p) => p.command);
	}

	#at(now: number): number {
		return Math.max(this.#state.now, now - this.#origin);
	}

	#feed(now: number, event: Parameters<typeof reduce>[1]["event"]): Effect[] {
		if (this.#ended) return [];
		const t = reduce(this.#state, {
			version: 1,
			at: this.#at(now),
			event,
		});
		const before = this.#state.op?.phase;
		this.#state = t.state;
		if (before !== undefined && this.#state.op === null)
			this.#finish(before === "cleanup" ? "restored" : "released");
		// A new command supersedes the ones before it: the reducer only accepts
		// an ack for the current one.
		const current = this.#state.op?.command;
		this.#pending = this.#pending.filter((p) => p.command === current);
		// A restore must not wait for evidence forever, whatever the caller does.
		for (const e of t.effects)
			if (
				e.action === "cancel-drain-restore" &&
				!this.#pending.some((p) => p.command === e.command)
			)
				this.#pending.push({
					command: e.command,
					deadline: now + this.timings.restoreEvidenceMs,
				});
		return t.effects;
	}

	#challenge(
		now: number,
		radio: Radio,
		socket: string,
		round: string,
		expiresAt: number,
	): Effect[] {
		const epoch = this.#state.paths[radio].epoch;
		if (!epoch) return [];
		const at = this.#at(now);
		return this.#feed(now, {
			type: "challenge",
			deviceBound: true,
			challenge: {
				id: `${round}:${radio}`,
				radio,
				epoch,
				target: this.target,
				round,
				socket,
				startedAt: at,
				expiresAt,
			},
		});
	}

	#respond(
		now: number,
		radio: Radio,
		socket: string,
		round: string,
		ok: boolean,
	): Effect[] {
		const epoch = this.#state.paths[radio].epoch;
		if (!epoch) return [];
		return this.#feed(now, {
			type: "response",
			id: `${round}:${radio}`,
			radio,
			epoch,
			socket,
			nonce: `${round}:${radio}`,
			ok,
		});
	}
}
