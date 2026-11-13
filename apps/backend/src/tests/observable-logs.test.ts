/*
 * Task 13 — observable logs + persistent notifications (S8).
 *
 * Proves the getLog/getSyslog RPC is a REAL data source (not the former
 * `{ log: "" }` stub) and that a known backend log event is retrievable through
 * the chosen path:
 *
 *  - getLog/getSyslog handlers invoke modules/system/logs.ts, return the real
 *    journal contents, AND push the `log` event the LogsDialog turns into a
 *    download (both halves of the contract).
 *  - getLog defaults to the `ceralive.service` unit (the device/application log);
 *    getSyslog is the unfiltered boot journal.
 *  - the in-memory log ring buffer captures a real backend logger event, so the
 *    dev/CI mock journal that getLog serves contains it.
 *  - notifications.getPersistent returns the live persistent set (not an empty
 *    stub) so the pull endpoint mirrors the `notification` push the panel reads.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { call } from "@orpc/server";

import {
	clearRecentLogLines,
	getRecentLogLines,
	logger,
} from "../helpers/logger.ts";
import * as runModule from "../helpers/run.ts";
import * as carrierModule from "../modules/modems/modem-wire-producer.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { getPersistentNotificationsProcedure } from "../rpc/procedures/notifications.procedure.ts";
import {
	getLogProcedure,
	getSyslogProcedure,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const JOURNAL_ARGS = [
	"--since=-7days",
	"--lines=10000",
	"--no-pager",
	"--output=json",
	"--output-fields=MESSAGE,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_COMM,_TRANSPORT,_PID,_STREAM_ID,_LINE_BREAK,_BOOT_ID,__REALTIME_TIMESTAMP",
];
const MAX_BUFFER = 10 * 1024 * 1024;

function journal(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			JSON.stringify({
				_SYSTEMD_UNIT: "ceralive.service",
				MESSAGE: JSON.stringify({ msg: line }),
			}),
		)
		.join("\n");
}

/** Capturing RPC context: records every frame the handler pushes to the socket. */
function makeContext(sent: string[]): RPCContext {
	const ws = {
		send: (frame: string) => {
			sent.push(frame);
		},
		data: { isAuthenticated: true, lastActive: Date.now(), senderId: "test" },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

/** Find the pushed `{ log: { name, contents } }` frame. */
function findLogPush(
	sent: string[],
): { name: string; contents: string } | undefined {
	for (const frame of sent) {
		const parsed = JSON.parse(frame) as {
			log?: { name: string; contents: string };
		};
		if (parsed.log) return parsed.log;
	}
	return undefined;
}

afterEach(() => {
	spyOn(runModule, "run").mockRestore?.();
	spyOn(carrierModule, "getCarrierSupportSummary").mockRestore?.();
});

describe("system.getLog / system.getSyslog — real data + log push", () => {
	it("getLog returns the journal contents (NOT an empty stub) and pushes a log frame", async () => {
		const KNOWN = "Jun 25 12:00:00 ceralive[42]: known boot event marker";
		spyOn(runModule, "run").mockResolvedValue(journal(KNOWN));

		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});

		expect(result.log).toContain(KNOWN);
		expect(result.log).not.toBe("");

		const push = findLogPush(sent);
		expect(push).toBeDefined();
		expect(push?.contents).toContain(KNOWN);
		expect(push?.name).toBe("ceralive.service_log.txt");
	});

	it("exports retained previous-boot evidence and redacts both RPC and pushed files", async () => {
		spyOn(runModule, "run").mockResolvedValue(
			journal(
				"previous boot marker\nIMEI=351756051523999\n-- Reboot --\ncurrent boot marker\ncell_id=0xabc123",
			),
		);
		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});
		expect(result.log).toContain("previous boot marker");
		expect(result.log).toContain("current boot marker");
		expect(findLogPush(sent)?.contents).toBe(result.log);
		for (const value of ["351756051523999", "0xabc123"])
			expect(JSON.stringify([result, sent])).not.toContain(value);
	});
	it("does not disclose partial raw stdout on overflow or timeout", async () => {
		spyOn(runModule, "run").mockRejectedValue(
			new Error("maxBuffer: IMEI=351756051523999"),
		);
		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});
		expect(result.log).toBe("");
		expect(findLogPush(sent)).toBeUndefined();
		expect(JSON.stringify(sent)).not.toContain("351756051523999");
	});

	it("a failed carrier summary leaves the redacted journal downloadable", async () => {
		spyOn(runModule, "run").mockResolvedValue(
			journal("retained journal evidence"),
		);
		spyOn(carrierModule, "getCarrierSupportSummary").mockImplementation(() => {
			throw new Error("private-summary-fault");
		});
		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});
		expect(result.log).toContain("retained journal evidence");
		expect(result.log).toContain("Carrier support summary unavailable");
		expect(findLogPush(sent)?.contents).toBe(result.log);
		expect(JSON.stringify(sent)).not.toContain("private-summary-fault");
	});
	it("history timeout retries only the current boot with identical byte and process limits", async () => {
		const runSpy = spyOn(runModule, "run")
			.mockRejectedValueOnce(
				new runModule.RunTimeoutError(
					"journalctl",
					"private-partial-imei",
					"private-stderr",
				),
			)
			.mockResolvedValueOnce(journal("current boot evidence"));
		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});
		expect(runSpy).toHaveBeenNthCalledWith(
			2,
			"journalctl",
			["-b", ...JOURNAL_ARGS, "-u", "ceralive.service"],
			{ maxBuffer: MAX_BUFFER, timeout: 15000 },
		);
		expect(result.log).toContain("current boot only");
		expect(result.log).toContain("current boot evidence");
		expect(JSON.stringify(sent)).not.toContain("private-partial-imei");
	});
	it("ordinary collection failure does not retry and is not called a timeout", async () => {
		const runSpy = spyOn(runModule, "run").mockRejectedValue(
			new Error("private-command-failure"),
		);
		const sent: string[] = [];
		await call(getLogProcedure, undefined, { context: makeContext(sent) });
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(sent)).toContain("Failed to read the system journal");
		expect(JSON.stringify(sent)).not.toContain("private-command-failure");
	});

	it("does not retry again or disclose partial output when the current boot also times out", async () => {
		const runSpy = spyOn(runModule, "run").mockRejectedValue(
			new runModule.RunTimeoutError(
				"journalctl",
				"private-partial",
				"private-error",
			),
		);
		const sent: string[] = [];
		const result = await call(getLogProcedure, undefined, {
			context: makeContext(sent),
		});
		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(result.log).toBe("");
		expect(JSON.stringify(sent)).toContain(
			"timed out for both history and current boot",
		);
		expect(JSON.stringify(sent)).not.toContain("private-partial");
		expect(findLogPush(sent)).toBeUndefined();
	});
	it("distinguishes repeated size overflow from timeout without exporting the error payload", async () => {
		const runSpy = spyOn(runModule, "run").mockRejectedValue(
			new Error("stdout maxBuffer length exceeded: private-error-payload"),
		);
		const sent: string[] = [];
		await call(getLogProcedure, undefined, { context: makeContext(sent) });
		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(sent)).toContain(
			"exceeded the 10 MiB raw output limit",
		);
		expect(JSON.stringify(sent)).not.toContain("private-error-payload");
	});

	it("limits concurrent downloads to one collection and releases admission on completion", async () => {
		let release: (value: string) => void = () => {};
		let began: () => void = () => {};
		const pending = new Promise<string>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const runSpy = spyOn(runModule, "run").mockImplementation(() => {
			began();
			return pending;
		});
		const first = call(getLogProcedure, undefined, {
			context: makeContext([]),
		});
		await started;
		const sent: string[] = [];
		const others = Array.from({ length: 7 }, () =>
			call(getLogProcedure, undefined, { context: makeContext(sent) }),
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		try {
			expect(runSpy).toHaveBeenCalledTimes(1);
		} finally {
			release(journal("bounded evidence"));
			await first;
			await Promise.all(others);
		}
		expect(JSON.stringify(sent)).toContain("already in progress");
		expect(findLogPush(sent)).toBeUndefined();
		await call(getLogProcedure, undefined, { context: makeContext([]) });
		expect(runSpy).toHaveBeenCalledTimes(2);
	});
	it("retries size overflow once with a labelled 400-entry current-boot scope", async () => {
		const runSpy = spyOn(runModule, "run")
			.mockRejectedValueOnce(new Error("stdout maxBuffer length exceeded"))
			.mockResolvedValueOnce(journal("recent evidence"));
		const result = await call(getLogProcedure, undefined, {
			context: makeContext([]),
		});
		expect(runSpy).toHaveBeenLastCalledWith(
			"journalctl",
			[
				"-b",
				...JOURNAL_ARGS.map((arg) =>
					arg === "--lines=10000" ? "--lines=400" : arg,
				),
				"-u",
				"ceralive.service",
			],
			{ maxBuffer: MAX_BUFFER, timeout: 15000 },
		);
		expect(result.log).toContain(
			"current boot only (history exceeded size limit)",
		);
		expect(result.log).toContain("newest 400 entries");
		expect(result.log).toContain("recent evidence");
	});

	it("getLog defaults to the ceralive.service unit; an explicit service overrides", async () => {
		const runSpy = spyOn(runModule, "run").mockResolvedValue(journal("x"));

		await call(getLogProcedure, undefined, { context: makeContext([]) });
		expect(runSpy).toHaveBeenLastCalledWith(
			"journalctl",
			[...JOURNAL_ARGS, "-u", "ceralive.service"],
			{ maxBuffer: MAX_BUFFER, timeout: 15000 },
		);

		await call(
			getLogProcedure,
			{ service: "ssh.service" },
			{
				context: makeContext([]),
			},
		);
		expect(runSpy).toHaveBeenLastCalledWith(
			"journalctl",
			[...JOURNAL_ARGS, "-u", "ssh.service"],
			{ maxBuffer: MAX_BUFFER, timeout: 15000 },
		);
	});

	it("getSyslog returns the full boot journal (no unit filter) and pushes it", async () => {
		const KNOWN = "Jun 25 12:00:01 kernel: full system journal line";
		const runSpy = spyOn(runModule, "run").mockResolvedValue(journal(KNOWN));

		const sent: string[] = [];
		const result = await call(getSyslogProcedure, undefined, {
			context: makeContext(sent),
		});

		expect(runSpy).toHaveBeenLastCalledWith("journalctl", JOURNAL_ARGS, {
			maxBuffer: MAX_BUFFER,
			timeout: 15000,
		});
		expect(result.log).toContain(KNOWN);
		expect(findLogPush(sent)?.contents).toContain(KNOWN);
	});

	it("getLog degrades to an empty string (never throws) when journalctl fails", async () => {
		spyOn(runModule, "run").mockRejectedValue(new Error("journalctl boom"));

		const result = await call(getLogProcedure, undefined, {
			context: makeContext([]),
		});
		expect(result.log).toBe("");
	});
});

describe("log ring buffer — observable-logs substrate", () => {
	it("captures a real backend logger event for the dev/CI mock journal", async () => {
		clearRecentLogLines();
		logger.error("RING-MARKER known backend failure xyz", { module: "test" });
		// Winston flushes the Stream transport on the next tick.
		await new Promise((resolve) => setTimeout(resolve, 20));

		const captured = getRecentLogLines().join("\n");
		expect(captured).toContain("RING-MARKER known backend failure xyz");
	});
});

describe("notifications.getPersistent — real persistent set", () => {
	const NAME = "task13-observable-logs-marker";

	beforeEach(() => {
		notificationRemove(NAME);
	});
	afterEach(() => {
		notificationRemove(NAME);
	});

	it("returns the live persistent notifications (NOT an empty stub)", async () => {
		notificationBroadcast(NAME, "error", "Known backend failure", 0, true);

		const result = await call(getPersistentNotificationsProcedure, undefined, {
			context: makeContext([]),
		});

		const item = result.show.find((n) => n.name === NAME);
		expect(item).toBeDefined();
		expect(item?.msg).toBe("Known backend failure");
		expect(item?.is_persistent).toBe(true);
	});
});
