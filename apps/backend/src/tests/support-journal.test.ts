import { describe, expect, test } from "bun:test";
import { renderSupportJournal } from "../modules/system/support-journal.ts";

function entry(message: string, fields: Record<string, unknown> = {}) {
	return JSON.stringify({
		_SYSTEMD_UNIT: "NetworkManager.service",
		_PID: "612",
		_STREAM_ID: "a",
		MESSAGE: message,
		...fields,
	});
}

describe("trusted journal source and record boundaries", () => {
	test("unknown units and sudo/audit children cannot impersonate an allowed message prefix", () => {
		const lines = [
			entry("unlabelled-private-value", {
				_SYSTEMD_UNIT: "ceralive.service",
				SYSLOG_IDENTIFIER: { toString: null },
			}),
			entry("ceralive[42]: unlabelled-private-value", {
				_SYSTEMD_UNIT: "unknown.service",
			}),
			entry("unlabelled-private-value", {
				_SYSTEMD_UNIT: "ceralive.service",
				SYSLOG_IDENTIFIER: "sudo",
				_COMM: "sudo",
			}),
			entry("unlabelled-private-value", {
				_SYSTEMD_UNIT: "ceralive.service",
				SYSLOG_IDENTIFIER: "audit",
			}),
		];
		expect(renderSupportJournal(lines.join("\n"))).not.toContain(
			"unlabelled-private-value",
		);
	});
	test("renders source/time and boot ordinals while omitting hostname and raw boot identities", () => {
		const output = renderSupportJournal(
			entry("USB disconnect", {
				_TRANSPORT: "kernel",
				_HOSTNAME: "private-hostname",
				_BOOT_ID: "private-boot-a",
				__REALTIME_TIMESTAMP: "1731528245123400",
			}) +
				"\n" +
				entry("USB reset", {
					_TRANSPORT: "kernel",
					_BOOT_ID: "private-boot-b",
				}),
		);
		expect(output).toContain("[boot 1]");
		expect(output).toContain("[boot 2]");
		expect(output).toContain("USB disconnect");
		expect(output).toContain("kernel:");
		expect(output).not.toContain("private-hostname");
		expect(output).not.toContain("private-boot");
	});
	test("collapses runs of withheld records into one counted marker", () => {
		const output = renderSupportJournal(
			[
				entry("private-a", { _SYSTEMD_UNIT: "unknown.service" }),
				entry("private-b", { _SYSTEMD_UNIT: "unknown.service" }),
				entry("private-c", { _SYSTEMD_UNIT: "unknown.service" }),
				entry("USB disconnect", { _TRANSPORT: "kernel" }),
				entry("private-d", { _SYSTEMD_UNIT: "unknown.service" }),
			].join("\n"),
		).split("\n");
		expect(output).toEqual([
			"[REDACTED 3 support log lines]",
			"kernel: USB disconnect",
			"[REDACTED support log line]",
		]);
	});
	test("drains line-max tails per stream across interleaved diagnostics", () => {
		const output = renderSupportJournal(
			[
				entry("x".repeat(49152), { _LINE_BREAK: "line-max" }),
				entry("USB disconnect", { _TRANSPORT: "kernel", _STREAM_ID: "b" }),
				entry("private-continuation-value"),
				entry("device (wwan0): state change: connecting -> failed"),
			].join("\n"),
		);
		expect(output).not.toContain("private-continuation-value");
		expect(output).toContain("USB disconnect");
		expect(output).toContain("connecting -> failed");
	});
	test("withholds raw application stderr tails and incomplete JSON fragments", () => {
		const output = renderSupportJournal(
			[
				entry('private-tail-value","x":1', {
					_SYSTEMD_UNIT: "ceralive.service",
				}),
				entry("sender stderr: private-tail-value&latency=2000 ok", {
					_SYSTEMD_UNIT: "ceralive.service",
				}),
				entry('{"msg":"stream failed"}', { _SYSTEMD_UNIT: "ceralive.service" }),
			].join("\n"),
		);
		expect(output).not.toContain("private-tail-value");
		expect(output).toContain("stream failed");
	});
});
