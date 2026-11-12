import { expect, test } from "bun:test";
import {
	readPrivateJson,
	writePrivateJson,
} from "../helpers/private-json-state.ts";
import {
	carrierIntentKey,
	newCarrierIntent,
	readCarrierIntent,
} from "../modules/modems/automatic-carrier-intent.ts";
import { readMutationEntry } from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { setMutationCaptureDeps } from "../modules/modems/mutation-rollback.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import { JournalRetryClock } from "./helpers/journal-reconciliation-harness.ts";
import {
	replayHardware,
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

useReplayHarness();
test("damaged preparation authority keeps the existing boot barrier up, then its sole retry owner clears after repair", async () => {
	const dir = process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
	if (!dir) throw new Error("Private fixture state required");
	const store = { dir },
		key = "a".repeat(64),
		clock = new JournalRetryClock();
	await writePrivateJson(store, key, {
		version: 1,
		kind: "eps",
		key,
		attempted: false,
	});
	const result = await initMutationRecovery({ sleep: clock.sleep });
	expect(result.unreadable).toBe(1);
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000]);
	const done = awaitRecoveryBarrier();
	clock.advance();
	await clock.at(2);
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000, 2000]);
	const repaired = {
		version: 1,
		kind: "eps",
		key,
		original: { apn: "original.invalid", family: "ipv4" },
		desired: { apn: "automatic.invalid", family: "ipv4v6" },
		attempted: true,
		phase: "blocked",
		epoch: "previous-usb",
		started: 1,
	};
	await writePrivateJson(store, key, repaired);
	clock.advance();
	await Promise.race([done, clock.at(3)]);
	expect(isRecoveryPending()).toBe(false);
	expect(await readPrivateJson(store, key)).toEqual(repaired);
});
test("a runtime default-store read fault uses the same owner for read-only verification", async () => {
	const dir = process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR;
	if (!dir) throw new Error("Private fixture state required");
	const store = { dir },
		identity = {
			uuid: "synthetic-profile",
			deviceId: "synthetic-device",
			simId: "synthetic-sim",
		},
		key = carrierIntentKey(identity),
		clock = new JournalRetryClock();
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		0,
	);
	expect(isRecoveryPending()).toBe(false);
	await writePrivateJson(store, key, { version: 1, key });
	await expect(readCarrierIntent(identity)).rejects.toThrow();
	expect(isRecoveryPending()).toBe(true);
	await clock.at(1);
	const done = awaitRecoveryBarrier();
	clock.advance();
	await clock.at(2);
	expect(isRecoveryPending()).toBe(true);
	const repaired = newCarrierIntent(identity, "manual");
	await writePrivateJson(store, key, repaired);
	clock.advance();
	await Promise.race([done, clock.at(3)]);
	expect(isRecoveryPending()).toBe(false);
	expect(await readCarrierIntent(identity)).toEqual(repaired);
});

test("unknown host authority defers modem hardware rollback under the sole boot retry owner", async () => {
	const dir = process.env.CERALIVE_CELLULAR_HOST_STATE_DIR;
	if (!dir) throw new Error("Private host fixture required");
	const store = { dir },
		key = "f".repeat(64),
		clock = new JournalRetryClock();
	await seedInterruptedMutation();
	let captures = 0;
	setMutationCaptureDeps({
		enumerate: async () => {
			captures++;
			return [replayHardware("usb:b")];
		},
	});
	await writePrivateJson(store, key, { version: 1, unrecognized: true });
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		1,
	);
	expect(isRecoveryPending()).toBe(true);
	expect(captures).toBe(0);
	expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
	const done = awaitRecoveryBarrier();
	await writePrivateJson(store, key, undefined);
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	expect(isRecoveryPending()).toBe(false);
	expect(captures).toBeGreaterThan(0);
	expect(await readMutationEntry("usb:b")).toBeUndefined();
});
