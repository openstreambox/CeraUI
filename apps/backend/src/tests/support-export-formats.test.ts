// Fifth-round checks: daemon formats as Debian trixie writes them, backend
// messages bounded to the code's own texts, a closed modem error vocabulary,
// start-failure metadata, hotspot events from wpa_supplicant and boot labels.
import { describe, expect, test } from "bun:test";
import { renderSupportJournalWithCounts } from "../modules/system/support-journal.ts";
import {
	event,
	exported,
	type JournalRecord,
	journal,
	modemManager as mm,
	networkManager,
	wpaSupplicant as wpa,
} from "./support/journal-records.ts";

const nm = (message: string) =>
	networkManager(message.replace(/^(<[a-z]+>\s+)/, "$1[1731528245.1234] "));
const error = (msg: string, meta?: Record<string, unknown>) =>
	event({ level: "error", msg, ...(meta ? { meta } : {}) });

describe("ModemManager 1.24 and NetworkManager 1.52 formats", () => {
	test.each([
		[
			"<inf> [modem0] access technology changed (umts -> lte)",
			"access technology changed (umts -> lte)",
		],
		[
			"<msg> [modem0] state changed (registered -> connecting)",
			"<msg> [modem0] state changed (registered -> connecting)",
		],
		[
			"<msg> [modem0] 3GPP registration state changed (searching -> denied)",
			"(searching -> denied)",
		],
		["<msg> [modem0] power state updated: on", "power state updated: on"],
		[
			"<msg> [modem0] simple connect state (8/10): all done",
			"simple connect state (8/10): all done",
		],
		[
			"<wrn> [modem0/bearer1] connection attempt #1 failed: Missing or unknown APN",
			"connection attempt #1 failed: Missing or unknown APN",
		],
		[
			"<inf> [modem0] consolidated registration state: cs 'idle', ps 'denied', eps 'denied', 5gs 'unknown' --> 'denied'",
			"eps 'denied', 5gs 'unknown' --> 'denied'",
		],
		[
			"<msg> [device /sys/devices/platform/usb/1-1] creating modem with plugin 'quectel' and '5' ports (2c7c:0800)",
			"creating modem with plugin 'quectel' and '5' ports (2c7c:0800)",
		],
		["<inf> [modem0] set power state 'low'", "set power state 'low'"],
	])("keeps %s", (line, evidence) => {
		expect(exported(mm(line))).toContain(evidence);
	});

	test("a network rejection keeps its cause and withholds the operator", () => {
		const output = exported(
			mm(
				"<wrn> [modem0] Network rejection received: reason 'plmn-not-allowed' (11), operator id '26201', operator name 'Jane Doe Mobile', access technology 'lte'",
			),
		);
		expect(output).toContain(
			"Network rejection received: reason 'plmn-not-allowed' (11), operator id '[id]', operator name '[name]', access technology 'lte'",
		);
		expect(output).not.toContain("26201");
		expect(output).not.toContain("Jane Doe");
	});

	test.each([
		[
			"<info>  device (cdc-wdm0): state change: prepare -> failed (reason 'gsm-apn-failed', managed-type: 'full')",
			"state change: prepare -> failed (reason 'gsm-apn-failed', managed-type: 'full')",
		],
		[
			"<info>  device (wlan0): state change: unavailable -> disconnected (reason 'supplicant-available', managed-type: 'full', missing firmware)",
			"missing firmware",
		],
		[
			'<info>  device (wlan0): Activation: (wifi) Stage 2 of 5 (Device Configure) successful. Connected to wireless network "ExampleHomeNet"',
			'Stage 2 of 5 (Device Configure) successful. Connected to wireless network "[name]"',
		],
		[
			"<warn>  device (wlan0): Activation: (wifi) association took too long, failing activation",
			"association took too long, failing activation",
		],
		[
			"<info>  device (wwan0): carrier: link connected",
			"carrier: link connected",
		],
	])("keeps %s", (line, evidence) => {
		const output = exported(nm(line));
		expect(output).toContain(evidence);
		expect(output).not.toContain("ExampleHomeNet");
	});
});

describe("backend messages are bounded to the code's own texts", () => {
	test.each([
		[
			"nmConnect err: nmcli exited with code 10: Error: No network with SSID 'Bobs Home' found.",
			"Bobs Home",
		],
		["Command timed out: nmcli -t connection up id Bobs iPhone", "Bobs iPhone"],
		["Failed to connect to relay as bob@example.com", "bob@example.com"],
		[
			"remote error: getaddrinfo ENOTFOUND johns-relay.example.net",
			"johns-relay",
		],
		[
			"mmcliParseSep: error parsing line modem.3gpp.operator-name : Jane Doe Mobile",
			"Jane Doe",
		],
		["rec 351234, 567890, 123", "567890"],
	])("withholds the value in %s", (msg, secret) => {
		expect(exported(error(msg))).not.toContain(secret);
	});

	test("a message from the code keeps its fixed text and bounded values", () => {
		expect(
			exported(error("nmConnect err: nmcli exited with code 10: Error: x")),
		).toContain('"msg":"nmConnect err: [value]"');
		expect(
			exported(error("Failed to register modem 3: Jane Doe Mobile")),
		).toContain('"msg":"Failed to register modem 3: [value]"');
		expect(exported(error("Failed to start stream"))).toContain(
			'"msg":"Failed to start stream"',
		);
	});

	test("a message the code does not write is withheld", () => {
		expect(exported(error("totally unknown free text here"))).toBe(
			"[REDACTED support log line]",
		);
	});

	test("winston's appended error text becomes [value]", () => {
		expect(
			exported(error("stream start failed no uplink available via Bobs")),
		).toContain('"msg":"stream start failed [value]"');
	});

	test.each([
		"Command timed out: nmcli -t connection up id Bobs iPhone",
		"nmcli exited with code 10: Error: No network with SSID 'Bobs Home' found.",
		"getaddrinfo ENOTFOUND johns-relay.example.net",
		"login as bob@example.com refused",
		"id 35123456_789012_3",
		"call 0151, 2345, 6789",
	])("error detail %s is withheld", (message) => {
		const output = exported(
			error("Failed to start stream", { err: { name: "Error", message } }),
		);
		expect(output).toContain("Failed to start stream");
		expect(output).not.toContain(message);
	});
});

describe("modem error text uses a closed vocabulary", () => {
	test.each([
		[
			"<warn>  [modem0] couldn't connect bearer: credentials (bob, Hunter2Secret)",
			"Hunter2Secret",
		],
		[
			"<warn>  [modem0] couldn't connect: auth PAP user-name abc123secret",
			"abc123secret",
		],
		["<warn>  [modem0] couldn't connect: 262 01 1A2B 3C4D5E6", "3C4D5E6"],
		[
			"<warn>  [modem0] couldn't connect: pci 123 earfcn 6300 enb 123456",
			"123456",
		],
		["<warn>  [modem0] couldn't connect: rec 351234, 567890, 123", "567890"],
		["<wrn> [modem0] couldn't load operator name: Jane Doe Mobile", "Jane Doe"],
	])("replaces free reason text in %s", (line, secret) => {
		const output = exported(mm(line));
		expect(output).not.toContain(secret);
		expect(output).toContain(": [reason]");
	});

	test("ModemManager's own phrases survive", () => {
		const output = exported(
			mm(
				"<warn>  [modem0] modem couldn't be initialized: Couldn't check unlock status: SIM PIN required",
			),
			nm(
				"<warn>  modem-broadband[cdc-wdm0]: failed to connect modem: Missing or unknown APN",
			),
			mm(
				"<wrn> [modem0] couldn't connect: QMI protocol error (14): 'CallFailed'",
			),
		);
		for (const kept of [
			"Couldn't check unlock status: SIM PIN required",
			"failed to connect modem: Missing or unknown APN",
			"couldn't connect: QMI protocol error (14): 'CallFailed'",
		])
			expect(output).toContain(kept);
	});

	test("an unknown couldn't-action is withheld", () => {
		expect(exported(mm("<warn>  [modem0] couldn't reach bobs home"))).toBe(
			"[REDACTED support log line]",
		);
	});
});

describe("start-failure metadata", () => {
	test("keeps class, phase, cause and retry state as bounded values", () => {
		const output = exported(
			error("stream start failed", {
				attemptId: "attempt-7f3a9c2e",
				phase: "connect",
				class: "capture_source_unavailable",
				captureCause: "device_busy",
				code: "device_busy",
				retry: {
					state: "exhausted",
					attempt: 3,
					maxAttempts: 3,
					suppressed: false,
					private: "Bobs",
				},
			}),
			error("stream start retry scheduled", {
				phase: "spawn-sender",
				class: "engine_unavailable",
				retry: {
					state: "scheduled",
					attempt: 1,
					nextAttempt: 2,
					maxAttempts: 3,
					delayMs: 2000,
					suppressed: false,
				},
			}),
		);
		for (const kept of [
			'"phase":"connect"',
			'"class":"capture_source_unavailable"',
			'"captureCause":"device_busy"',
			'"retry":{"state":"exhausted","attempt":3,"maxAttempts":3,"suppressed":false}',
			'"phase":"spawn-sender"',
			'"retry":{"state":"scheduled","attempt":1,"nextAttempt":2,"maxAttempts":3,"delayMs":2000,"suppressed":false}',
		])
			expect(output).toContain(kept);
		expect(output).not.toContain("attempt-7f3a9c2e");
		expect(output).not.toContain("Bobs");
	});

	test("unknown classes and phases are dropped", () => {
		const output = exported(
			error("stream start failed", {
				class: "bobs_class",
				phase: "bobs-phase",
				retry: { state: "bobs", attempt: 99999999 },
			}),
		);
		expect(output).not.toContain("bobs");
		expect(output).not.toContain("99999999");
	});
});

describe("hotspot events from wpa_supplicant", () => {
	test.each([
		["wlan1: AP-ENABLED ", "wlan1: AP-ENABLED"],
		["wlan1: AP-STA-CONNECTED 3c:a6:2f:11:22:33", "AP-STA-CONNECTED [address]"],
		[
			"wlan1: AP-STA-CONNECTED 3c:a6:2f:11:22:33 keyid=Bobs-phone",
			"AP-STA-CONNECTED [address]",
		],
		[
			"wlan1: AP-STA-DISCONNECTED 3c:a6:2f:11:22:33",
			"AP-STA-DISCONNECTED [address]",
		],
		[
			"wlan1: interface state COUNTRY_UPDATE->ENABLED",
			"COUNTRY_UPDATE->ENABLED",
		],
	])("keeps %s", (line, evidence) => {
		const output = exported(wpa(line));
		expect(output).toContain(evidence);
		expect(output).not.toContain("3c:a6");
		expect(output).not.toContain("Bobs");
	});
});

describe("free tails and interface names", () => {
	test.each([
		"<info>  device (wlan0): Activation: Stage 1 of 5 (Device Prepare) started for john doe home",
		"<info>  device (wlan0): carrier: link connected for bob",
		"<warn>  device (wlan0): Activation: (wifi) association took too long for bobs home",
		"<info>  device (Bobs_iPhone): state change: config -> failed (reason 'no-secrets', managed-type: 'full')",
	])("withholds %s", (line) => {
		expect(exported(nm(line))).toBe("[REDACTED support log line]");
	});

	test.each([
		[
			"<info>  device (wlx3ca62f112233): carrier: link connected",
			"wlx[address]",
		],
		["<info>  device (enp1s0): carrier: link connected", "(enp1s0)"],
		["<info>  device (wwan0mbim0): carrier: link connected", "(wwan0mbim0)"],
		[
			"<info>  device (p2p-dev-wlan0): carrier: link connected",
			"(p2p-dev-wlan0)",
		],
	])("keeps kernel interface name in %s", (line, evidence) => {
		expect(exported(nm(line))).toContain(evidence);
	});
});

describe("boot labels count back from the current boot", () => {
	const at = (boot: string, message: string): JournalRecord => ({
		...mm(message),
		_BOOT_ID: boot,
	});
	const records = journal(
		at("aaaa", "<msg> [modem0] state changed (enabled -> searching)"),
		at("bbbb", "<msg> [modem0] state changed (searching -> registered)"),
		at("cccc", "<msg> [modem0] state changed (registered -> connected)"),
	);

	test("without a known current boot the newest boot is 0", () => {
		const lines = renderSupportJournalWithCounts(records).text.split("\n");
		expect(lines[0]).toStartWith("[boot -2] ");
		expect(lines[1]).toStartWith("[boot -1] ");
		expect(lines[2]).toStartWith("[boot 0] ");
	});

	test("the current boot is 0", () => {
		const lines = renderSupportJournalWithCounts(records, {
			currentBootId: "cccc",
		}).text.split("\n");
		expect(lines[0]).toStartWith("[boot -2] ");
		expect(lines[2]).toStartWith("[boot 0] ");
	});

	test("a current boot absent from the window leaves the newest at -1", () => {
		const lines = renderSupportJournalWithCounts(records, {
			currentBootId: "dddd",
		}).text.split("\n");
		expect(lines[2]).toStartWith("[boot -1] ");
		expect(lines[0]).toStartWith("[boot -3] ");
	});
});
