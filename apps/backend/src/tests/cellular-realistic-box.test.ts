/*
    The link-set invariants, held on a described box (three USB modems on
    default automatic profiles, one Ethernet port):

    L1  A healthy automatic USB modem is captured and offered to the bond,
        whatever anchors its identity (USB serial or port).
    L2  A journal block excludes its own modem and nothing else that has an
        identity: the other modems and non-USB Ethernet stay in the bond.
    L3  While a journal block exists, an interface without a cached identity is
        admitted only on fresh positive proof that it is not on the USB bus.
        Without a block it needs no proof.
    L4  A quarantined slot removes its own interface only. If its durable
        authority is replaced, the healthy paths stay in the bond and new
        streams are refused; only the global barrier withdraws every managed
        path, and they return when it lowers.
*/

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../helpers/private-json-state.ts";
import {
	CellularHostRecovery,
	cellularRecoveryReservedSlots,
	isolateCellularHostAuthority,
} from "../modules/modems/cellular-host-recovery.ts";
import {
	captureCellularObservation,
	runCellularRuntime,
} from "../modules/modems/cellular-runtime-host.ts";
import {
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "../modules/network/cellular-native-host-plan.ts";
import { examinedNonUsbNetDevice } from "../modules/network/non-usb-net-evidence.ts";
import { resolveBondPhysicalIdentity } from "../modules/streaming/bond-entry.ts";
import { setMutationBlocks } from "../modules/streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import {
	BOX_ETHERNET,
	BOX_MODEMS,
	boxModemKey,
	installRealisticBox,
	type RealisticBox,
} from "./fixtures/realistic-box.ts";

let box: RealisticBox;
beforeEach(async () => {
	box = await installRealisticBox();
});
afterEach(() => box.close());

/** The modem poll reconciles once per cycle; a path is ready within a few. */
async function settle(): Promise<void> {
	for (let cycle = 0; cycle < 4; cycle++) await runCellularRuntime();
}

test("the box describes USB modems and a non-USB Ethernet port", () => {
	for (const modem of BOX_MODEMS)
		expect(examinedNonUsbNetDevice(modem.ifname)).toBe(false);
	expect(examinedNonUsbNetDevice(BOX_ETHERNET.ifname)).toBe(true);
	expect(
		BOX_MODEMS.map(
			(modem) => resolveBondPhysicalIdentity(modem.ifname)?.anchor,
		),
	).toEqual(["usb-serial", "id-path", "id-path"]);
});

test("L1: capture accepts a USB modem under either identity anchor", async () => {
	for (const modem of BOX_MODEMS) {
		const observation = await captureCellularObservation(modem.id);
		expect(observation?.iface).toBe(modem.ifname);
		expect(observation?.grant?.source).toBe(modem.ip);
		expect(observation?.currentNow()).toBe(true);
		await observation?.close();
	}
});

test("L1: three default-profile USB modems and Ethernet reach the bond", async () => {
	// Before the first poll an automatic modem has no managed source yet.
	expect(box.bond()).toEqual([BOX_ETHERNET.ifname]);
	await settle();
	expect(box.sessions).toHaveLength(3);
	expect(box.bond()).toEqual(box.expectedBond());
});

test("L2: a journal block removes its own modem and leaves every other link", async () => {
	await settle();
	const blocked = BOX_MODEMS[1];
	if (!blocked) throw new Error("fixture");
	setMutationBlocks([
		{
			stableKey: boxModemKey(blocked),
			refusal: "mutation_blocked",
			blocksStreaming: false,
		},
	]);
	await settle();
	expect(box.bond()).toEqual(
		box.expectedBond().filter((iface) => iface !== blocked.ifname),
	);
	setMutationBlocks([]);
	// A returning path settles for 15 s and is reinstalled no sooner than a
	// minute after its last install; both are existing hold-downs.
	box.advance(61_000);
	await settle();
	box.advance(16_000);
	await settle();
	expect(box.bond()).toEqual(box.expectedBond());
});

test("L3: under a block, an unidentified interface needs fresh non-USB proof", async () => {
	await settle();
	const blocked = BOX_MODEMS[1];
	if (!blocked) throw new Error("fixture");
	// The blocked modem re-enumerates as wwan9 before the identity cache knows it.
	box.setSysfs("wwan9", blocked.sysfs.replace("1-1.2", "1-1.4"));
	const { cellularSourceReady } = await import(
		"../modules/network/cellular-source-state.ts"
	);
	expect(cellularSourceReady("wwan9", "10.70.0.2")).toBe(true);
	setMutationBlocks([
		{
			stableKey: boxModemKey(blocked),
			refusal: "mutation_blocked",
			blocksStreaming: false,
		},
	]);
	expect(cellularSourceReady("wwan9", "10.70.0.2")).toBe(false);
	// An interface whose device link cannot be read is unknown, not ordinary.
	expect(cellularSourceReady("ghost0", "10.71.0.2")).toBe(false);
	expect(cellularSourceReady(BOX_ETHERNET.ifname, BOX_ETHERNET.ip)).toBe(true);
});

/** A leftover host record from an earlier boot, for a modem no longer present. */
async function quarantinedLeftover() {
	const dir = await mkdtemp(join(tmpdir(), "realistic-box-recovery-")),
		store = { dir },
		slot = 9,
		key = cellularUplinkSlotKey(slot),
		bootId = "11111111-1111-4111-8111-111111111111",
		plan = parseCellularNativeHostPlan({
			input: {
				owner: "f".repeat(64),
				epoch: "earlier-boot",
				slot,
				iface: "wwan9",
				mtu: 1428,
				ipv4: "10.99.0.2",
			},
			bootId,
			ifindex: 99,
			dns: [],
		}),
		steps = cellularNativeHostSteps(plan);
	await writePrivateJson(store, key, {
		version: 1,
		owner: plan.input.owner,
		epoch: plan.input.epoch,
		plan,
		steps,
		cursor: steps.length,
		phase: "active",
	});
	let now = 0,
		clean = false;
	const recovery = new CellularHostRecovery({
		store,
		now: () => now,
		bootId: async () => bootId,
		isolate: isolateCellularHostAuthority,
		retain: async () => ({
			cleanup: async () => {
				if (!clean) return false;
				await writePrivateJson(store, key, undefined);
				return true;
			},
		}),
	});
	await recovery.replay();
	return {
		recovery,
		store,
		key,
		plan,
		slot,
		advance: (ms: number) => {
			now += ms;
		},
		close: async () => {
			clean = true;
			await recovery.replay().catch(() => {});
			await rm(dir, { recursive: true, force: true });
		},
	};
}
function streams() {
	return createStreamSessionOrchestrator({
		createAttemptId: () => "box",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		...(streamSessionProductionDeps.blockingMutation
			? { blockingMutation: streamSessionProductionDeps.blockingMutation }
			: {}),
	});
}

test("L4: a quarantined leftover slot costs the box nothing but that slot", async () => {
	const leftover = await quarantinedLeftover();
	try {
		expect(cellularRecoveryReservedSlots()).toContain(leftover.slot);
		await settle();
		expect(box.bond()).toEqual(box.expectedBond());
		const result = await streams().start({
			origin: "ui",
			launch: async () => {},
		});
		expect(result.result).toBe("started");
	} finally {
		await leftover.close();
	}
});

test("L4: a replaced quarantine authority refuses new streams and withdraws no healthy path", async () => {
	const leftover = await quarantinedLeftover();
	try {
		await settle();
		expect(box.bond()).toEqual(box.expectedBond());
		const raw = (await readPrivateJson(leftover.store, leftover.key)) as Record<
			string,
			unknown
		>;
		const other = parseCellularNativeHostPlan({
			...leftover.plan,
			input: { ...leftover.plan.input, epoch: "someone-else" },
		});
		await writePrivateJson(leftover.store, leftover.key, {
			...raw,
			epoch: "someone-else",
			plan: other,
			steps: cellularNativeHostSteps(other),
		});
		leftover.advance(1000);
		await leftover.recovery.retry();
		await settle();
		expect(isRecoveryPending()).toBe(false);
		expect(box.bond()).toEqual(box.expectedBond());
		const refused = await streams().start({
			origin: "ui",
			launch: async () => {
				throw new Error("launched past a replaced authority");
			},
		});
		expect(refused.result).toBe("failed");
		if (refused.result === "failed")
			expect(refused.failure.class).toBe("mutation_blocked");
		await writePrivateJson(leftover.store, leftover.key, raw);
		leftover.advance(60_000);
		await leftover.recovery.retry();
		const admitted = await streams().start({
			origin: "ui",
			launch: async () => {},
		});
		expect(admitted.result).toBe("started");
	} finally {
		await leftover.close();
	}
});

test("L4: the global barrier withdraws every managed path and they return when it lowers", async () => {
	await settle();
	expect(box.bond()).toEqual(box.expectedBond());
	beginRecoveryBarrier();
	await settle();
	expect(box.bond()).toEqual([BOX_ETHERNET.ifname]);
	resetRecoveryBarrier();
	box.advance(61_000);
	await settle();
	box.advance(16_000);
	await settle();
	expect(box.bond()).toEqual(box.expectedBond());
});
