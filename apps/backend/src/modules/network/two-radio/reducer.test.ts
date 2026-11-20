import { describe, expect, test } from "bun:test";
import {
	type Action,
	type Challenge,
	type Effect,
	type Epoch,
	type Event,
	initialState,
	type Radio,
	reduce,
	replay,
	type State,
	type TraceEvent,
	useful,
} from "./reducer.ts";

const epoch = (name: string): Epoch => ({
	bssid: `02:00:00:00:00:0${name === "a" ? 1 : 2}`,
	lease: `lease-${name}`,
	routeGeneration: 1,
	activation: `active-${name}`,
});
class FakeClock {
	now = 0;
	state = initialState({ operationMs: 100, lingerMs: 10, emergencyMs: 20 });
	effects: Effect[] = [];
	trace: TraceEvent[] = [];
	constructor() {
		for (const radio of ["a", "b"] as const)
			this.send({ type: "identity", radio, epoch: epoch(radio) });
	}
	send(event: Event) {
		const row: TraceEvent = { version: 1, at: this.now, event };
		const next = reduce(this.state, row);
		this.state = next.state;
		this.effects.push(...next.effects);
		this.trace.push(row);
		return next.effects;
	}
	advance(ms: number) {
		this.now += ms;
		return this.send({ type: "tick" });
	}
	challenge(
		radio: Radio,
		id = `${radio}-${this.trace.length}`,
		round = "r1",
		target = "witness",
		ttl = 500,
	): Challenge {
		const challenge = {
			id,
			radio,
			epoch: epoch(radio),
			target,
			round,
			socket: `socket-${id}`,
			startedAt: this.now,
			expiresAt: this.now + ttl,
		};
		this.send({ type: "challenge", challenge, deviceBound: true });
		return challenge;
	}
	response(c: Challenge, ok = true) {
		return this.send({
			type: "response",
			id: c.id,
			radio: c.radio,
			epoch: c.epoch,
			socket: c.socket,
			nonce: c.id,
			ok,
		});
	}
	prove(radio: Radio, round = "r1", ttl = 500) {
		const c = this.challenge(radio, undefined, round, "witness", ttl);
		this.response(c);
		return c;
	}
	ack(ok = true) {
		const op = this.state.op;
		if (!op) throw new Error("No operation");
		return this.send({
			type: "ack",
			operation: op.id,
			command: op.command,
			ok,
		});
	}
	transfer() {
		this.prove("b");
		this.send({ type: "swap" });
		this.ack();
		this.send({
			type: "traffic",
			operation: this.state.op?.id ?? -1,
			radio: "b",
			epoch: epoch("b"),
		});
		this.ack();
	}
}
const actions: Action[] = [
	"disconnect",
	"reassociate",
	"scan",
	"reapply",
	"forced-renew",
];

describe("bound dated usefulness", () => {
	test("G1 first seen and unsolicited responses never establish usefulness", () => {
		const f = new FakeClock();
		expect(f.state.paths.a.label).toBe("unknown");
		f.send({
			type: "response",
			id: "made-up",
			nonce: "made-up",
			radio: "b",
			epoch: epoch("b"),
			socket: "s",
			ok: true,
		});
		f.send({ type: "swap" });
		expect(f.effects).toEqual([]);
	});
	test("G1 only a completed response on the bound socket and exact epoch is proof", () => {
		for (const mismatch of [
			"socket",
			"nonce",
			"radio",
			"bssid",
			"lease",
			"routeGeneration",
			"activation",
			"unbound",
		] as const) {
			const f = new FakeClock();
			const c = {
				id: "nonce",
				radio: "b" as const,
				epoch: epoch("b"),
				target: "t",
				round: "r",
				socket: "socket",
				startedAt: 0,
				expiresAt: 100,
			};
			f.send({
				type: "challenge",
				challenge: c,
				deviceBound: mismatch !== "unbound",
			});
			const e: Event & { type: "response" } = {
				type: "response",
				id: c.id,
				radio: c.radio,
				epoch: c.epoch,
				nonce: c.id,
				socket: c.socket,
				ok: true,
			};
			if (mismatch === "socket" || mismatch === "nonce") e[mismatch] = "wrong";
			else if (mismatch === "radio") e.radio = "a";
			else if (mismatch !== "unbound")
				e.epoch = {
					...c.epoch,
					[mismatch]: mismatch === "routeGeneration" ? 2 : "changed",
				};
			f.send(e);
			expect(useful(f.state, "b")).toBe(false);
		}
		const f = new FakeClock();
		const c = f.prove("b");
		expect(f.state.paths.b.proof).toEqual({ ...c, completedAt: 0 });
	});
	test("G1 every live epoch component invalidates proof and late receive evidence", () => {
		for (const field of [
			"bssid",
			"lease",
			"routeGeneration",
			"activation",
		] as const) {
			const f = new FakeClock();
			const c = f.prove("b");
			f.send({
				type: "identity",
				radio: "b",
				epoch: {
					...epoch("b"),
					[field]: field === "routeGeneration" ? 2 : "new",
				},
			});
			f.response(c);
			f.send({ type: "swap" });
			expect(f.state.paths.b.label).toBe("unknown");
			expect(f.effects).toEqual([]);
		}
	});
	test("expiry boundary, response replay and reused nonce are rejected", () => {
		const f = new FakeClock();
		const c = f.challenge("b", "once", "r", "t", 10);
		f.advance(10);
		f.response(c);
		expect(useful(f.state, "b")).toBe(false);
		f.challenge("b", "once", "new");
		f.response({ ...c, expiresAt: 500 });
		expect(useful(f.state, "b")).toBe(false);
	});
});

describe("transfer, cancellation and cleanup", () => {
	test("G2 demote, linger, disconnect only after promotion and real traffic", () => {
		const f = new FakeClock();
		f.prove("b");
		f.send({ type: "swap" });
		const id = f.state.op?.id ?? -1;
		f.send({ type: "traffic", operation: id, radio: "b", epoch: epoch("b") });
		expect(f.effects.map((e) => e.action)).toEqual(["promote"]);
		f.ack();
		f.send({ type: "traffic", operation: id, radio: "b", epoch: epoch("b") });
		expect(f.effects.at(-1)?.radio).toBe("a");
		expect(f.effects.at(-1)?.action).toBe("demote");
		f.ack();
		f.advance(9);
		expect(f.state.holder).toBe("a");
		f.advance(1);
		expect(f.effects.at(-1)?.action).toBe("disconnect");
		expect(f.state.holder).toBe("b");
		f.ack();
		expect(f.state.op).toBeNull();
	});
	for (const phase of ["promote", "traffic", "demote", "linger"] as const) {
		for (const stop of ["cancel", "timeout"] as const)
			test(`G2 ${stop} during ${phase} retains old holder until drained`, () => {
				const f = new FakeClock();
				f.prove("b");
				f.send({ type: "swap" });
				if (phase !== "promote") f.ack();
				if (phase === "demote" || phase === "linger")
					f.send({
						type: "traffic",
						operation: f.state.op?.id ?? -1,
						radio: "b",
						epoch: epoch("b"),
					});
				if (phase === "linger") f.ack();
				const pending = structuredClone(f.state.op);
				if (stop === "cancel")
					f.send({ type: "cancel", operation: pending?.id ?? -1 });
				else f.advance(100);
				expect(f.state.holder).toBe("a");
				expect(f.state.op?.phase).toBe("cleanup");
				expect(f.effects.at(-1)?.restore).toEqual({
					radio: "a",
					epoch: epoch("a"),
				});
				f.send({
					type: "ack",
					operation: pending?.id ?? -1,
					command: pending?.command ?? -1,
					ok: true,
				});
				f.send({ type: "depart", radio: "b", action: "scan" });
				expect(f.state.op?.phase).toBe("cleanup");
				f.ack(false);
				f.advance(1000);
				expect(f.state.op?.phase).toBe("cleanup");
				f.ack();
				expect(f.state.op).toBeNull();
				expect(f.effects.some((e) => e.action === "disconnect")).toBe(false);
			});
	}
	test("S144 replacement identity aborts transfer and cleanup names originals only", () => {
		const f = new FakeClock();
		f.transfer();
		f.send({
			type: "identity",
			radio: "b",
			epoch: { ...epoch("b"), activation: "replacement" },
		});
		expect(f.state.op?.phase).toBe("cleanup");
		expect(f.state.holder).toBe("a");
		expect(f.effects.at(-1)?.epoch).toEqual(epoch("b"));
	});
	test("release is the commit point; failure drains without restoring disconnected old holder", () => {
		const f = new FakeClock();
		f.transfer();
		f.advance(10);
		f.ack(false);
		expect(f.state.holder).toBe("b");
		expect(f.effects.at(-1)?.restore?.radio).toBe("b");
		f.ack();
		expect(f.state.op).toBeNull();
	});
	test("expired candidate at linger cannot release holder", () => {
		const f = new FakeClock();
		f.transfer();
		f.advance(500);
		expect(f.state.holder).toBe("a");
		expect(f.effects.at(-1)?.action).toBe("cancel-drain-restore");
	});
});

describe("single departure token", () => {
	for (const first of actions)
		for (const second of actions)
			test(`G3 ${first} excludes ${second} until settlement`, () => {
				const f = new FakeClock();
				f.send({ type: "depart", radio: "a", action: first });
				expect(f.effects).toEqual([]);
				f.send({ type: "depart", radio: "b", action: first });
				f.send({ type: "depart", radio: "b", action: second });
				f.send({ type: "depart", radio: "a", action: second });
				expect(f.effects).toHaveLength(1);
				f.ack();
				f.send({ type: "depart", radio: "b", action: second });
				expect(f.effects).toHaveLength(2);
			});
	test("S144 canceled action retains token despite late ACK and timeout", () => {
		const f = new FakeClock();
		f.send({ type: "depart", radio: "b", action: "reassociate" });
		const old = structuredClone(f.state.op);
		f.send({ type: "cancel", operation: old?.id ?? -1 });
		f.send({
			type: "ack",
			operation: old?.id ?? -1,
			command: old?.command ?? -1,
			ok: true,
		});
		f.advance(500);
		f.send({ type: "depart", radio: "b", action: "forced-renew" });
		expect(f.effects.map((e) => e.action)).toEqual([
			"reassociate",
			"cancel-drain-restore",
		]);
		f.ack();
		f.send({ type: "depart", radio: "b", action: "scan" });
		expect(f.effects.at(-1)?.action).toBe("scan");
	});
});

describe("emergency evidence", () => {
	test("G4 expiry changes label only; no timer or departure", () => {
		const f = new FakeClock();
		f.prove("a", "r", 10);
		f.prove("b");
		f.advance(10);
		f.advance(1000);
		expect(f.state.paths.a.label).toBe("unknown");
		expect(f.state.emergencyAt).toBeNull();
		expect(f.effects).toEqual([]);
	});
	test("G4 common-target failure never swaps, regardless of response ordering", () => {
		for (const order of [
			["a", "b"],
			["b", "a"],
		] as const) {
			const f = new FakeClock();
			f.prove("b", "previous");
			for (const radio of order) {
				f.response(f.challenge(radio, undefined, "failure"), false);
				f.send({ type: "round-complete", target: "witness", round: "failure" });
				f.advance(25);
			}
			f.advance(1000);
			expect(f.state.suspectTargets).toContain("witness");
			expect(f.state.emergencyAt).toBeNull();
			expect(f.effects).toEqual([]);
		}
	});
	test("only a completed split round starts a timer and later promotes", () => {
		const f = new FakeClock();
		f.response(f.challenge("a"), false);
		f.send({ type: "round-complete", target: "witness", round: "r1" });
		expect(f.state.emergencyAt).toBeNull();
		f.prove("b");
		f.send({ type: "round-complete", target: "witness", round: "r1" });
		expect(f.state.emergencyAt).toBe(0);
		f.advance(19);
		expect(f.effects).toEqual([]);
		f.advance(1);
		expect(f.effects.at(-1)?.action).toBe("promote");
	});
	test("failures from distinct rounds or old activations cannot form a split round", () => {
		const f = new FakeClock();
		f.response(f.challenge("a"), false);
		f.prove("b", "different");
		f.send({ type: "round-complete", target: "witness", round: "r1" });
		expect(f.state.emergencyAt).toBeNull();
		f.send({
			type: "identity",
			radio: "a",
			epoch: { ...epoch("a"), activation: "next" },
		});
		f.prove("b");
		f.send({ type: "round-complete", target: "witness", round: "r1" });
		expect(f.state.emergencyAt).toBeNull();
	});
});

function* permutations<T>(items: readonly T[]): Generator<T[]> {
	if (!items.length) {
		yield [];
		return;
	}
	for (let i = 0; i < items.length; i++)
		for (const rest of permutations(items.filter((_, j) => j !== i)))
			yield [items[i] as T, ...rest];
}
test("exhaustive 720 cancellation/late-ACK/identity/expiry/departure interleavings", () => {
	let count = 0;
	for (const order of permutations([
		"cancel",
		"ack",
		"identity",
		"time",
		"depart",
		"traffic",
	] as const)) {
		const f = new FakeClock();
		f.prove("b");
		f.send({ type: "swap" });
		const op = structuredClone(f.state.op);
		if (!op) throw new Error("No op");
		for (const step of order) {
			if (step === "cancel") f.send({ type: "cancel", operation: op.id });
			if (step === "ack")
				f.send({
					type: "ack",
					operation: op.id,
					command: op.command,
					ok: true,
				});
			if (step === "identity")
				f.send({
					type: "identity",
					radio: "b",
					epoch: { ...epoch("b"), activation: "new" },
				});
			if (step === "time") f.advance(100);
			if (step === "depart")
				for (const action of actions)
					f.send({ type: "depart", radio: "b", action });
			if (step === "traffic")
				f.send({
					type: "traffic",
					operation: op.id,
					radio: "b",
					epoch: epoch("b"),
				});
			expect(f.state.holder).toBe("a");
			expect(f.effects.some((e) => actions.includes(e.action as Action))).toBe(
				false,
			);
		}
		expect(f.state.op?.phase).toBe("cleanup");
		count++;
	}
	expect(count).toBe(720);
});

test("exhaustive 1554 bounded action words preserve token and do not mutate inputs", () => {
	let count = 0;
	const visit = (state: State, depth: number) => {
		if (!depth) return;
		const events: Event[] = [
			...actions.map((action) => ({
				type: "depart" as const,
				radio: "b" as const,
				action,
			})),
			{ type: "depart", radio: "a", action: "scan" },
		];
		for (const event of events) {
			const before = structuredClone(state);
			const next = reduce(state, { version: 1, at: state.now, event });
			expect(state).toEqual(before);
			expect(next.state.holder).toBe("a");
			expect(next.effects.length).toBe(
				state.op || (event.type === "depart" && event.radio === "a") ? 0 : 1,
			);
			count++;
			visit(next.state, depth - 1);
		}
	};
	visit(new FakeClock().state, 4);
	expect(count).toBe(1554);
});

test("synthetic versioned JSON trace replays two-way transfer and cleanup deterministically", () => {
	const f = new FakeClock();
	f.transfer();
	f.advance(10);
	f.ack();
	f.prove("a", "return");
	f.send({ type: "swap" });
	f.ack();
	f.send({
		type: "traffic",
		operation: f.state.op?.id ?? -1,
		radio: "a",
		epoch: epoch("a"),
	});
	f.ack();
	f.advance(10);
	f.ack();
	const result = replay(
		initialState(f.state.config),
		JSON.parse(JSON.stringify(f.trace)),
	);
	expect(result.state).toEqual(f.state);
	expect(result.effects).toEqual(f.effects);
	expect(result.effects.map((e) => e.action)).toEqual([
		"promote",
		"demote",
		"disconnect",
		"promote",
		"demote",
		"disconnect",
	]);
	expect(result.state.holder).toBe("a");
	expect(result.state.op).toBeNull();
});
test("invalid timing and out-of-order trace rows fail explicitly", () => {
	expect(() =>
		initialState({ operationMs: 0, lingerMs: 1, emergencyMs: 1 }),
	).toThrow();
	for (const at of [-1, Number.NaN, Number.POSITIVE_INFINITY])
		expect(() =>
			reduce(initialState(), { version: 1, at, event: { type: "tick" } }),
		).toThrow();
});

test("traffic receipt must name the current operation, radio and epoch", () => {
	for (const bad of ["operation", "radio", "epoch"] as const) {
		const f = new FakeClock();
		f.prove("b");
		f.send({ type: "swap" });
		f.ack();
		f.send({
			type: "traffic",
			operation: bad === "operation" ? -1 : (f.state.op?.id ?? -1),
			radio: bad === "radio" ? "a" : "b",
			epoch:
				bad === "epoch" ? { ...epoch("b"), activation: "old" } : epoch("b"),
		});
		expect(f.state.op?.phase).toBe("traffic");
		expect(f.effects.map((e) => e.action)).toEqual(["promote"]);
	}
});
test("old operation ACK cannot settle a newly admitted action after cleanup", () => {
	const f = new FakeClock();
	f.send({ type: "depart", radio: "b", action: "scan" });
	const old = structuredClone(f.state.op);
	f.send({ type: "cancel", operation: old?.id ?? -1 });
	f.ack();
	f.send({ type: "depart", radio: "b", action: "reapply" });
	const current = structuredClone(f.state.op);
	f.send({
		type: "ack",
		operation: old?.id ?? -1,
		command: old?.command ?? -1,
		ok: true,
	});
	expect(f.state.op).toEqual(current);
});
test("parallel same-round challenges settle once, including arbitrary nonce strings", () => {
	const f = new FakeClock();
	const c = f.challenge("a", "__proto__");
	const duplicate = f.challenge("a", "constructor");
	f.response(c, false);
	f.response(duplicate, true);
	expect(f.state.paths.a.label).toBe("disproved");
	f.prove("b");
	f.send({ type: "round-complete", target: "witness", round: "r1" });
	expect(f.state.emergencyAt).toBe(0);
});
