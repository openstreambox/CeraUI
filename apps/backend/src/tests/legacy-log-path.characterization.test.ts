import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as runModule from "../helpers/run.ts";
import * as mockService from "../mocks/mock-service.ts";
import { getLog } from "../modules/system/logs.ts";
import { SUPPORT_JOURNAL_MATCHES } from "../modules/system/support-journal.ts";
import * as notifications from "../modules/ui/notifications.ts";

const MAX_BUFFER = 10 * 1024 * 1024;

type RunCall = [string, string[], { maxBuffer: number; timeout: number }];

// The download reads a bounded, typed journal history and redacts it.
const HISTORY_ARGS = [
	"--since=-7days",
	"--lines=10000",
	"--no-pager",
	"--output=json",
	"--output-fields=MESSAGE,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_COMM,_TRANSPORT,_PID,_STREAM_ID,_LINE_BREAK,_BOOT_ID,__REALTIME_TIMESTAMP",
];
const HISTORY_OPTIONS = { maxBuffer: MAX_BUFFER, timeout: 15000 };

function expectRedactedExport(contents: string | undefined, raw: string): void {
	expect(contents?.startsWith("Support log: retained last 7 days;")).toBe(true);
	expect(contents).toContain("Records: 0 shown, 1 withheld");
	expect(contents).not.toContain(raw);
}

function fakeConn(sent: string[]) {
	return {
		send: (frame: string) => sent.push(frame),
		data: { senderId: "characterization" },
	} as never;
}

function journalctlCalls(spy: { mock: { calls: unknown[][] } }): RunCall[] {
	return spy.mock.calls.filter(
		(call): call is RunCall => call[0] === "journalctl",
	);
}

function expectLogPush(sent: string[], name: string, contents: string): void {
	expect(sent).toHaveLength(1);
	expect(JSON.parse(sent[0] ?? "")).toEqual({
		log: { name, contents },
		id: "characterization",
	});
}

afterEach(() => {
	spyOn(runModule, "run").mockRestore?.();
	spyOn(mockService, "shouldUseMocks").mockRestore?.();
	spyOn(notifications, "notificationSend").mockRestore?.();
	spyOn(logger, "error").mockRestore?.();
});

describe("legacy system log download path", () => {
	it("gets a service journal, returns its file and sends one matching frame", async () => {
		const contents = "service journal output";
		const runSpy = spyOn(runModule, "run").mockResolvedValue(contents);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const sent: string[] = [];

		const result = await getLog(fakeConn(sent), "ceralive.service");

		expect(journalctlCalls(runSpy)[0]).toEqual([
			"journalctl",
			[...HISTORY_ARGS, "-u", "ceralive.service"],
			HISTORY_OPTIONS,
		]);
		expect(result?.name).toBe("ceralive.service_log.txt");
		expectRedactedExport(result?.contents, contents);
		expectLogPush(sent, "ceralive.service_log.txt", result?.contents ?? "");
	});

	it("echoes the client's request id in the frame, for a unit or the full journal", async () => {
		spyOn(runModule, "run").mockResolvedValue("journal output");
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const sent: string[] = [];

		await getLog(fakeConn(sent), "ceralive.service", "7");
		await getLog(fakeConn(sent), undefined, "8");

		expect(sent.map((frame) => JSON.parse(frame).log.request)).toEqual([
			"7",
			"8",
		]);
	});

	it("gets the full boot journal when no service is supplied", async () => {
		const contents = "full journal output";
		const runSpy = spyOn(runModule, "run").mockResolvedValue(contents);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const sent: string[] = [];

		const result = await getLog(fakeConn(sent));

		expect(journalctlCalls(runSpy)[0]).toEqual([
			"journalctl",
			[...HISTORY_ARGS, ...SUPPORT_JOURNAL_MATCHES],
			HISTORY_OPTIONS,
		]);
		expect(result?.name).toBe("ceralive_system_log.txt");
		expectRedactedExport(result?.contents, contents);
		expectLogPush(sent, "ceralive_system_log.txt", result?.contents ?? "");
	});

	it("returns undefined and raises log_error without a log frame on failure", async () => {
		const runSpy = spyOn(runModule, "run").mockRejectedValue(
			new Error("journalctl unavailable"),
		);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		const notify = spyOn(notifications, "notificationSend");
		spyOn(logger, "error").mockImplementation(() => logger);
		const sent: string[] = [];
		const conn = fakeConn(sent);

		const result = await getLog(conn, "ceralive.service");

		expect(journalctlCalls(runSpy)).toEqual([
			[
				"journalctl",
				[...HISTORY_ARGS, "-u", "ceralive.service"],
				HISTORY_OPTIONS,
			],
		]);
		expect(result).toBeUndefined();
		expect(sent).toHaveLength(1);
		const frame = JSON.parse(sent[0] ?? "") as Record<string, unknown>;
		expect("log" in frame).toBe(false);
		expect(frame).toEqual({
			notification: {
				show: [
					{
						name: "log_error",
						type: "error",
						msg: "Failed to read the system journal.",
						is_dismissable: true,
						is_persistent: false,
						duration: 10,
					},
				],
			},
			id: "characterization",
		});
		expect(notify).toHaveBeenCalledWith(
			conn,
			"log_error",
			"error",
			"Failed to read the system journal.",
			10,
		);
	});

	it("uses the mock journal header for unit and full-journal downloads", async () => {
		const runSpy = spyOn(runModule, "run");
		spyOn(mockService, "shouldUseMocks").mockReturnValue(true);

		const unit = await getLog(fakeConn([]), "ceralive.service");
		const system = await getLog(fakeConn([]));

		expect(
			unit?.contents.startsWith(
				"-- Logs begin for unit ceralive.service (CeraUI mock journal) --",
			),
		).toBe(true);
		expect(
			system?.contents.startsWith(
				"-- Logs begin, full CeraUI system journal (mock) --",
			),
		).toBe(true);
		expect(journalctlCalls(runSpy)).toEqual([]);
	});
});
