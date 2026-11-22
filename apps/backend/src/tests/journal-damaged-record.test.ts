import { expect, test } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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

function idleSession() {
	return createStreamSessionOrchestrator({
		initialLiveness: () => "idle",
		createAttemptId: () => "journal-test",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		recoveryPending: isRecoveryPending,
	});
}

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
	expect(warning()).toMatchObject({
		is_persistent: true,
		is_dismissable: false,
		params: { record: basename(path("usb:a")).slice(0, 8) },
	});
	await clock.at(4);
	expect(clock.waits).toEqual([1000, 2000, 4000, 8000]);
	expect(
		getPersistentNotifications(false).show.some((n) => n.name === name),
	).toBe(false);
	notificationDismiss(name);
	expect(warning()?.name).toBe(name);
	const session = idleSession();
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

test("boot keeps checking an offered record and replays its repair without confirmation", async () => {
	writeFileSync(path("usb:b"), "{bad");
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const token = await exhaust(clock);
	for (let pass = 4; pass < 8; pass++) {
		await clock.at(pass);
		clock.advance();
	}
	await clock.at(8);
	expect(clock.waits).toEqual([
		1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
	]);
	expect(warning()?.action).toMatchObject({ token });
	expect(isRecoveryPending()).toBe(true);
	await seedInterruptedMutation();
	clock.advance();
	await awaitRecoveryBarrier();
	const session = idleSession();
	expect(
		(await session.start({ origin: "ui", launch: async () => {} })).result,
	).toBe("started");
	await session.stop("operator");
	expect(warning()).toBeUndefined();
	expect(readdirSync(journal.root())).toEqual([]);
	expect(await confirm(token)).toEqual({ success: false, error: "no_entry" });
});

test("boot replays a repaired peer while the unchanged file keeps its confirmation", async () => {
	for (const key of ["usb:a", "usb:b"]) writeFileSync(path(key), "{bad");
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const token = await exhaust(clock);
	await clock.at(4);
	expect(warning()?.params?.record).toBe(mutationSlotName("usb:a").slice(0, 8));
	await seedInterruptedMutation();
	clock.advance();
	await clock.at(5);
	expect(await readMutationEntry("usb:b")).toBeUndefined();
	expect(warning()?.action).toMatchObject({ token });
	expect(isRecoveryPending()).toBe(true);
	expect(readFileSync(path("usb:a"), "utf8")).toBe("{bad");
});

test("a new unreadable file at the same name withdraws the offer and earns its own retries", async () => {
	const slot = path("usb:a");
	writeFileSync(slot, "{first");
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const old = await exhaust(clock);
	await clock.at(4);
	const replacement = join(journal.root(), "replacement");
	writeFileSync(replacement, "{second");
	renameSync(replacement, slot);
	clock.advance();
	await clock.at(5);
	expect(warning()).toBeUndefined();
	expect(await confirm(old)).toEqual({ success: false, error: "no_entry" });
	expect(isRecoveryPending()).toBe(true);
	const fresh = await exhaust(clock, 5);
	expect(fresh).not.toBe(old);
	expect(readFileSync(slot, "utf8")).toBe("{second");
	expect(await confirm(fresh)).toEqual({ success: true });
	await awaitRecoveryBarrier();
	expect(readdirSync(journal.root())).toEqual([
		".recovery-" + fresh + ".archived",
	]);
});

test("runtime verification withdraws a repaired offer without replaying an active peer", async () => {
	const clock = new JournalRetryClock();
	const slot = path("usb:a");
	let unreadable = false;
	setMutationJournalDeps({
		dir: journal.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (file) => {
				if (unreadable && file === slot)
					throw new Error("temporary read error");
				return defaultMutationJournalFs.readText(file);
			},
		},
	});
	await initMutationRecovery({ sleep: clock.sleep });
	await seedFailedMutation("usb:a");
	await seedInterruptedMutation();
	unreadable = true;
	beginRecoveryBarrier();
	await clock.at(1);
	clock.advance();
	const token = await exhaust(clock, 2);
	await clock.at(5);
	// Its identity and bytes stay the same. A successful parse on the next tick is enough.
	unreadable = false;
	clock.advance();
	await awaitRecoveryBarrier();
	expect(warning()).toBeUndefined();
	expect(await readMutationEntry("usb:a")).toMatchObject({ state: "failed" });
	expect(await readMutationEntry("usb:b")).toMatchObject({
		state: "executing",
	});
	expect(
		readdirSync(journal.root()).some((file) => file.endsWith(".archived")),
	).toBe(false);
	expect(await confirm(token)).toEqual({ success: false, error: "no_entry" });
});

test("confirming during an in-flight census schedules a fresh check without another timer", async () => {
	const slot = path("usb:a");
	writeFileSync(slot, "{bad");
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let holdNext = false;
	setMutationJournalDeps({
		dir: journal.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (file) => {
				const bytes = await defaultMutationJournalFs.readText(file);
				if (holdNext && file === slot) {
					holdNext = false;
					entered.resolve();
					await resume.promise;
				}
				return bytes;
			},
		},
	});
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const token = await exhaust(clock);
	await clock.at(4);
	holdNext = true;
	clock.advance();
	await entered.promise;
	try {
		expect(await confirm(token)).toEqual({ success: true });
		expect(isRecoveryPending()).toBe(true);
	} finally {
		resume.resolve();
	}
	await awaitRecoveryBarrier();
	expect(clock.waits).toHaveLength(4);
	expect(warning()).toBeUndefined();
	expect(readdirSync(journal.root())).toEqual([
		".recovery-" + token + ".archived",
	]);
});

test("confirmation cannot clear a repaired slot or a replacement at the same filename", async () => {
	mkdirSync(path("usb:b"));
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const token = await exhaust(clock);
	await clock.at(4);
	renameSync(path("usb:b"), join(journal.root(), "old"));
	writeFileSync(path("usb:b"), "{different");
	expect(await confirm(token)).toMatchObject({ success: false });
	expect(readFileSync(path("usb:b"), "utf8")).toBe("{different");
	const next = await exhaust(clock, 5);
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
	await clock.at(5);
	failSync = true;
	expect(await confirm(token)).toMatchObject({
		success: false,
		error: "journal_write_failed",
	});
	await clock.at(6);
	expect(isRecoveryPending()).toBe(true);
	expect(await readMutationEntry("usb:b")).toMatchObject({
		state: "executing",
	});
	failSync = false;
	clock.advance();
	await clock.at(7); // the directory acknowledgement itself changed the revision
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

test("a named fault followed by a directory listing failure never offers a partial inventory for clearing", async () => {
	writeFileSync(path("usb:a"), "{bad");
	let reads = 0;
	setMutationJournalDeps({
		dir: journal.root(),
		fs: {
			...defaultMutationJournalFs,
			listDir: async (dir) => {
				if (++reads % 2 === 0) throw new Error("second census unavailable");
				return defaultMutationJournalFs.listDir(dir);
			},
		},
	});
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	for (let pass = 1; pass <= 4; pass++) {
		await clock.at(pass);
		clock.advance();
	}
	await clock.at(5);
	expect(warning()).toBeUndefined();
	expect(isRecoveryPending()).toBe(true);
	expect(readFileSync(path("usb:a"), "utf8")).toBe("{bad");
});
