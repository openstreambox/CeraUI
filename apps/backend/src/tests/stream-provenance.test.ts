/**
 * The record a backend keeps of the engine session its Start opened, and the
 * decision a later backend process of the same boot makes from it. An
 * automatic Stop needs positive proof: the recorded session, in the recorded
 * engine process, with nothing left that could carry it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	carrierAbsent,
	engineProcess,
	localSenderPortBound,
	type OrphanRetirementDeps,
	processRuns,
	processStartTime,
	readStreamProvenance,
	recordLaunchedSession,
	retireOrphanedSession,
	type StreamProvenance,
	writeStreamProvenance,
} from "../modules/streaming/stream-provenance.ts";

let proc = "";
beforeEach(() => {
	proc = mkdtempSync(join(tmpdir(), "stream-provenance-"));
	udpTables();
});
afterEach(() => rmSync(proc, { recursive: true, force: true }));

const HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n";
/** `/proc/net/udp{,6}` rows; the sender binds 9000 (0x2328) on the wildcard. */
function udpTables(udp6Rows: string[] = [], udpRows: string[] = []) {
	mkdirSync(join(proc, "net"), { recursive: true });
	writeFileSync(join(proc, "net", "udp"), HEADER + udpRows.join("\n"));
	writeFileSync(join(proc, "net", "udp6"), HEADER + udp6Rows.join("\n"));
}
const SENDER_ROW =
	"  231: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 2868780 2 00000000253f623a 0";
/** A `/proc/<pid>` row with a name and a start time (field 22). */
function processRow(pid: number, comm: string, startTime: string) {
	mkdirSync(join(proc, String(pid)), { recursive: true });
	writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
	const fields = ["S", "1", ...Array(17).fill("0"), startTime, "0"];
	writeFileSync(
		join(proc, String(pid), "stat"),
		`${pid} (${comm}) ${fields.join(" ")}\n`,
	);
}

const RECORD: StreamProvenance = {
	version: 1,
	bootId: "boot-1",
	sessionId: "cs-3",
	engine: { pid: 700, startTime: "1000" },
	sender: { pid: 4242, startTime: "3960195" },
};

test("the start time is field 22 even when the name holds spaces and parentheses", () => {
	processRow(4242, "srtla send (x)", "3960195");
	expect(processStartTime(4242, proc)).toBe("3960195");
	expect(processRuns(RECORD.sender, proc)).toBe(true);
	expect(processRuns({ pid: 4242, startTime: "1" }, proc)).toBe(false);
	expect(processRuns({ pid: 4343, startTime: "3960195" }, proc)).toBe(false);
});

test("the local sender port is read from both UDP tables", () => {
	expect(localSenderPortBound(proc)).toBe(false);
	udpTables([SENDER_ROW]);
	expect(localSenderPortBound(proc)).toBe(true);
	udpTables(
		[],
		[
			SENDER_ROW.replace(
				"00000000000000000000000000000000:2328",
				"0100007F:2328",
			),
		],
	);
	expect(localSenderPortBound(proc)).toBe(true);
	rmSync(join(proc, "net", "udp6"));
	expect(localSenderPortBound(proc)).toBeUndefined();
});

test("the carrier is absent only when every sign of one is", () => {
	const none = () => false;
	expect(carrierAbsent(RECORD, proc, none)).toBe(true);

	// The recorded sender still runs, even under another name and between binds.
	processRow(4242, "sender-wrapper", "3960195");
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	processRow(4242, "srtla_send", "3960195");
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	// Its PID was reused by something else: that is not our sender ...
	processRow(4242, "bash", "5000000");
	expect(carrierAbsent(RECORD, proc, none)).toBe(true);
	// ... but any process named srtla_send counts.
	processRow(5151, "srtla_send", "5100000");
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	rmSync(join(proc, "5151"), { recursive: true });
	// A sender under another name still holds the port.
	processRow(5252, "sender-wrapper", "5200000");
	udpTables([SENDER_ROW]);
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	udpTables();
	// A child of this backend's own session.
	expect(carrierAbsent(RECORD, proc, () => true)).toBe(false);
	// Unreadable tables are not absence.
	rmSync(join(proc, "net"), { recursive: true });
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
});

test("the engine process comes from the unit's main PID and its start time", async () => {
	processRow(700, "cerastream", "1000");
	expect(await engineProcess(proc, async () => "MainPID=700\n")).toEqual({
		pid: 700,
		startTime: "1000",
	});
	expect(await engineProcess(proc, async () => "MainPID=0\n")).toBeUndefined();
	expect(
		await engineProcess(proc, async () => "MainPID=701\n"),
	).toBeUndefined();
	expect(
		await engineProcess(proc, async () => {
			throw new Error("no systemd");
		}),
	).toBeUndefined();
});

test("a record round-trips and anything malformed reads as no record", () => {
	const path = join(proc, "stream-session.json");
	expect(readStreamProvenance(path)).toBeUndefined();
	writeStreamProvenance(RECORD, path);
	expect(readStreamProvenance(path)).toEqual(RECORD);
	writeFileSync(path, JSON.stringify({ ...RECORD, sessionId: "" }));
	expect(readStreamProvenance(path)).toBeUndefined();
	writeFileSync(path, JSON.stringify({ ...RECORD, extra: 1 }));
	expect(readStreamProvenance(path)).toBeUndefined();
	writeFileSync(path, "{");
	expect(readStreamProvenance(path)).toBeUndefined();
});

function decision(overrides: Partial<OrphanRetirementDeps> = {}) {
	const stops: string[] = [];
	const deps: OrphanRetirementDeps = {
		readRecord: () => RECORD,
		bootId: () => "boot-1",
		carrierAbsent: () => true,
		engineProcess: async () => RECORD.engine,
		stopRecordedSession: async (sessionId, beforeDispatch) => {
			if (!beforeDispatch()) return false;
			stops.push(sessionId);
			return true;
		},
		...overrides,
	};
	return { deps, stops };
}

test("only the recorded session in the recorded engine process is stopped", async () => {
	const ok = decision();
	expect(await retireOrphanedSession("streaming", ok.deps)).toBe("stopped");
	expect(ok.stops).toEqual(["cs-3"]);

	for (const [name, overrides] of [
		["no record", { readRecord: () => undefined }],
		["another boot", { bootId: () => "boot-2" }],
		["unknown boot", { bootId: () => undefined }],
		["a carrier remains", { carrierAbsent: () => false }],
		["unknown engine process", { engineProcess: async () => undefined }],
		[
			"a restarted engine",
			{ engineProcess: async () => ({ pid: 700, startTime: "2000" }) },
		],
		[
			"another engine PID",
			{ engineProcess: async () => ({ pid: 701, startTime: "1000" }) },
		],
		["an adapter without the stop", { stopRecordedSession: undefined }],
	] as const) {
		const refused = decision(overrides as Partial<OrphanRetirementDeps>);
		expect(await retireOrphanedSession("streaming", refused.deps), name).toBe(
			"refused",
		);
		expect(refused.stops, name).toEqual([]);
	}
});

test("a carrier that appears before the stop is written refuses it", async () => {
	let checks = 0;
	const late = decision({ carrierAbsent: () => ++checks === 1 });
	expect(await retireOrphanedSession("streaming", late.deps)).toBe("refused");
	expect(late.stops).toEqual([]);
	expect(checks).toBe(2);
});

test("a silent engine ends a recorded session without any stop", async () => {
	const silent = decision({
		engineProcess: async () => {
			throw new Error("not asked");
		},
	});
	expect(await retireOrphanedSession("silent", silent.deps)).toBe("gone");
	expect(silent.stops).toEqual([]);
	expect(
		await retireOrphanedSession(
			"silent",
			decision({ readRecord: () => undefined }).deps,
		),
	).toBe("refused");
	expect(
		await retireOrphanedSession(
			"silent",
			decision({ carrierAbsent: () => false }).deps,
		),
	).toBe("refused");
});

test("the record is written only with every piece known and the session current", async () => {
	const written: StreamProvenance[] = [];
	const base = {
		sessionId: () => "cs-3" as string | undefined,
		senderPid: () => 4242 as number | undefined,
		bootId: () => "boot-1" as string | undefined,
		engineProcess: async () =>
			RECORD.engine as typeof RECORD.engine | undefined,
		processStartTime: (pid: number) => (pid === 4242 ? "3960195" : undefined),
		current: () => true,
		write: (record: StreamProvenance) => written.push(record),
	};
	expect(await recordLaunchedSession(base)).toBe(true);
	expect(written).toEqual([RECORD]);
	for (const missing of [
		{ sessionId: () => undefined },
		{ senderPid: () => undefined },
		{ bootId: () => undefined },
		{ engineProcess: async () => undefined },
		{ processStartTime: () => undefined },
		{ current: () => false },
	]) {
		expect(await recordLaunchedSession({ ...base, ...missing })).toBe(false);
	}
	expect(written).toHaveLength(1);
});
