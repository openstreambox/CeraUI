import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modemClearUnreadableRecordInputSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	defaultMutationJournalFs,
	mutationSlotName,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { tryAcquireModemJournalKey } from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	getPersistentNotifications,
	notificationDismiss,
} from "../modules/ui/notifications.ts";
import { clearUnreadableRecordProcedure } from "../rpc/procedures/modems.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import {
	JournalRetryClock,
	seedFailedMutation,
} from "./helpers/journal-reconciliation-harness.ts";
import {
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

const journal = useReplayHarness();
const name = "modem_recovery_record";
const path = (key: string) =>
	join(journal.root(), mutationSlotName(key) + ".json");
const confirm = (token: string) =>
	call(
		clearUnreadableRecordProcedure,
		{ token, confirm: true },
		{ context: makeRpcContext() },
	);
const warning = () =>
	getPersistentNotifications(true).show.find((n) => n.name === name);

async function offered(): Promise<string> {
	for (let i = 0; i < 500; i++) {
		const action = warning()?.action;
		if (action?.kind === "confirm-modem-record") return action.token;
		await Bun.sleep(2);
	}
	throw new Error("expected a persistent recovery warning");
}

async function exhaust(clock: JournalRetryClock, first = 1) {
	for (let n = first; n < first + 3; n++) {
		await clock.at(n);
		expect(warning()).toBeUndefined();
		clock.advance();
	}
	return offered();
}

test("boot retries one damaged record three times, restores its peer, then requires a confirmed clear before Start", async () => {
	writeFileSync(path("usb:a"), "{broken");
	await seedInterruptedMutation();
	const clock = new JournalRetryClock();
	expect((await initMutationRecovery({ sleep: clock.sleep })).rolledBack).toBe(
		1,
	);
	const token = await exhaust(clock);
	expect(clock.waits).toEqual([1000, 2000, 4000]);
	expect(warning()).toMatchObject({
		is_persistent: true,
		is_dismissable: false,
	});
	expect(
		getPersistentNotifications(false).show.some((n) => n.name === name),
	).toBe(false);
	notificationDismiss(name);
	expect(warning()?.name).toBe(name);
	const session = createStreamSessionOrchestrator({
		initialLiveness: () => "idle",
		createAttemptId: () => "journal-test",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		recoveryPending: isRecoveryPending,
	});
	const start = () => session.start({ origin: "ui", launch: async () => {} });
	expect(await start()).toMatchObject({
		result: "failed",
		failure: { code: "recovery_pending" },
	});
	expect(await confirm(crypto.randomUUID())).toEqual({
		success: false,
		error: "no_entry",
	});
	expect(
		modemClearUnreadableRecordInputSchema.safeParse({ token, confirm: false })
			.success,
	).toBe(false);
	expect(
		modemClearUnreadableRecordInputSchema.safeParse({ token }).success,
	).toBe(false);
	const key = tryAcquireModemJournalKey("usb:a");
	try {
		expect(await confirm(token)).toMatchObject({ success: false });
	} finally {
		key?.release();
	}
	expect(readFileSync(path("usb:a"), "utf8")).toBe("{broken");
	expect(await confirm(token)).toEqual({ success: true });
	await awaitRecoveryBarrier();
	expect(await confirm(token)).toEqual({ success: false, error: "no_entry" });
	expect(warning()).toBeUndefined();
	expect(readdirSync(journal.root())).toEqual([
		".recovery-" + token + ".archived",
	]);
	expect(
		readFileSync(
			join(journal.root(), ".recovery-" + token + ".archived"),
			"utf8",
		),
	).toBe("{broken");
	expect((await start()).result).toBe("started");
	await session.stop("operator");
});

test("confirmation cannot clear a repaired slot or a replacement at the same filename", async () => {
	mkdirSync(path("usb:b"));
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const token = await exhaust(clock);
	const { renameSync } = await import("node:fs");
	renameSync(path("usb:b"), join(journal.root(), "old"));
	writeFileSync(path("usb:b"), "{different");
	expect(await confirm(token)).toMatchObject({ success: false });
	expect(readFileSync(path("usb:b"), "utf8")).toBe("{different");
	const next = await exhaust(clock, 4);
	expect(next).not.toBe(token);
	await seedInterruptedMutation();
	expect(await confirm(next)).toMatchObject({ success: false });
	await awaitRecoveryBarrier();
	expect(await readMutationEntry("usb:b")).toBeUndefined();
	expect(readdirSync(journal.root())).toEqual(["old"]);
});

test("runtime clear retries directory acknowledgement and verifies without replaying a readable peer", async () => {
	let failSync = false;
	setMutationJournalDeps({
		dir: journal.root(),
		fs: {
			...defaultMutationJournalFs,
			fsyncDir: async (dir) => {
				if (failSync) throw new Error("directory unavailable");
				await defaultMutationJournalFs.fsyncDir(dir);
			},
		},
	});
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	await seedInterruptedMutation();
	writeFileSync(path("usb:a"), "{bad");
	beginRecoveryBarrier();
	await clock.at(1);
	clock.advance(); // first runtime verify is a timed pass
	const token = await exhaust(clock, 2);
	failSync = true;
	expect(await confirm(token)).toMatchObject({
		success: false,
		error: "journal_write_failed",
	});
	await clock.at(5);
	expect(isRecoveryPending()).toBe(true);
	expect(await readMutationEntry("usb:b")).toMatchObject({
		state: "executing",
	});
	failSync = false;
	clock.advance();
	await clock.at(6); // the directory acknowledgement itself changed the revision
	clock.advance();
	await awaitRecoveryBarrier();
	expect(await readMutationEntry("usb:b")).toMatchObject({
		state: "executing",
	});
});

test("a reboot invalidates confirmation and each clear archives only its offered slot", async () => {
	for (const key of ["usb:a", "usb:b"]) writeFileSync(path(key), "{bad");
	await seedFailedMutation("usb:c");
	const before = new JournalRetryClock();
	await initMutationRecovery({ sleep: before.sleep });
	const stale = await exhaust(before);
	const after = new JournalRetryClock();
	await initMutationRecovery({ sleep: after.sleep });
	expect(await confirm(stale)).toMatchObject({ success: false });
	const first = await exhaust(after);
	expect(await confirm(first)).toEqual({ success: true });
	const second = await offered();
	expect(second).not.toBe(first);
	expect(isRecoveryPending()).toBe(true);
	expect(await confirm(first)).toMatchObject({ success: false });
	expect(await confirm(second)).toEqual({ success: true });
	await awaitRecoveryBarrier();
	expect(await readMutationEntry("usb:c")).toMatchObject({ state: "failed" });
	expect(
		readdirSync(journal.root()).filter((n) => n.endsWith(".archived")),
	).toHaveLength(2);
});
