import { describe, expect, test } from "bun:test";
import {
	renderSupportJournal,
	SUPPORT_JOURNAL_MATCHES,
} from "../modules/system/support-journal.ts";

const COMM: Record<string, string> = {
	"NetworkManager.service": "NetworkManager",
	"ceralive.service": "ceralive",
};

function entry(message: string, fields: Record<string, unknown> = {}) {
	const unit = String(fields._SYSTEMD_UNIT ?? "NetworkManager.service");
	return JSON.stringify({
		_SYSTEMD_UNIT: "NetworkManager.service",
		_COMM: COMM[unit] ?? "unfamiliar",
		_PID: "612",
		_STREAM_ID: "a",
		MESSAGE: message,
		...fields,
	});
}

const NM_FAILED =
	"<warn>  [1731528245.1234] device (wwan0): state change: ip-config -> failed (reason 'gsm-registration-denied', sys-iface-state: 'managed')";

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
			entry("usb 1-2: USB disconnect, device number 8", {
				_TRANSPORT: "kernel",
				_HOSTNAME: "private-hostname",
				_BOOT_ID: "private-boot-a",
				__REALTIME_TIMESTAMP: "1731528245123400",
			}) +
				"\n" +
				entry("usb 1-2: reset high-speed USB device number 3 using xhci-hcd", {
					_TRANSPORT: "kernel",
					_BOOT_ID: "private-boot-b",
				}),
		);
		// Counted back from the newest boot: -1 is the boot before it.
		expect(output).toContain("[boot -1] ");
		expect(output).toContain("[boot 0] ");
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
				entry("usb 1-2: USB disconnect, device number 8", {
					_TRANSPORT: "kernel",
				}),
				entry("private-d", { _SYSTEMD_UNIT: "unknown.service" }),
			].join("\n"),
		).split("\n");
		expect(output).toEqual([
			"[REDACTED 3 support log lines]",
			"kernel: usb 1-2: USB disconnect, device number 8",
			"[REDACTED support log line]",
		]);
	});
	test("drains line-max tails per stream across interleaved diagnostics", () => {
		const output = renderSupportJournal(
			[
				entry("x".repeat(49152), { _LINE_BREAK: "line-max" }),
				entry("usb 1-2: USB disconnect, device number 8", {
					_TRANSPORT: "kernel",
					_STREAM_ID: "b",
				}),
				entry("private-continuation-value"),
				entry(NM_FAILED),
			].join("\n"),
		);
		expect(output).not.toContain("private-continuation-value");
		expect(output).toContain("USB disconnect");
		expect(output).toContain("ip-config -> failed");
	});
	test("admits a unit's records only from its own command, not its children", () => {
		const output = renderSupportJournal(
			[
				entry("DHCPACK(wlan0) 10.42.0.23 3c:a6:2f:11:22:33 example-phone", {
					_COMM: "dnsmasq",
					SYSLOG_IDENTIFIER: "dnsmasq-dhcp",
				}),
				entry(NM_FAILED),
			].join("\n"),
		);
		expect(output).not.toContain("example-phone");
		expect(output).toContain("gsm-registration-denied");
	});
	test("kernel transport text must match a kernel line shape", () => {
		const output = renderSupportJournal(
			[
				entry("srtla: relay passcode private-kmsg-value accepted", {
					_TRANSPORT: "kernel",
					_SYSTEMD_UNIT: undefined,
					_COMM: undefined,
				}),
				entry("usb 1-2: USB disconnect, device number 8", {
					_TRANSPORT: "kernel",
				}),
			].join("\n"),
		);
		expect(output).not.toContain("private-kmsg-value");
		expect(output).toContain("kernel: usb 1-2: USB disconnect");
	});
	test("journalctl matches pair each unit with its command, plus kernel and PID 1", () => {
		expect(SUPPORT_JOURNAL_MATCHES.join(" ")).toBe(
			[
				"_SYSTEMD_UNIT=ceralive.service _COMM=ceralive",
				"_SYSTEMD_UNIT=ModemManager.service _COMM=ModemManager",
				"_SYSTEMD_UNIT=NetworkManager.service _COMM=NetworkManager",
				"_SYSTEMD_UNIT=wpa_supplicant.service _COMM=wpa_supplicant",
				"_SYSTEMD_UNIT=hostapd.service _COMM=hostapd",
				"_TRANSPORT=kernel",
				"_PID=1 _COMM=systemd",
			].join(" + "),
		);
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
				entry('{"msg":"Failed to start stream"}', {
					_SYSTEMD_UNIT: "ceralive.service",
				}),
			].join("\n"),
		);
		expect(output).not.toContain("private-tail-value");
		expect(output).toContain("Failed to start stream");
	});
});
