import { expect, test } from "bun:test";
import { collectDaemonVocabulary } from "../../scripts/support-daemon-vocabulary.ts";
import { redactArgv } from "../helpers/exec.ts";
import { carrierSupportRows } from "../modules/system/support-export.ts";
import { renderSupportJournalWithCounts } from "../modules/system/support-journal.ts";
import {
	boundedModemReason,
	isInterfaceName,
	matchLineShape,
} from "../modules/system/support-line-shapes.ts";
import { event, exported } from "./support/journal-records.ts";

test("timings are integers and record timestamps are withheld", () => {
	const text = exported(
		event({
			ts: "2026-11-13T352099001761481Z",
			msg: "Failed to start stream",
			meta: {
				latency_ms: 12.123456789,
				elapsed_ms: 13.123456789,
				wait_ms: 14.123456789,
			},
		}),
	);
	expect(text).not.toContain("123456789");
	expect(text).not.toContain("352099001761481");
	expect(text).toContain('"latency_ms":12');
});
test("APN is user text", () => {
	expect(carrierSupportRows([{ config: { apn: "private.example" } }])).toEqual([
		{ modem: 1, apn: "[custom APN]" },
	]);
});
test("normalized QMI errors retain typed detail", () => {
	expect(
		boundedModemReason(
			"QMI protocol error: QMI protocol error (14): 'CallFailed'",
		),
	).toBe("QMI protocol error: QMI protocol error (14): 'CallFailed'");
	expect(
		boundedModemReason(
			"Unhandled QMI protocol error (14): QMI protocol error (14): 'CallFailed'",
		),
	).toContain("Unhandled QMI protocol error (14)");
});
test("MBIM errors are keyed by code", () => {
	expect(
		boundedModemReason("MBIM status error: MBIM status error (2): 'Failure'"),
	).toBe("MBIM status error: MBIM status error (2): 'Failure'");
	expect(
		boundedModemReason(
			"Unhandled MBIM status error (6): MBIM status error (6): 'private'",
		),
	).toBe("Unhandled MBIM status error (6): MBIM status error (6): [reason]");
});
test("association endings retain reason without the AP address", () => {
	for (const text of [
		"wlan0: deauthenticated from aa:bb:cc:dd:ee:ff (Reason: 7=CLASS3_FRAME_FROM_NONASSOC_STA)",
		"wlan0: disassociated from aa:bb:cc:dd:ee:ff (Reason: 1=UNSPECIFIED)",
		"wlan0: Connection to AP aa:bb:cc:dd:ee:ff lost",
	]) {
		const out = matchLineShape("kernel", text);
		expect(out).toBeDefined();
		expect(out).not.toContain("aa:bb");
	}
	for (const text of ["CTRL-EVENT-BEACON-LOSS", "CTRL-EVENT-NETWORK-NOT-FOUND"])
		expect(matchLineShape("wpa_supplicant", `wlan0: ${text}`)).toContain(text);
});
test("realistic numeric widths", () => {
	expect(
		matchLineShape(
			"kernel",
			"Out of memory: Killed process 1234567890 (bun) tail",
		),
	).toBeUndefined();
	expect(
		matchLineShape(
			"ModemManager",
			"ModemManager (version 1234567890123456) starting in system bus...",
		),
	).toBeUndefined();
});
test("short password option is redacted", () => {
	expect(redactArgv(["-p", "private-secret"])).not.toContain("private-secret");
});
test("unknown older boot has negative ordinal", () => {
	const text = renderSupportJournalWithCounts(
		JSON.stringify({
			...event({ msg: "Failed to start stream" }),
			_BOOT_ID: "old",
		}),
		{ bootList: ["now"], currentBootId: "now" },
	).text;
	expect(text).toContain("[boot -1]");
	expect(text).not.toContain("[boot 1]");
});
test("missing vocabulary sources fail closed", () => {
	expect(() =>
		collectDaemonVocabulary({
			modemManager: [],
			libqmi: [],
			networkManager: [],
			wpa: [],
		}),
	).toThrow();
});

test("signal fields cannot encode six digit numbers", () => {
	expect(
		matchLineShape(
			"wpa_supplicant",
			"wlan0: CTRL-EVENT-SIGNAL-CHANGE above=1 signal=123456 noise=123456 txrate=123456",
		),
	).toBeUndefined();
});

test("normalized MBIM nickname is a closed vocabulary member", () => {
	expect(boundedModemReason("MBIM status error: Failure")).toBe(
		"MBIM status error: Failure",
	);
	expect(boundedModemReason("MBIM protocol error: private-name")).toBe(
		"MBIM protocol error: [reason]",
	);
});

test("multiple unlisted boots retain journal order before listed boots", () => {
	const records = ["oldest", "older", "now"]
		.map((_BOOT_ID) =>
			JSON.stringify({ ...event({ msg: "Failed to start stream" }), _BOOT_ID }),
		)
		.join("\n");
	const text = renderSupportJournalWithCounts(records, {
		bootList: ["now"],
		currentBootId: "now",
	}).text;
	expect(text.indexOf("[boot -2]")).toBeLessThan(text.indexOf("[boot -1]"));
});

test("predictable interface digit budget rejects crafted names", () => {
	expect(isInterfaceName("eno5551o2345")).toBe(false);
});

test("USB bus descriptors cannot carry a long digit run", () => {
	const out = matchLineShape(
		"kernel",
		"qmi_wwan 1-1.2 wwan0: register 'qmi_wwan' at usb-xhci-hcd.0.auto-123456789012345, WWAN/QMI device, aa:bb:cc:dd:ee:ff",
	);
	expect(out).toBeDefined();
	expect(out).not.toContain("123456789012345");
});
