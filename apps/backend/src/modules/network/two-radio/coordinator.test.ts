import { expect, test } from "bun:test";
import {
	startTwoRadioCoordinator,
	TwoRadioCoordinator,
} from "./coordinator.ts";
import type { Identity, Journal, Snapshot } from "./effect-adapter.ts";
import type { IngressAuthority } from "./ingress.ts";
import { bindNetworkOwner, type OwnerBinding } from "./owner-binding.ts";
import type { Event, Radio } from "./reducer.ts";

const identity = (r: Radio): Identity => ({
	physical: `radio-${r}`,
	permanentMac: r === "a" ? "02:00:00:00:00:01" : "02:00:00:00:00:02",
	epoch: {
		bssid: `ap-${r}`,
		lease: r,
		activation: `activation-${r}`,
		routeGeneration: 1,
	},
});
function harness() {
	let time = 0;
	let snapshot: Snapshot | null = null;
	let holder: Radio = "a";
	let drain = true;
	const calls: string[] = [];
	const resources = new Set(["foreign"]);
	const journal: Journal = {
		load: async () => structuredClone(snapshot),
		save: async (s) => {
			snapshot = structuredClone(s);
		},
	};
	const binding: OwnerBinding = {
		run: async (work) => work(),
		identity: async (r) => identity(r),
		plan: async (intent, scope) => {
			resources.add(scope);
			return [
				{
					radio: intent.effect.radio,
					identity: intent.identity,
					args: [intent.effect.action, intent.effect.radio],
				},
			];
		},
		restorePlan: async (h) => [
			{ radio: h.radio, identity: h.identity, args: ["restore", h.radio] },
		],
		restored: async (h) => h.radio === holder,
		drain: async () => {
			calls.push("drain");
			return drain;
		},
		removeOwned: async (scope) => {
			calls.push("remove");
			resources.delete(scope);
			return true;
		},
	};
	const owner = bindNetworkOwner(binding, async (_bin, args) => {
		calls.push(args.join(" "));
		if (args[0] === "promote" || args[0] === "restore")
			holder = args[1] as Radio;
		return "";
	});
	const authority: IngressAuthority = {
		resolve: (physical) => {
			const r =
				physical === "radio-a" ? "a" : physical === "radio-b" ? "b" : null;
			return r ? { radio: r, identity: identity(r) } : null;
		},
		absent: () => false,
		bound: () => true,
		traffic: () => true,
	};
	const make = (session: string) =>
		new TwoRadioCoordinator(owner, journal, authority, session, () => time);
	const send = (c: TwoRadioCoordinator, event: Event, at = time + 1) => {
		time = at;
		const r =
			event.type === "challenge"
				? event.challenge.radio
				: "radio" in event
					? event.radio
					: null;
		const external =
			event.type === "challenge"
				? { type: event.type, challenge: event.challenge }
				: event;
		return c.submit(
			JSON.stringify({
				version: 1,
				at,
				...(r ? { physical: identity(r).physical } : {}),
				event: external,
			}),
		);
	};
	const seed = async (c: TwoRadioCoordinator) => {
		for (const r of ["a", "b"] as const)
			await send(c, { type: "identity", radio: r, epoch: identity(r).epoch });
	};
	const proof = async (
		c: TwoRadioCoordinator,
		r: Radio,
		round: string,
		ok = true,
	) => {
		const id = `${round}-${r}`;
		await send(c, {
			type: "challenge",
			deviceBound: true,
			challenge: {
				id,
				radio: r,
				epoch: identity(r).epoch,
				target: "target",
				round,
				socket: id,
				startedAt: time + 1,
				expiresAt: time + 30_000,
			},
		});
		await send(c, {
			type: "response",
			id,
			radio: r,
			epoch: identity(r).epoch,
			socket: id,
			nonce: id,
			ok,
		});
	};
	return {
		make,
		send,
		seed,
		proof,
		calls,
		resources,
		setDrain: (v: boolean) => {
			drain = v;
		},
		get holder() {
			return holder;
		},
	};
}

test("absent and false flags never construct an owner", async () => {
	for (const flag of [undefined, false]) {
		expect(
			await startTwoRadioCoordinator(flag, () => {
				throw new Error("constructed");
			}),
		).toBeNull();
	}
});
test("composed ingress waits for real traffic, demotion and linger; one token", async () => {
	const h = harness(),
		c = h.make("first");
	expect(await c.start()).toBe(true);
	await h.seed(c);
	await h.send(c, { type: "swap" });
	expect(h.calls).toEqual([]);
	await h.proof(c, "b", "round");
	await h.send(c, { type: "swap" });
	expect(c.view().op?.phase).toBe("traffic");
	await h.send(c, { type: "depart", radio: "a", action: "scan" });
	expect(h.calls).toEqual(["promote b"]);
	await h.send(c, {
		type: "traffic",
		operation: c.view().op?.id ?? -1,
		radio: "b",
		epoch: identity("b").epoch,
	});
	expect(c.view().op?.phase).toBe("linger");
	const until = c.view().op?.lingerUntil ?? -1;
	await h.send(c, { type: "tick" }, until - 1);
	expect(h.calls).toEqual(["promote b", "demote a"]);
	await h.send(c, { type: "tick" }, until);
	expect(c.view().holder).toBe("b");
	expect(c.view().op).toBeNull();
	expect(h.calls).toEqual(["promote b", "demote a", "disconnect a"]);
});
test("same-target common failure suppresses a swap", async () => {
	const h = harness(),
		c = h.make("common");
	await c.start();
	await h.seed(c);
	await h.proof(c, "a", "common", false);
	await h.proof(c, "b", "common", false);
	await h.send(c, {
		type: "round-complete",
		target: "target",
		round: "common",
	});
	await h.send(c, { type: "swap" });
	expect(c.view().suspectTargets).toEqual(["target"]);
	expect(h.calls).toEqual([]);
});
test("restart drains, restores original holder and removes only owned scope", async () => {
	const h = harness(),
		c = h.make("old");
	await c.start();
	await h.seed(c);
	await h.proof(c, "b", "round");
	await h.send(c, { type: "swap" });
	expect(h.holder).toBe("b");
	h.setDrain(false);
	expect(await h.make("blocked").start()).toBe(false);
	expect(h.calls).toEqual(["promote b", "drain"]);
	h.setDrain(true);
	expect(await h.make("new").start()).toBe(true);
	expect(h.holder).toBe("a");
	expect(h.calls.slice(-3)).toEqual(["drain", "restore a", "remove"]);
	expect([...h.resources]).toEqual(["foreign"]);
});
test("external acknowledgement cannot enter the reducer", async () => {
	const h = harness(),
		c = h.make("reject");
	await c.start();
	await expect(
		h.send(c, { type: "ack", operation: 1, command: 2, ok: true }),
	).rejects.toThrow();
	expect(h.calls).toEqual([]);
});

test("a successful session cannot reconcile and reuse old policy state", async () => {
	const h = harness(),
		c = h.make("single");
	await c.start();
	await expect(c.start()).rejects.toThrow("fresh coordinator session");
});

test("optional recorded sequence replay retains unknown evidence", async () => {
	const path = process.env.TWO_RADIO_REPLAY_FILE;
	if (!path) return;
	const recordings: unknown = await Bun.file(path).json();
	if (!Array.isArray(recordings)) throw new Error("Expected recordings");
	for (const recording of recordings) {
		if (
			!recording ||
			!Array.isArray(recording.rows) ||
			!Array.isArray(recording.unknown)
		)
			throw new Error("Invalid recording");
		expect(recording.unknown.length).toBeGreaterThan(0);
		const h = harness(),
			c = h.make("recorded");
		await c.start();
		for (const row of recording.rows) await c.submit(JSON.stringify(row));
		// Sequence-only requests cannot invent proof, traffic or command completion.
		expect(c.view().holder).toBe("a");
		expect(c.view().op).toBeNull();
		expect(h.calls).toEqual([]);
	}
});

test("a committed holder survives restart and an otherwise empty new session", async () => {
	const h = harness(),
		c = h.make("initial");
	await c.start();
	await h.seed(c);
	await h.proof(c, "b", "round");
	await h.send(c, { type: "swap" });
	await h.send(c, {
		type: "traffic",
		operation: c.view().op?.id ?? -1,
		radio: "b",
		epoch: identity("b").epoch,
	});
	await h.send(c, { type: "tick" }, c.view().op?.lingerUntil ?? -1);
	expect(c.view().holder).toBe("b");
	const restarted = h.make("second");
	expect(await restarted.start()).toBe(true);
	expect(restarted.view().holder).toBe("b");
	const again = h.make("third");
	expect(await again.start()).toBe(true);
	expect(again.view().holder).toBe("b");
});
