/** Deterministic policy only. See README.md for effect/trace adapter obligations. */
export type Radio = "a" | "b";
export type Epoch = Readonly<{
	bssid: string;
	lease: string;
	routeGeneration: number;
	activation: string;
}>;
export type Action =
	| "disconnect"
	| "reassociate"
	| "scan"
	| "reapply"
	| "forced-renew";
export type Challenge = Readonly<{
	id: string;
	radio: Radio;
	epoch: Epoch;
	target: string;
	round: string;
	socket: string;
	startedAt: number;
	expiresAt: number;
}>;
export type Proof = Challenge & Readonly<{ completedAt: number }>;
type Path = {
	epoch: Epoch | null;
	proof: Proof | null;
	label: "unknown" | "useful" | "disproved";
};
type Operation = {
	id: number;
	command: number;
	radio: Radio;
	epoch: Epoch;
	phase:
		| Action
		| "promote"
		| "traffic"
		| "demote"
		| "linger"
		| "release"
		| "cleanup";
	deadline: number;
	old: Radio;
	oldEpoch: Epoch | null;
	lingerUntil: number;
};
export type State = {
	now: number;
	holder: Radio;
	paths: Record<Radio, Path>;
	challenges: Record<string, Challenge>;
	usedChallenges: readonly string[];
	results: Record<string, Partial<Record<Radio, "pass" | "fail">>>;
	closedRounds: readonly string[];
	suspectTargets: readonly string[];
	emergencyAt: number | null;
	op: Operation | null;
	nextId: number;
	config: Readonly<{
		operationMs: number;
		lingerMs: number;
		emergencyMs: number;
	}>;
};
export type Event =
	| { type: "tick" }
	| { type: "identity"; radio: Radio; epoch: Epoch | null }
	| { type: "challenge"; challenge: Challenge; deviceBound: boolean }
	| {
			type: "response";
			id: string;
			radio: Radio;
			epoch: Epoch;
			socket: string;
			nonce: string;
			ok: boolean;
	  }
	| { type: "round-complete"; target: string; round: string }
	| { type: "depart"; radio: Radio; action: Action }
	| { type: "swap" }
	| { type: "traffic"; operation: number; radio: Radio; epoch: Epoch }
	| { type: "ack"; operation: number; command: number; ok: boolean }
	| { type: "cancel"; operation: number };
/** JSON-serializable, monotonic milliseconds relative to one trace origin. */
export type TraceEvent = Readonly<{ version: 1; at: number; event: Event }>;
export type Effect = Readonly<{
	operation: number;
	command: number;
	radio: Radio;
	epoch: Epoch;
	action: Action | "promote" | "demote" | "cancel-drain-restore";
	restore: Readonly<{ radio: Radio; epoch: Epoch | null }> | null;
}>;
export type Transition = { state: State; effects: Effect[] };
const other = (r: Radio): Radio => (r === "a" ? "b" : "a");
export const sameEpoch = (a: Epoch | null, b: Epoch | null): boolean =>
	a !== null &&
	b !== null &&
	a.bssid === b.bssid &&
	a.lease === b.lease &&
	a.routeGeneration === b.routeGeneration &&
	a.activation === b.activation;
const key = (target: string, round: string): string =>
	JSON.stringify([target, round]);
export function initialState(
	config = { operationMs: 5_000, lingerMs: 1_000, emergencyMs: 2_000 },
): State {
	if (Object.values(config).some((v) => !Number.isFinite(v) || v <= 0))
		throw new Error("Invalid timing");
	return {
		now: 0,
		holder: "a",
		paths: {
			a: { epoch: null, proof: null, label: "unknown" },
			b: { epoch: null, proof: null, label: "unknown" },
		},
		challenges: {},
		usedChallenges: [],
		results: {},
		closedRounds: [],
		suspectTargets: [],
		emergencyAt: null,
		op: null,
		nextId: 1,
		config: { ...config },
	};
}
export function useful(s: State, r: Radio): boolean {
	const p = s.paths[r].proof;
	return (
		p !== null &&
		sameEpoch(p.epoch, s.paths[r].epoch) &&
		p.expiresAt > s.now &&
		!s.suspectTargets.includes(p.target)
	);
}
export function reduce(previous: State, row: TraceEvent): Transition {
	if (row.version !== 1 || !Number.isFinite(row.at) || row.at < previous.now)
		throw new Error("Invalid trace time/version");
	const s = structuredClone(previous);
	s.now = row.at;
	const effects: Effect[] = [];
	const emit = (op: Operation, action: Effect["action"]) => {
		op.command = s.nextId++;
		effects.push({
			operation: op.id,
			command: op.command,
			radio: op.radio,
			epoch: op.epoch,
			action,
			restore:
				action === "cancel-drain-restore"
					? { radio: op.old, epoch: op.oldEpoch }
					: null,
		});
	};
	const abort = () => {
		const op = s.op;
		if (!op || op.phase === "cleanup") return;
		if (op.phase === "release") {
			op.old = s.holder;
			op.oldEpoch = s.paths[s.holder].epoch;
		}
		op.phase = "cleanup";
		emit(op, "cancel-drain-restore");
	};
	for (const r of ["a", "b"] as const) {
		if (s.paths[r].proof && !useful(s, r)) {
			s.paths[r].proof = null;
			s.paths[r].label = "unknown";
		}
	}
	if (s.op && s.now >= s.op.deadline) abort();
	const e = row.event;
	switch (e.type) {
		case "identity": {
			if (!sameEpoch(s.paths[e.radio].epoch, e.epoch)) {
				s.paths[e.radio] = { epoch: e.epoch, proof: null, label: "unknown" };
				s.results = {};
				s.emergencyAt = null;
				for (const [id, c] of Object.entries(s.challenges))
					if (c.radio === e.radio) delete s.challenges[id];
				if (s.op && (s.op.radio === e.radio || s.op.old === e.radio)) abort();
			}
			break;
		}
		case "challenge": {
			const c = e.challenge;
			if (
				e.deviceBound &&
				c.socket &&
				c.id &&
				c.target &&
				c.round &&
				c.startedAt === s.now &&
				c.expiresAt > s.now &&
				Number.isFinite(c.expiresAt) &&
				sameEpoch(c.epoch, s.paths[c.radio].epoch) &&
				!s.usedChallenges.includes(c.id) &&
				!s.closedRounds.includes(key(c.target, c.round)) &&
				!s.results[key(c.target, c.round)]?.[c.radio]
			) {
				s.challenges[JSON.stringify(c.id)] = structuredClone(c);
				s.usedChallenges = [...s.usedChallenges, c.id];
			}
			break;
		}
		case "response": {
			const c = s.challenges[JSON.stringify(e.id)];
			if (
				!c ||
				e.nonce !== c.id ||
				e.radio !== c.radio ||
				e.socket !== c.socket ||
				!sameEpoch(e.epoch, c.epoch) ||
				!sameEpoch(c.epoch, s.paths[c.radio].epoch) ||
				s.now >= c.expiresAt ||
				s.closedRounds.includes(key(c.target, c.round)) ||
				s.results[key(c.target, c.round)]?.[c.radio]
			)
				break;
			delete s.challenges[JSON.stringify(e.id)];
			const k = key(c.target, c.round);
			s.results[k] = { ...s.results[k], [c.radio]: e.ok ? "pass" : "fail" };
			if (e.ok) {
				s.paths[c.radio] = {
					epoch: c.epoch,
					label: "useful",
					proof: { ...c, completedAt: s.now },
				};
				if (c.radio === s.holder) s.emergencyAt = null;
			} else {
				s.paths[c.radio].proof = null;
				s.paths[c.radio].label = "disproved";
			}
			break;
		}
		case "round-complete": {
			const k = key(e.target, e.round);
			const r = s.results[k];
			if (s.closedRounds.includes(k) || !r?.a || !r.b) break;
			s.closedRounds = [...s.closedRounds, k];
			if (r.a === "fail" && r.b === "fail") {
				s.suspectTargets = [...new Set([...s.suspectTargets, e.target])];
				s.emergencyAt = null;
				abort();
			} else if (r[s.holder] === "fail") s.emergencyAt ??= s.now;
			break;
		}
		case "depart": {
			const epoch = s.paths[e.radio].epoch;
			if (s.op || e.radio === s.holder || !epoch) break;
			const id = s.nextId++;
			s.op = {
				id,
				command: 0,
				radio: e.radio,
				epoch,
				phase: e.action,
				deadline: s.now + s.config.operationMs,
				old: s.holder,
				oldEpoch: s.paths[s.holder].epoch,
				lingerUntil: 0,
			};
			s.paths[e.radio].proof = null;
			s.paths[e.radio].label = "unknown";
			emit(s.op, e.action);
			break;
		}
		case "swap": {
			const r = other(s.holder),
				epoch = s.paths[r].epoch;
			if (s.op || !epoch || !s.paths[s.holder].epoch || !useful(s, r)) break;
			const id = s.nextId++;
			s.op = {
				id,
				command: 0,
				radio: r,
				epoch,
				phase: "promote",
				deadline: s.now + s.config.operationMs,
				old: s.holder,
				oldEpoch: s.paths[s.holder].epoch,
				lingerUntil: 0,
			};
			emit(s.op, "promote");
			break;
		}
		case "traffic": {
			const op = s.op;
			if (
				op?.phase !== "traffic" ||
				op.id !== e.operation ||
				e.radio !== op.radio ||
				!sameEpoch(e.epoch, op.epoch) ||
				!useful(s, op.radio)
			)
				break;
			op.phase = "demote";
			// The command targets the old identity; the operation retains the candidate.
			emit(op, "demote");
			const effect = effects[effects.length - 1];
			if (effect && op.oldEpoch)
				effects[effects.length - 1] = {
					...effect,
					radio: op.old,
					epoch: op.oldEpoch,
				};
			break;
		}
		case "ack": {
			const op = s.op;
			if (!op || op.id !== e.operation || op.command !== e.command) break;
			if (!e.ok) {
				abort();
				break;
			}
			if (op.phase === "cleanup") s.op = null;
			else if (op.phase === "promote") op.phase = "traffic";
			else if (op.phase === "demote") {
				op.phase = "linger";
				op.lingerUntil = s.now + s.config.lingerMs;
			} else if (op.phase === "release") {
				s.paths[op.old].proof = null;
				s.paths[op.old].label = "unknown";
				s.op = null;
			} else if (op.phase !== "traffic" && op.phase !== "linger") s.op = null;
			break;
		}
		case "cancel":
			if (s.op?.id === e.operation) abort();
			break;
		case "tick": {
			const r = other(s.holder),
				epoch = s.paths[r].epoch;
			if (
				!s.op &&
				s.emergencyAt !== null &&
				s.now >= s.emergencyAt + s.config.emergencyMs &&
				epoch &&
				s.paths[s.holder].epoch &&
				useful(s, r)
			) {
				const id = s.nextId++;
				s.op = {
					id,
					command: 0,
					radio: r,
					epoch,
					phase: "promote",
					deadline: s.now + s.config.operationMs,
					old: s.holder,
					oldEpoch: s.paths[s.holder].epoch,
					lingerUntil: 0,
				};
				emit(s.op, "promote");
			}
			break;
		}
	}
	const op = s.op;
	if (op?.phase === "linger" && s.now >= op.lingerUntil) {
		if (!useful(s, op.radio)) abort();
		else {
			op.phase = "release";
			s.holder = op.radio;
			s.emergencyAt = null;
			emit(op, "disconnect");
			const effect = effects[effects.length - 1];
			if (effect && op.oldEpoch)
				effects[effects.length - 1] = {
					...effect,
					radio: op.old,
					epoch: op.oldEpoch,
				};
		}
	}
	return { state: s, effects };
}
export function replay(
	initial: State,
	trace: readonly TraceEvent[],
): Transition {
	return trace.reduce<Transition>(
		(acc, row) => {
			const next = reduce(acc.state, row);
			return { state: next.state, effects: [...acc.effects, ...next.effects] };
		},
		{ state: initial, effects: [] },
	);
}
