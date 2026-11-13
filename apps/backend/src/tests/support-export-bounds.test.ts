// Sixth-round checks, using the fifth review's records: error and reason text
// in backend metadata, the ModemManager 1.24 lines that explain a failed
// connection, NetworkManager's real Wi-Fi lines, split records whose first
// piece journalctl prints as null, and smaller numeric and interface gaps.
import { describe, expect, test } from "bun:test";
import { execFileP } from "../helpers/exec.ts";
import { renderSupportJournal } from "../modules/system/support-journal.ts";
import {
	ceralive,
	event,
	exported,
	journal,
	modemManager as mm,
	networkManager,
} from "./support/journal-records.ts";

const nm = (message: string) =>
	networkManager(message.replace(/^(<[a-z]+>\s+)/, "$1[1731528245.1234] "));
const withMeta = (msg: string, meta: Record<string, unknown>) =>
	event({ level: "error", msg, meta });

describe("metadata error and reason text is bounded like msg", () => {
	test.each([
		[
			{
				error: {
					name: "Error",
					message:
						"Command failed: nmcli --terse connection up id Janes iPhone ifname wlan1",
				},
			},
			"Janes iPhone",
		],
		[
			{
				err: {
					name: "SpawnTimeoutError",
					message:
						"Spawn timed out: /usr/bin/ping -c1 -W2 -I wwan0 relay.janedoe-media.net",
				},
			},
			"janedoe-media",
		],
		[
			{
				error: {
					name: "TypeError",
					message:
						"fetch failed for https://hub.janedoe-media.net/v1/devices/register",
				},
			},
			"janedoe-media",
		],
		[{ reason: "activation failed for Janes iPhone hotspot" }, "Janes iPhone"],
		[
			{ reason: "connect timeout to relay.janedoe-media.net port 5000" },
			"janedoe-media",
		],
		[{ reason: "lease for Bobs-Galaxy-S23 not found" }, "Bobs-Galaxy"],
		[
			{ reason: "operator Example Carrier Plan rejected registration" },
			"Example Carrier",
		],
		[
			{
				error: {
					name: "Error",
					message:
						"Command failed: nmcli -w 30 device wifi connect JaneDoeHome ifname wlan0",
				},
			},
			"JaneDoeHome",
		],
		[
			{
				error: {
					name: "RunAbortError",
					message: "Command aborted: nmcli connection up id Janes iPhone",
				},
			},
			"Janes iPhone",
		],
	])("withholds the value in %o", (meta, secret) => {
		const output = exported(withMeta("Gateway election failed", meta));
		expect(output).toContain('"msg":"Gateway election failed"');
		expect(output).not.toContain(secret);
	});

	test("error name and code survive; a code's own error text is kept", () => {
		const output = exported(
			withMeta("Gateway election failed", {
				error: {
					name: "RunTimeoutError",
					code: "ETIMEDOUT",
					message: "free text from somewhere Janes",
				},
			}),
			withMeta("Failed to start stream", {
				err: {
					name: "Error",
					message: "spawn /usr/bin/srtla_send ENOENT",
				},
			}),
			withMeta("Failed to start stream", {
				err: {
					name: "Error",
					message: "connect ECONNREFUSED 203.0.113.7:5000",
				},
			}),
			withMeta("Failed to start stream", { reason: "no_route" }),
		);
		expect(output).toContain(
			'"error":{"name":"RunTimeoutError","code":"ETIMEDOUT","message":"[value]"}',
		);
		expect(output).toContain('"message":"spawn /usr/bin/srtla_send ENOENT"');
		expect(output).toContain('"message":"connect ECONNREFUSED [value]"');
		expect(output).toContain('"reason":"no_route"');
		expect(output).not.toContain("Janes");
		expect(output).not.toContain("203.0.113.7");
	});

	test("an error text the code throws keeps its fixed part", () => {
		const output = exported(
			withMeta("Failed to start stream", {
				err: { name: "Error", message: "binary not allowlisted: janes-tool" },
			}),
		);
		expect(output).toContain('"message":"binary not allowlisted: [value]"');
		expect(output).not.toContain("janes-tool");
	});

	test("execFileP's failure message carries no secret argv value", async () => {
		const failure = await execFileP("false", ["--password", "hunter2hunter2"], {
			timeout: 5000,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toStartWith("Command failed: false");
		expect((failure as Error).message).not.toContain("hunter2hunter2");
	});
});

describe("ModemManager 1.24 lines that explain a failed connection", () => {
	test.each([
		[
			"<wrn> [modem0] modem is locked with 'sim-pin'",
			"modem is locked with 'sim-pin'",
		],
		[
			"<wrn> [modem0] failed sending SIM PIN: SIM PIN required",
			"failed sending SIM PIN: SIM PIN required",
		],
		[
			"<wrn> [modem0] failed enabling modem: Couldn't check unlock status: SIM PIN required",
			"failed enabling modem: Couldn't check unlock status: SIM PIN required",
		],
		[
			"<wrn> [modem0] registration in network failed: Network timeout",
			"registration in network failed: Network timeout",
		],
		[
			"<wrn> [modem0] packet service attach in 3GPP network failed: Operation not allowed",
			"packet service attach in 3GPP network failed: Operation not allowed",
		],
		[
			"<wrn> [modem0] failed waiting for enabled state: locked",
			"failed waiting for enabled state: locked",
		],
		[
			"<msg> [modem0/bearer1] call end reason (14): generic-unspecified",
			"call end reason (14): generic-unspecified",
		],
		[
			"<msg> [modem0/bearer1]   call end reason (14): generic-unspecified",
			"call end reason (14): generic-unspecified",
		],
		[
			"<msg> [modem0/bearer1] verbose call end reason (6,33): [3gpp] option-unsubscribed",
			"verbose call end reason (6,33): [3gpp] option-unsubscribed",
		],
		[
			"<msg> [modem0/bearer1] couldn't start IPv4 network: QMI protocol error (14): 'CallFailed'",
			"couldn't start IPv4 network: QMI protocol error (14): 'CallFailed'",
		],
		[
			"<msg> [modem0/sim0] received critical sim error: SIM might be permanently blocked, reprobing...",
			"received critical sim error",
		],
	])("keeps %s", (line, evidence) => {
		expect(exported(mm(line))).toContain(evidence);
	});

	test("reasons outside ModemManager's phrases still become [reason]", () => {
		const output = exported(
			mm("<wrn> [modem0] failed sending SIM PIN: card of Jane Doe"),
			mm(
				"<msg> [modem0/bearer1] verbose call end reason (6,33): [3gpp] Jane Doe Mobile",
			),
		);
		expect(output).not.toContain("Jane Doe");
		expect(output).toContain("failed sending SIM PIN: [reason]");
	});

	test.each([
		[
			"<warn>  modem-broadband[cdc-wdm0]: failed to connect 'Example Carrier Plan': APN not found: Missing or unknown APN",
			"failed to connect '[name]': APN not found: Missing or unknown APN",
		],
		[
			'<warn>  modem["cdc-wdm0"]: cannot enable/disable modem: locked',
			"cannot enable/disable modem: locked",
		],
	])("keeps NetworkManager's %s", (line, evidence) => {
		const output = exported(nm(line));
		expect(output).toContain(evidence);
		expect(output).not.toContain("Example Carrier");
	});
});

describe("NetworkManager's real Wi-Fi lines", () => {
	test.each([
		[
			'<info>  device (wlan0): Activation: (wifi) Stage 2 of 5 (Device Configure) successful. Connected to wireless network "ExampleHomeNet"',
			'successful. Connected to wireless network "[name]"',
		],
		[
			'<info>  device (wlan0): Activation: (wifi) Stage 2 of 5 (Device Configure) successful. Connected to wireless network "ExampleHomeNet" (hidden)',
			'Connected to wireless network "[name]" (hidden)',
		],
		[
			'<info>  device (wlan1): Activation: (wifi) Stage 2 of 5 (Device Configure) successful. Started Wi-Fi Hotspot "ExampleHomeNet"',
			'Started Wi-Fi Hotspot "[name]"',
		],
		["<warn>  device (eth0): link timed out.", "link timed out."],
		[
			"<info>  dhcp4 (wlan0): state changed new lease, address=198.51.100.20, acd pending",
			"state changed new lease, address=[address], acd pending",
		],
	])("keeps %s", (line, evidence) => {
		const output = exported(nm(line));
		expect(output).toContain(evidence);
		expect(output).not.toContain("ExampleHomeNet");
		expect(output).not.toContain("198.51.100.20");
	});
});

describe("split records journalctl prints as null", () => {
	test("the continuation after a null first piece is withheld", () => {
		const first = {
			...ceralive("x"),
			_STREAM_ID: "s1",
			MESSAGE: null,
			_LINE_BREAK: "line-max",
		};
		const rest = {
			...ceralive("streamloop: srtla_send exited (code=1, signal=null)"),
			_STREAM_ID: "s1",
		};
		const output = renderSupportJournal(journal(first, rest));
		expect(output).not.toContain("srtla_send exited");
		expect(output).toBe("[REDACTED 2 support log lines]");
	});
});

describe("smaller numeric and interface gaps", () => {
	test.each([
		"IMEI 35 209900 176148 1 rejected",
		"id 35:209900:176148:1 rejected",
	])("withholds digits joined by %s", (message) => {
		const output = exported(
			withMeta("Failed to start stream", { err: { name: "Error", message } }),
		);
		expect(output).not.toContain("176148");
	});

	test("metadata ifname follows the interface-name rule", () => {
		const output = exported(
			withMeta("Failed to start stream", { ifname: "wlan-janes-phone" }),
			withMeta("Failed to start stream", { ifname: "wwan0" }),
		);
		expect(output).not.toContain("janes");
		expect(output).toContain('"ifname":"wwan0"');
	});
});
