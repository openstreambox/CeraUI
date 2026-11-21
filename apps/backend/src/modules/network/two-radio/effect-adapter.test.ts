import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../../wifi/wifi-adapter-lock.ts";
import {
	EffectAdapter,
	type Holder,
	type Identity,
	type Journal,
	type NetworkOwner,
	type Snapshot,
} from "./effect-adapter.ts";
import { FileJournal } from "./journal.ts";
import { bindNetworkOwner, type OwnerBinding } from "./owner-binding.ts";
import { type Effect, initialState, reduce } from "./reducer.ts";

const identity = (name = "a"): Identity => ({
	physical: `phy-${name}`,
	permanentMac: name === "a" ? "02:00:00:00:00:01" : "02:00:00:00:00:02",
	epoch: { bssid: name, lease: name, activation: name, routeGeneration: 1 },
});
const holder: Holder = { radio: "a", identity: identity() };
const command = (action: Effect["action"] = "scan", n = 2): Effect => ({
	operation: 1,
	command: n,
	radio: "b",
	epoch: identity("b").epoch,
	action,
	restore:
		action === "cancel-drain-restore"
			? { radio: "a", epoch: holder.identity.epoch }
			: null,
});
class MemoryJournal implements Journal {
	data: Snapshot | null = null;
	fail = false;
	async load() {
		return structuredClone(this.data);
	}
	async save(s: Snapshot) {
		if (this.fail) throw new Error("disk");
		this.data = structuredClone(s);
	}
}
class FakeOwner implements NetworkOwner {
	live = { a: identity(), b: identity("b") };
	log: string[] = [];
	resources = new Set(["foreign"]);
	drain = true;
	restoreOk = true;
	applyOk = true;
	gate: Promise<void> | undefined;
	inside = false;
	tail = Promise.resolve();
	async run<T>(work: () => Promise<T>): Promise<T> {
		const preceding = this.tail;
		let done = () => {};
		this.tail = new Promise<void>((resolve) => {
			done = resolve;
		});
		await preceding;
		this.inside = true;
		try {
			return await work();
		} finally {
			this.inside = false;
			done();
		}
	}
	async identity(radio: "a" | "b") {
		return structuredClone(this.live[radio]);
	}
	async apply(_intent: unknown, scope: string) {
		expect(this.inside).toBe(true);
		this.log.push("apply");
		await this.gate;
		this.resources.add(scope);
		this.log.push("applied");
		return this.applyOk;
	}
	async cancelAndDrain() {
		expect(this.inside).toBe(true);
		this.log.push("drain");
		return this.drain;
	}
	async restore() {
		this.log.push("restore");
		return this.restoreOk;
	}
	async removeOwned(scope: string) {
		this.log.push("remove");
		this.resources.delete(scope);
		return true;
	}
}
async function setup(ioMs = 200) {
	const owner = new FakeOwner(),
		journal = new MemoryJournal();
	const adapter = new EffectAdapter(owner, journal, "session", ioMs);
	expect(await adapter.reconcile()).toBe(true);
	return { owner, journal, adapter };
}
describe("effect contract", () => {
	test("echoes operation AND command, deduplicates completions and durable dispatch", async () => {
		const { adapter, owner, journal } = await setup();
		const ack = await adapter.execute(command(), holder);
		expect(ack).toEqual({ type: "ack", operation: 1, command: 2, ok: true });
		expect(journal.data?.operations[0]?.commands).toHaveLength(1);
		expect(await adapter.execute(command(), holder)).toEqual(ack);
		expect(owner.log.filter((x) => x === "apply")).toHaveLength(1);
	});
	test("uses the shared physical adapter lock, never interface-name admission", async () => {
		const { adapter, owner } = await setup();
		await withWifiAdapterLock(
			wifiAdapterLockKey(identity("b").permanentMac),
			async () => {
				expect(await adapter.execute(command(), holder)).toBeNull();
			},
		);
		expect(owner.log).toEqual([]);
	});
	test("fences every epoch field before dispatch", async () => {
		for (const key of [
			"bssid",
			"lease",
			"activation",
			"routeGeneration",
		] as const) {
			const { adapter, owner } = await setup();
			owner.live.b = {
				...owner.live.b,
				epoch: {
					...owner.live.b.epoch,
					[key]: key === "routeGeneration" ? 2 : "replacement",
				},
			};
			expect(await adapter.execute(command(), holder)).toBeNull();
			expect(owner.log).toEqual([]);
		}
	});
	test("identity changes during dispatch never ACK success", async () => {
		const { adapter, owner } = await setup();
		let release = () => {};
		owner.gate = new Promise<void>((r) => {
			release = r;
		});
		const completion = adapter.execute(command(), holder);
		await new Promise((r) => setTimeout(r, 5));
		owner.live.b = identity("replacement");
		release();
		expect(await completion).toBeNull();
	});
	test("journal failure prevents any Linux effect", async () => {
		const { adapter, owner, journal } = await setup();
		journal.fail = true;
		expect(await adapter.execute(command(), holder)).toBeNull();
		expect(owner.log).toEqual([]);
	});
	test("closes admission immediately, drains before restore and removes only own resources", async () => {
		const { adapter, owner } = await setup();
		await adapter.execute(command(), holder);
		const cleanup = adapter.execute(command("cancel-drain-restore", 3), holder);
		expect(await adapter.execute(command("reapply", 4), holder)).toBeNull();
		expect(await cleanup).toEqual({
			type: "ack",
			operation: 1,
			command: 3,
			ok: true,
		});
		expect(owner.log).toEqual([
			"apply",
			"applied",
			"drain",
			"restore",
			"remove",
		]);
		expect([...owner.resources]).toEqual(["foreign"]);
	});
	test("unconfirmed drain never restores or ACKs, and token remains held", async () => {
		const { adapter, owner } = await setup();
		owner.drain = false;
		const state = reduce(
			reduce(initialState(), {
				version: 1,
				at: 0,
				event: { type: "identity", radio: "b", epoch: identity("b").epoch },
			}).state,
			{
				version: 1,
				at: 1,
				event: { type: "depart", radio: "b", action: "scan" },
			},
		).state;
		const timeout = reduce(state, {
			version: 1,
			at: 6000,
			event: { type: "tick" },
		});
		expect(timeout.state.op?.phase).toBe("cleanup");
		expect(
			await adapter.execute(command("cancel-drain-restore", 3), holder),
		).toBeNull();
		expect(owner.log).toEqual(["drain"]);
		expect(timeout.state.op).not.toBeNull();
	});
	test("unknown restoration and replacement holder retain cleanup intent", async () => {
		for (const replacement of [false, true]) {
			const { adapter, owner, journal } = await setup();
			if (replacement) owner.live.a = identity("new-holder");
			else owner.restoreOk = false;
			expect(
				await adapter.execute(command("cancel-drain-restore", 3), holder),
			).toBeNull();
			expect(owner.log).not.toContain("remove");
			expect(journal.data?.operations[0]?.clean).toBe(false);
		}
	});
	test("unknown named restore cannot be substituted by a guessed holder", async () => {
		const { adapter, owner } = await setup();
		expect(
			await adapter.execute(
				{
					...command("cancel-drain-restore"),
					restore: { radio: "a", epoch: null },
				},
				holder,
			),
		).toBeNull();
		expect(owner.log).toEqual([]);
	});
	test("bounded hung apply does not pretend cleanup completed or retry", async () => {
		const { adapter, owner } = await setup(10);
		let release = () => {};
		owner.gate = new Promise<void>((r) => {
			release = r;
		});
		expect(await adapter.execute(command(), holder)).toBeNull();
		expect(await adapter.execute(command(), holder)).toBeNull();
		owner.drain = false;
		expect(
			await adapter.execute(command("cancel-drain-restore", 3), holder),
		).toBeNull();
		release();
		await owner.gate;
		expect(owner.log).not.toContain("restore");
	});
	test("cancellation aborts every active operation command and suppresses late ACK", async () => {
		const { adapter, owner } = await setup();
		let release = () => {};
		owner.gate = new Promise<void>((r) => {
			release = r;
		});
		const work = adapter.execute(command(), holder);
		await new Promise((r) => setTimeout(r, 5));
		const cleanup = adapter.execute(command("cancel-drain-restore", 3), holder);
		release();
		expect(await work).toBeNull();
		expect((await cleanup)?.command).toBe(3);
		expect(owner.log.indexOf("applied")).toBeLessThan(
			owner.log.indexOf("restore"),
		);
	});
	test("restart drains persisted commands without replaying their effects", async () => {
		const { adapter, owner, journal } = await setup();
		await adapter.execute(command("promote"), holder);
		owner.log = [];
		const restart = new EffectAdapter(owner, journal, "next");
		expect(await restart.execute(command(), holder)).toBeNull();
		expect(await restart.reconcile()).toBe(true);
		expect(owner.log).toEqual(["drain", "restore", "remove"]);
		expect(journal.data?.session).toBe("next");
	});
	test("restart after unknown drain or restore stays closed; explicit reconciliation can recover", async () => {
		const { adapter, owner, journal } = await setup();
		await adapter.execute(command(), holder);
		owner.drain = false;
		const restart = new EffectAdapter(owner, journal, "next");
		expect(await restart.reconcile()).toBe(false);
		expect(await restart.execute(command(), holder)).toBeNull();
		owner.drain = true;
		owner.restoreOk = false;
		expect(await restart.reconcile()).toBe(false);
		owner.restoreOk = true;
		expect(await restart.reconcile()).toBe(true);
	});
	test("restart after committed release restores current designated holder", async () => {
		const { adapter, owner, journal } = await setup();
		const next: Holder = { radio: "b", identity: identity("b") };
		await adapter.execute(
			{ ...command("disconnect"), radio: "a", epoch: identity().epoch },
			next,
		);
		expect(journal.data?.operations[0]?.holder).toEqual(next);
		const restart = new EffectAdapter(owner, journal, "next");
		expect(await restart.reconcile()).toBe(true);
	});
	test("file journal persists across instances and fails closed on corruption", async () => {
		const dir = await mkdtemp(join(tmpdir(), "two-radio-"));
		try {
			const path = join(dir, "state.json"),
				file = new FileJournal(path);
			expect(await file.load()).toBeNull();
			const { journal } = await setup();
			await file.save(journal.data as Snapshot);
			expect(await new FileJournal(path).load()).toEqual(journal.data);
			expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
			await writeFile(path, "broken");
			const restart = new EffectAdapter(new FakeOwner(), file, "next");
			expect(await restart.reconcile()).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("existing owner NM binding", () => {
	function binding(): OwnerBinding {
		return {
			run: (work) => work(),
			identity: async (r) => identity(r),
			plan: async () => [
				{
					args: ["device", "wifi", "rescan"],
					radio: "b",
					identity: identity("b"),
				},
			],
			restorePlan: async () => [],
			restored: async () => true,
			drain: async () => true,
			removeOwned: async () => true,
		};
	}
	test("existing bounded runner receives cancellation, timeout and output ceiling", async () => {
		const owner = bindNetworkOwner(
			binding(),
			async (bin, args, opts) => {
				expect(bin).toBe("nmcli");
				expect(args).toEqual(["device", "wifi", "rescan"]);
				expect(opts.timeout).toBe(50);
				expect(opts.maxBuffer).toBe(65536);
				expect(opts.signal).toBeInstanceOf(AbortSignal);
				return "";
			},
			50,
		);
		expect(
			await owner.apply(
				{ effect: command(), identity: identity("b") },
				"scope",
				new AbortController().signal,
			),
		).toBe(true);
	});
	test("identity swapped between NM steps cannot touch replacement", async () => {
		const port = binding();
		let calls = 0,
			swapped = false;
		const step = {
			args: ["device", "reapply", "wlan0"],
			radio: "b" as const,
			identity: identity("b"),
		};
		port.plan = async () => [step, step];
		port.identity = async (r) => identity(swapped ? "replacement" : r);
		const owner = bindNetworkOwner(port, async () => {
			calls++;
			swapped = true;
			return "";
		});
		await expect(
			owner.apply(
				{ effect: command(), identity: identity("b") },
				"scope",
				new AbortController().signal,
			),
		).rejects.toThrow("Stale");
		expect(calls).toBe(1);
	});
	test("server drain is required even after local children exit", async () => {
		const port = binding();
		port.drain = async () => false;
		const owner = bindNetworkOwner(port, async () => "");
		expect(
			await owner.cancelAndDrain(
				{ operation: 1 } as never,
				new AbortController().signal,
			),
		).toBe(false);
	});
});

test("deadline keeps physical lock until an abort-ignoring command actually settles", async () => {
	const { adapter, owner } = await setup(5);
	let release = () => {};
	owner.gate = new Promise<void>((r) => {
		release = r;
	});
	expect(await adapter.execute(command(), holder)).toBeNull();
	const locked = await withWifiAdapterLock(
		wifiAdapterLockKey(identity("b").permanentMac),
		async () => true,
	);
	expect(locked.success).toBe(false);
	release();
	await owner.tail;
	expect(
		(
			await withWifiAdapterLock(
				wifiAdapterLockKey(identity("b").permanentMac),
				async () => true,
			)
		).success,
	).toBe(true);
});
test("failed Linux completion cannot be acknowledged as success", async () => {
	const { adapter, owner } = await setup();
	owner.applyOk = false;
	expect(await adapter.execute(command(), holder)).toBeNull();
});
test("crash after durable intent but before command completion is reconciled", async () => {
	const { adapter, owner, journal } = await setup();
	owner.apply = async () => {
		throw new Error("lost process");
	};
	expect(await adapter.execute(command(), holder)).toBeNull();
	expect(journal.data?.operations[0]?.commands).toHaveLength(1);
	const restart = new EffectAdapter(owner, journal, "next");
	expect(await restart.reconcile()).toBe(true);
	expect(owner.log).toEqual(["drain", "restore", "remove"]);
});
