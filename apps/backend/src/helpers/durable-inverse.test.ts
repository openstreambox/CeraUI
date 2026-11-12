import { expect, test } from "bun:test";
import {
	DurableInverse,
	type DurableInverseDeps,
	type DurableInverseRecord,
} from "./durable-inverse.ts";

function fixture() {
	let disk: unknown,
		failWrite = false,
		loseReply = false,
		ack = true,
		current = true;
	const events: string[] = [],
		kernel = new Map<string, "owned" | "foreign">();
	const deps: DurableInverseDeps<{ slot: number }> = {
		read: async () => structuredClone(disk),
		write: async (record) => {
			events.push(`durable-${record?.cursor ?? "delete"}`);
			if (failWrite) throw new Error("fsync failed");
			disk = structuredClone(record);
		},
		parsePlan: (value) => {
			if (
				!value ||
				typeof value !== "object" ||
				!("slot" in value) ||
				value.slot !== 1
			)
				throw new Error("Invalid plan");
			return { slot: 1 };
		},
		steps: () => ["terminal-guard", "source-route", "lookup-rule"],
		current: async () => current,
		inspect: async (_, step) => kernel.get(step) ?? "absent",
		apply: async (_, step) => {
			events.push(`apply-${step}`);
			kernel.set(step, "owned");
			if (loseReply) throw new Error("reply lost");
		},
		remove: async (_, step) => {
			events.push(`remove-${step}`);
			kernel.delete(step);
		},
		withdraw: () => {
			events.push("withdraw");
		},
		fence: async () => {
			events.push("packet-fence");
		},
		consumersReleased: async () => ack,
	};
	return {
		owner: new DurableInverse(deps),
		deps,
		kernel,
		events,
		disk: () => disk as DurableInverseRecord<{ slot: number }> | undefined,
		set: (values: {
			failWrite?: boolean;
			loseReply?: boolean;
			ack?: boolean;
			current?: boolean;
			disk?: unknown;
		}) => {
			if (values.failWrite !== undefined) failWrite = values.failWrite;
			if (values.loseReply !== undefined) loseReply = values.loseReply;
			if (values.ack !== undefined) ack = values.ack;
			if (values.current !== undefined) current = values.current;
			if ("disk" in values) disk = values.disk;
		},
	};
}
const owner = "a".repeat(64);
test("each effect has durable prior authority; withdrawal ack precedes exact reverse cleanup", async () => {
	const f = fixture();
	await f.owner.create(owner, "epoch", { slot: 1 });
	expect(f.events.slice(0, 4)).toEqual([
		"durable-0",
		"durable-1",
		"apply-terminal-guard",
		"durable-2",
	]);
	f.events.length = 0;
	f.set({ ack: false });
	expect(await f.owner.cleanup(owner, "epoch")).toBe(false);
	expect(f.events).toEqual(["withdraw", "durable-3", "packet-fence"]);
	expect(f.kernel.size).toBe(3);
	f.set({ ack: true });
	expect(await f.owner.cleanup(owner, "epoch")).toBe(true);
	expect(f.events.filter((event) => event.startsWith("remove-"))).toEqual([
		"remove-lookup-rule",
		"remove-source-route",
		"remove-terminal-guard",
	]);
	expect(f.disk()).toBeUndefined();
});
test("failed durability writes no effect; lost replies are replayed by a new owner", async () => {
	const f = fixture();
	f.set({ failWrite: true });
	await expect(f.owner.create(owner, "epoch", { slot: 1 })).rejects.toThrow();
	expect(f.kernel.size).toBe(0);
	f.set({ failWrite: false, loseReply: true });
	await expect(f.owner.create(owner, "epoch", { slot: 1 })).rejects.toThrow(
		"reply lost",
	);
	expect(f.disk()?.cursor).toBe(1);
	expect(await new DurableInverse(f.deps).cleanup(owner, "epoch")).toBe(true);
	expect(f.kernel.size).toBe(0);
});
test("foreign tuples, changed identity and stale callbacks never consume another owner's resource", async () => {
	const f = fixture();
	f.kernel.set("source-route", "foreign");
	await expect(f.owner.create(owner, "epoch", { slot: 1 })).rejects.toThrow(
		"occupied",
	);
	expect(f.disk()).toBeUndefined();
	f.kernel.clear();
	await f.owner.create(owner, "epoch", { slot: 1 });
	expect(await f.owner.cleanup(owner, "old-epoch")).toBe(false);
	f.kernel.set("lookup-rule", "foreign");
	expect(await f.owner.cleanup(owner, "epoch")).toBe(false);
	expect(f.kernel.get("lookup-rule")).toBe("foreign");
	expect(f.disk()?.cursor).toBe(3);
	const g = fixture();
	g.set({ current: false });
	await expect(g.owner.create(owner, "epoch", { slot: 1 })).rejects.toThrow(
		"identity",
	);
	expect(g.events).toEqual([]);
});
test("torn, unknown and changed step schemas remain retained", async () => {
	const f = fixture();
	f.set({ disk: { version: 2 } });
	await expect(f.owner.read()).rejects.toThrow();
	f.set({
		disk: {
			version: 1,
			owner,
			epoch: "epoch",
			plan: { slot: 1 },
			steps: ["future-effect"],
			cursor: 1,
			phase: "active",
		},
	});
	await expect(f.owner.cleanup(owner, "epoch")).rejects.toThrow("authority");
	expect(f.events).toEqual([]);
});

test("handoff stages stop before a call's link preparation and require current ownership to advance", async () => {
	const f = fixture();
	await f.owner.create(owner, "epoch", { slot: 1 }, 2);
	expect(f.disk()?.phase).toBe("applying");
	expect(f.disk()?.cursor).toBe(2);
	expect(f.kernel.size).toBe(2);
	f.set({ current: false });
	await expect(
		new DurableInverse(f.deps).advance(owner, "epoch"),
	).rejects.toThrow("identity changed");
	expect(f.kernel.size).toBe(2);
	f.set({ current: true });
	await new DurableInverse(f.deps).advance(owner, "epoch");
	expect(f.disk()?.phase).toBe("active");
	expect(f.kernel.size).toBe(3);
	expect(
		f.events.filter((event) => event === "apply-terminal-guard"),
	).toHaveLength(1);
	expect(await f.owner.cleanup(owner, "epoch")).toBe(true);
});

test("an invalid stage limit creates no persistence or kernel effect", async () => {
	const f = fixture();
	await expect(f.owner.create(owner, "epoch", { slot: 1 }, 4)).rejects.toThrow(
		"stage",
	);
	expect(f.disk()).toBeUndefined();
	expect(f.events).toEqual([]);
});
