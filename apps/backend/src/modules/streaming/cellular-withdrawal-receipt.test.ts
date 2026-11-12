import { afterEach, expect, test } from "bun:test";
import {
	claimCellularSource,
	resetCellularSourcesForTest,
	setCellularSourceBinding,
} from "../network/cellular-source-state.ts";

afterEach(resetCellularSourcesForTest);

import {
	type CellularWithdrawalDeps,
	createCellularWithdrawalReceipt,
} from "./cellular-withdrawal-receipt.ts";
import type { StreamingProcess } from "./streamloop/process-runner.ts";

function fixture() {
	claimCellularSource("a".repeat(64), "usb-one", "wwan0");
	const exit = Promise.withResolvers<number>(),
		publication =
			Promise.withResolvers<
				Awaited<ReturnType<CellularWithdrawalDeps["restrict"]>>
			>(),
		drain = Promise.withResolvers<void>(),
		enteredDrain = Promise.withResolvers<void>(),
		events: string[] = [];
	const sender = {
		spawnfile: "/synthetic/sender",
		proc: { exited: exit.promise, exitCode: null, signalCode: null },
		exitListeners: [],
		senderBinding: { epoch: Symbol(), startedAt: 500, required: true },
	} as unknown as StreamingProcess;
	let owned = true,
		now = 1000,
		frame = 0,
		absent = false,
		senders = [sender];
	let latest = {
		ok: true as const,
		generation: 1,
		ipsFileSha256: "a".repeat(64),
		changed: true,
		sidecarPath: "/synthetic/map",
	};
	const scope = {
		owner: "a".repeat(64),
		epoch: "usb-one",
		iface: "wwan0",
		linkId: "link-one",
		devices: ["wwan0", "cclat1"],
		owned: () => owned,
	};
	const deps: CellularWithdrawalDeps = {
		senders: () => senders,
		restrict: async () => {
			events.push("restrict");
			return publication.promise;
		},
		drain: async () => {
			events.push("drain");
			enteredDrain.resolve();
			await drain.promise;
		},
		excludes: () => true,
		latest: () => latest,
		reload: (producer) => {
			expect(producer).toBe(sender);
			events.push("reload");
			now = 2500;
		},
		now: () => now,
		acknowledged: (producer, after) => {
			expect(producer).toBe(sender);
			expect(after).toBe(2500);
			return frame > after;
		},
		absent: async () => absent,
	};
	return {
		deps,
		scope,
		sender,
		events,
		exit,
		drain,
		enteredDrain,
		publish: () =>
			publication.resolve({
				ok: true,
				generation: 1,
				ipsFileSha256: "a".repeat(64),
				changed: true,
				sidecarPath: "/synthetic/map",
			}),
		set: (value: {
			owned?: boolean;
			frame?: number;
			absent?: boolean;
			senders?: StreamingProcess[];
			generation?: number;
		}) => {
			if (value.owned !== undefined) owned = value.owned;
			if (value.frame !== undefined) frame = value.frame;
			if (value.absent !== undefined) absent = value.absent;
			if (value.senders) senders = value.senders;
			if (value.generation !== undefined)
				latest = { ...latest, generation: value.generation };
		},
	};
}
test("withdrawal evidence starts after committed publication, queued-write drainage and targeted reload", async () => {
	const f = fixture(),
		pending = createCellularWithdrawalReceipt(f.scope, f.deps);
	expect(f.events).toEqual(["restrict"]);
	f.set({ frame: 2200 });
	f.publish();
	await f.enteredDrain.promise;
	expect(f.events).toEqual(["restrict", "drain"]);
	f.drain.resolve();
	const receipt = await pending;
	expect(f.events).toEqual(["restrict", "drain", "reload"]);
	expect(receipt?.confirmed()).toBe(false);
	f.set({ frame: 2600 });
	expect(receipt?.confirmed()).toBe(true);
	f.set({ senders: [{ ...f.sender }] });
	expect(receipt?.confirmed()).toBe(false);
	f.exit.resolve(0);
	await Promise.resolve();
	expect(receipt?.confirmed()).toBe(false);
	f.set({ senders: [] });
	expect(receipt?.confirmed()).toBe(true);
	f.set({ owned: false });
	expect(receipt?.confirmed()).toBe(false);
});
test("revoked ownership cannot obtain a reload receipt after asynchronous publication", async () => {
	const f = fixture(),
		pending = createCellularWithdrawalReceipt(f.scope, f.deps);
	f.set({ owned: false });
	f.publish();
	expect(await pending).toBeUndefined();
	expect(f.events).toEqual(["restrict"]);
});
test("a later local publication revokes a receipt even while it still excludes the withdrawn path", async () => {
	const f = fixture();
	f.publish();
	f.drain.resolve();
	const receipt = await createCellularWithdrawalReceipt(f.scope, f.deps);
	f.set({ frame: 2600 });
	expect(receipt?.current()).toBe(true);
	expect(receipt?.confirmed()).toBe(true);
	f.set({ generation: 2 });
	expect(receipt?.current()).toBe(false);
	expect(receipt?.confirmed()).toBe(false);
});
test("a newer publication during queue drainage requires a new targeted reload", async () => {
	const f = fixture(),
		pending = createCellularWithdrawalReceipt(f.scope, f.deps);
	f.publish();
	await f.enteredDrain.promise;
	f.set({ generation: 2 });
	f.drain.resolve();
	expect(await pending).toBeUndefined();
	expect(f.events).toEqual(["restrict", "drain"]);
});
test("no owned sender is not a positive startup consumer census", async () => {
	const f = fixture();
	f.set({ senders: [] });
	f.publish();
	f.drain.resolve();
	expect(
		await createCellularWithdrawalReceipt(f.scope, f.deps),
	).toBeUndefined();
	f.set({ absent: true });
	const receipt = await createCellularWithdrawalReceipt(f.scope, f.deps);
	expect(receipt?.confirmed()).toBe(true);
	f.set({ senders: [f.sender] });
	expect(receipt?.confirmed()).toBe(false);
});

test("a successor source observation revokes pending withdrawal without a reload", async () => {
	const f = fixture(),
		pending = createCellularWithdrawalReceipt(f.scope, f.deps);
	setCellularSourceBinding(f.scope.owner, f.scope.epoch, f.scope.iface, {
		source: "192.0.2.2",
		device: "wwan0",
		translated: false,
		generation: "successor",
	});
	f.publish();
	expect(await pending).toBeUndefined();
	expect(f.events).toEqual(["restrict"]);
});
