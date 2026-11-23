/**
 * The record a backend keeps of the engine session its Start opened, and the
 * decision a later backend process of the same boot makes from it. Settling a
 * session needs positive proof, and stopping one is off by default because the
 * engine's `stop` takes no session.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	carrierAbsent,
	engineProcess,
	localSenderPortBound,
	type OrphanRetirementDeps,
	orphanStopEnabled,
	processRuns,
	processStartTime,
	readStreamProvenance,
	recordLaunchedSession,
	retireOrphanedSession,
	STREAM_PROVENANCE_MODE,
	type StreamProvenance,
	writeStreamProvenance,
} from "../modules/streaming/stream-provenance.ts";

let proc = "";
beforeEach(() => {
	proc = mkdtempSync(join(tmpdir(), "stream-provenance-"));
	udpTables(proc);
	udpTables(join(proc, "700"));
});
afterEach(() => rmSync(proc, { recursive: true, force: true }));

const HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n";
/** `net/udp{,6}` rows under `root`; the sender binds 9000 (0x2328). */
function udpTables(
	root: string,
	udp6Rows: string[] = [],
	udpRows: string[] = [],
) {
	mkdirSync(join(root, "net"), { recursive: true });
	writeFileSync(join(root, "net", "udp"), HEADER + udpRows.join("\n"));
	writeFileSync(join(root, "net", "udp6"), HEADER + udp6Rows.join("\n"));
}
const row = (port: number) =>
	`  231: 00000000000000000000000000000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 2868780 2 00000000253f623a 0`;
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
	version: 2,
	bootId: "boot-1",
	sessionId: "cs-3",
	engine: { pid: 700, startTime: "1000" },
	sender: { pid: 4242, startTime: "3960195" },
	port: 9000,
};

test("the start time is field 22 even when the name holds spaces and parentheses", () => {
	processRow(4242, "srtla send (x)", "3960195");
	expect(processStartTime(4242, proc)).toBe("3960195");
	expect(processRuns(RECORD.sender, proc)).toBe(true);
	expect(processRuns({ pid: 4242, startTime: "1" }, proc)).toBe(false);
	expect(processRuns({ pid: 4343, startTime: "3960195" }, proc)).toBe(false);
});

test("the port is read from both UDP tables of the given namespace", () => {
	expect(localSenderPortBound(proc, 9000)).toBe(false);
	udpTables(proc, [row(9000)]);
	expect(localSenderPortBound(proc, 9000)).toBe(true);
	expect(localSenderPortBound(proc, 9001)).toBe(false);
	udpTables(proc, [], [row(9001)]);
	expect(localSenderPortBound(proc, 9001)).toBe(true);
	rmSync(join(proc, "net", "udp6"));
	expect(localSenderPortBound(proc, 9001)).toBeUndefined();
});

test("the carrier is absent only when every sign of one is", () => {
	const none = () => false;
	expect(carrierAbsent(RECORD, proc, none)).toBe(true);

	// The recorded sender still runs, under any name and between binds.
	processRow(4242, "sender-wrapper", "3960195");
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	// Its PID was reused by something else: that is not our sender.
	processRow(4242, "bash", "5000000");
	expect(carrierAbsent(RECORD, proc, none)).toBe(true);
	// Any process named srtla_send counts.
	processRow(5151, "srtla_send", "5100000");
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	rmSync(join(proc, "5151"), { recursive: true });
	// A sender under another name holding the recorded port, here ...
	udpTables(proc, [row(9000)]);
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	udpTables(proc);
	// ... or in the engine's network namespace, where its packets go.
	udpTables(join(proc, "700"), [row(9000)]);
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	udpTables(join(proc, "700"));
	// The recorded port is checked, not the current default.
	udpTables(proc, [row(9000)]);
	expect(carrierAbsent({ ...RECORD, port: 9100 }, proc, none)).toBe(true);
	udpTables(proc, [row(9100)]);
	expect(carrierAbsent({ ...RECORD, port: 9100 }, proc, none)).toBe(false);
	udpTables(proc);
	// A child of this backend's own session.
	expect(carrierAbsent(RECORD, proc, () => true)).toBe(false);
	// An unreadable census is not absence ...
	mkdirSync(join(proc, "6161", "comm"), { recursive: true });
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	rmSync(join(proc, "6161"), { recursive: true });
	// ... nor are unreadable port tables, here or in the engine's namespace.
	rmSync(join(proc, "700", "net"), { recursive: true });
	expect(carrierAbsent(RECORD, proc, none)).toBe(false);
	udpTables(join(proc, "700"));
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

test("a record round-trips owner-only, and anything malformed reads as no record", () => {
	const path = join(proc, "stream-session.json");
	expect(readStreamProvenance(path)).toBeUndefined();
	writeStreamProvenance(RECORD, path);
	expect(readStreamProvenance(path)).toEqual(RECORD);
	expect(statSync(path).mode & 0o777).toBe(STREAM_PROVENANCE_MODE);
	expect(STREAM_PROVENANCE_MODE).toBe(0o600);
	for (const bad of [
		{ ...RECORD, sessionId: "" },
		{ ...RECORD, extra: 1 },
		{ ...RECORD, version: 1 },
		{ ...RECORD, port: 0 },
	]) {
		writeFileSync(path, JSON.stringify(bad));
		expect(readStreamProvenance(path)).toBeUndefined();
	}
	writeFileSync(path, "{");
	expect(readStreamProvenance(path)).toBeUndefined();
});

test("stopping is off unless the flag says otherwise", () => {
	const saved = process.env.CERALIVE_STOP_ORPHANED_SESSIONS;
	try {
		delete process.env.CERALIVE_STOP_ORPHANED_SESSIONS;
		expect(orphanStopEnabled()).toBe(false);
		process.env.CERALIVE_STOP_ORPHANED_SESSIONS = "true";
		expect(orphanStopEnabled()).toBe(false);
		process.env.CERALIVE_STOP_ORPHANED_SESSIONS = "1";
		expect(orphanStopEnabled()).toBe(true);
	} finally {
		if (saved === undefined) delete process.env.CERALIVE_STOP_ORPHANED_SESSIONS;
		else process.env.CERALIVE_STOP_ORPHANED_SESSIONS = saved;
	}
});

function decision(overrides: Partial<OrphanRetirementDeps> = {}) {
	const stops: string[] = [];
	let engineSamples = 0;
	const deps: OrphanRetirementDeps = {
		readRecord: () => RECORD,
		bootId: () => "boot-1",
		carrierAbsent: () => true,
		engineProcess: async () => {
			engineSamples++;
			return RECORD.engine;
		},
		engineReportsNoSession: async () => true,
		stopEnabled: () => true,
		stopRecordedSession: async (sessionId, beforeDispatch, afterSnapshot) => {
			if (!(await afterSnapshot()) || !beforeDispatch()) return false;
			stops.push(sessionId);
			return true;
		},
		...overrides,
	};
	return { deps, stops, engineSamples: () => engineSamples };
}

test("only the recorded session in the recorded engine process is stopped, and only when enabled", async () => {
	const ok = decision();
	expect(await retireOrphanedSession("streaming", ok.deps)).toBe("stopped");
	expect(ok.stops).toEqual(["cs-3"]);
	// Sampled before the connection and again after its snapshot.
	expect(ok.engineSamples()).toBe(2);

	for (const [name, overrides] of [
		["stop disabled", { stopEnabled: () => false }],
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
		[
			"an adapter without the targeted stop",
			{ stopRecordedSession: undefined },
		],
	] as const) {
		const refused = decision(overrides as Partial<OrphanRetirementDeps>);
		expect(await retireOrphanedSession("streaming", refused.deps), name).toBe(
			"refused",
		);
		expect(refused.stops, name).toEqual([]);
	}
});

/** Review probe: an engine restart between the first sample and the connection. */
test("an engine replaced while the connection opens refuses the stop", async () => {
	let samples = 0;
	const replaced = decision({
		engineProcess: async () =>
			++samples === 1 ? RECORD.engine : { pid: 701, startTime: "2000" },
	});
	expect(await retireOrphanedSession("streaming", replaced.deps)).toBe(
		"refused",
	);
	expect(replaced.stops).toEqual([]);
});

test("a carrier that appears before the stop is written refuses it", async () => {
	let checks = 0;
	const late = decision({ carrierAbsent: () => ++checks === 1 });
	expect(await retireOrphanedSession("streaming", late.deps)).toBe("refused");
	expect(late.stops).toEqual([]);
	expect(checks).toBe(2);
});

test("a silent engine ends a recorded session only on a valid empty snapshot, without a stop", async () => {
	const silent = decision({
		engineProcess: async () => {
			throw new Error("not asked");
		},
		stopEnabled: () => false,
	});
	expect(await retireOrphanedSession("silent", silent.deps)).toBe("gone");
	expect(silent.stops).toEqual([]);
	for (const overrides of [
		{ engineReportsNoSession: async () => false },
		{ readRecord: () => undefined },
		{ carrierAbsent: () => false },
	]) {
		const refused = decision(overrides);
		expect(await retireOrphanedSession("silent", refused.deps)).toBe("refused");
		expect(refused.stops).toEqual([]);
	}
});

test("the record is written only with every piece known and still current", async () => {
	const written: StreamProvenance[] = [];
	const base = {
		sessionId: () => "cs-3" as string | undefined,
		senderPid: () => 4242 as number | undefined,
		bootId: () => "boot-1" as string | undefined,
		port: 9000,
		engineProcess: async () =>
			RECORD.engine as typeof RECORD.engine | undefined,
		processStartTime: (pid: number) => (pid === 4242 ? "3960195" : undefined),
		current: () => true,
		write: (record: StreamProvenance) => written.push(record),
	};
	expect(await recordLaunchedSession(base)).toBe(true);
	expect(written).toEqual([RECORD]);
	let sessionReads = 0;
	let startReads = 0;
	for (const missing of [
		{ sessionId: () => undefined },
		{ senderPid: () => undefined },
		{ bootId: () => undefined },
		{ engineProcess: async () => undefined },
		{ processStartTime: () => undefined },
		{ current: () => false },
		// The session changed while the engine was sampled.
		{ sessionId: () => (++sessionReads === 1 ? "cs-3" : "cs-4") },
		// The sender was replaced meanwhile.
		{ processStartTime: () => (++startReads === 1 ? "3960195" : "3960999") },
	]) {
		expect(await recordLaunchedSession({ ...base, ...missing })).toBe(false);
	}
	expect(written).toHaveLength(1);
});
