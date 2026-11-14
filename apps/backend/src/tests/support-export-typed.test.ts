// Round seven: the download carries only typed fields. Every identifier the
// sixth review planted is a test here, run through the production renderer,
// next to the typed evidence that must survive the same change.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnums } from "../../scripts/support-daemon-vocabulary.ts";
import {
	collectFrom,
	collectReasonTemplates,
} from "../../scripts/support-log-messages.ts";
import { classifyToolFailure, execFileP, redactArgv } from "../helpers/exec.ts";
import { formatProdEntry } from "../helpers/logger.ts";
import * as runModule from "../helpers/run.ts";
import { getLog } from "../modules/system/logs.ts";
import {
	DAEMON_VOCABULARY,
	QMI_CALL_END_REASONS,
	QMI_PROTOCOL_ERRORS,
	QMI_VERBOSE_CALL_END_REASONS,
	WLAN_REASONS,
} from "../modules/system/support-daemon-vocabulary.generated.ts";
import { renderSupportJournalWithCounts } from "../modules/system/support-journal.ts";
import {
	isInterfaceName,
	LINE_SHAPE_SOURCES,
	STRICT_INTERFACE_PATTERN,
} from "../modules/system/support-line-shapes.ts";
import { SUPPORT_REASON_TEMPLATES } from "../modules/system/support-log-messages.generated.ts";
import {
	ceralive,
	event,
	exported,
	journal,
	kernel,
	modemManager,
	networkManager,
	systemd,
} from "./support/journal-records.ts";

const failed = (err: Record<string, unknown>) =>
	event({ level: "error", msg: "Failed to start stream", meta: { err } });
const errorText = (message: string) => failed({ name: "Error", message });

// [label, record, planted value]
const planted: [string, Record<string, unknown>, string][] = [
	// B1: template gaps and metadata interface names.
	[
		"B1 interface-shaped name in a message gap",
		event({ level: "error", msg: "nmConnect err: enp1janedoe" }),
		"janedoe",
	],
	[
		"B1 short number in an error-text gap",
		errorText("binary not allowlisted: 55512345"),
		"55512345",
	],
	[
		"B1 decimal cell identity in a message gap",
		event({ level: "error", msg: "nmConnect err: 123456" }),
		"123456",
	],
	[
		"B1 decimal cell identity in an error-text gap",
		errorText("binary not allowlisted: 123456"),
		"123456",
	],
	[
		"B1 coordinate component in a message gap",
		event({ level: "error", msg: "nmConnect err: 52.123456" }),
		"52.123456",
	],
	[
		"B1 coordinate component in an error-text gap",
		errorText("binary not allowlisted: 52.123456"),
		"52.123456",
	],
	[
		"B1 interface-shaped name in metadata ifname",
		event({
			level: "error",
			msg: "Failed to start stream",
			meta: { ifname: "enp1janedoe" },
		}),
		"janedoe",
	],
	// B2: system-call errors.
	["B2 word as a system call", errorText("janedoe ENOENT"), "janedoe"],
	[
		"B2 invented error code",
		errorText("relayaccount EPRIVATE"),
		"relayaccount",
	],
	["B2 invented error code itself", errorText("connect EPRIVATE"), "EPRIVATE"],
	// B3: daemon shape fields.
	[
		"B3 call-end nickname",
		modemManager("<msg> [modem0/bearer1] call end reason (14): jane-home-wifi"),
		"jane-home-wifi",
	],
	[
		"B3 verbose call-end type",
		modemManager(
			"<msg> [modem0/bearer1] verbose call end reason (6,33): [jane-home] jane-relay-account",
		),
		"jane-home",
	],
	[
		"B3 verbose call-end reason",
		modemManager(
			"<msg> [modem0/bearer1] verbose call end reason (6,33): [3gpp] jane-relay-account",
		),
		"jane-relay-account",
	],
	[
		"B3 nickname after Call failed",
		modemManager(
			"<wrn> [modem0] failed enabling modem: Call failed: jane-home-wifi",
		),
		"jane-home-wifi",
	],
	[
		"B3 QMI protocol error nickname",
		modemManager(
			"<wrn> [modem0] failed enabling modem: QMI protocol error (14): 'JaneHomeWifi'",
		),
		"JaneHomeWifi",
	],
	[
		"B3 D-Bus error name",
		modemManager(
			"<wrn> [modem0] failed enabling modem: org.freedesktop.ModemManager1.Error.Jane.HomeWifi",
		),
		"HomeWifi",
	],
	[
		"B3 modem state",
		modemManager("<msg> [modem0] state changed (connected -> JaneDoe)"),
		"JaneDoe",
	],
	[
		"B3 simple connect step",
		modemManager("<msg> [modem0] simple connect state (1/8): jane home wifi"),
		"jane home wifi",
	],
	[
		"B3 access technology",
		modemManager(
			"<msg> [modem0] access technology changed (lte -> jane home wifi)",
		),
		"jane home wifi",
	],
	[
		"B3 lock name",
		modemManager("<wrn> [modem0] modem is locked with 'jane-home'"),
		"jane-home",
	],
	[
		"B3 network rejection reason",
		modemManager(
			"<wrn> [modem0] Network rejection received: reason 'jane-home' (11), operator id '26201', operator name 'x', access technology 'lte'",
		),
		"jane-home",
	],
	[
		"B3 registration state",
		modemManager(
			"<msg> [modem0] 3GPP registration state changed (home -> janehome)",
		),
		"janehome",
	],
	[
		"B3 object path",
		modemManager("<msg> [modem0/janedoe] state changed (enabled -> searching)"),
		"janedoe",
	],
	[
		"MAC-derived port name in a ModemManager object",
		modemManager(
			"<msg> [modem0/wwx3ca62f112233/net] state changed (enabled -> searching)",
		),
		"3ca62f112233",
	],
	[
		"B3 plugin name",
		modemManager(
			"<msg> [device /sys/devices/x] creating modem with plugin 'janedoe' and '4' ports",
		),
		"janedoe",
	],
	[
		"B3 NetworkManager interface",
		networkManager(
			"<info>  [1731528245.1234] device (enp1janedoe): state change: activated -> failed (reason 'JaneDoe', managed-type: 'full')",
		),
		"janedoe",
	],
	[
		"B3 NetworkManager reason",
		networkManager(
			"<info>  [1731528245.1234] device (wlan0): state change: activated -> failed (reason 'JaneDoe', managed-type: 'full')",
		),
		"JaneDoe",
	],
	[
		"B3 NetworkManager device state",
		networkManager(
			"<info>  [1731528245.1234] device (wlan0): state change: activated -> janedoe (reason 'none', managed-type: 'full')",
		),
		"janedoe",
	],
	[
		"B3 NetworkManager supplicant state",
		networkManager(
			"<info>  [1731528245.1234] device (wlan0): supplicant interface state: completed -> janedoe",
		),
		"janedoe",
	],
	[
		"B3 NetworkManager version",
		networkManager(
			"<info>  [1731528245.1234] NetworkManager (version 1.52.1-janedoe) is starting...",
		),
		"janedoe",
	],
	// B4: kernel and systemd names.
	["B4 USB product", kernel("usb 1-1: Product: Jane Home Wifi"), "Jane Home"],
	[
		"B4 USB manufacturer",
		kernel("usb 1-1: Manufacturer: Jane Home Wifi"),
		"Jane Home",
	],
	[
		"B4 OOM process name",
		kernel("Out of memory: Killed process 123 (janehost) blah"),
		"janehost",
	],
	[
		"B4 OOM invoker",
		kernel("janehost invoked oom-killer: gfp_mask=0x140cca, order=0"),
		"janehost",
	],
	[
		"B4 templated unit instance",
		systemd(
			"wg-quick@janehome.service: Main process exited, code=exited, status=1/FAILURE",
		),
		"janehome",
	],
	[
		"B4 unit outside the admitted set",
		systemd("Started janehome-backup.service - Jane's backup."),
		"janehome",
	],
	[
		"B4 systemd result word",
		systemd("ceralive.service: Failed with result 'JaneHomeWifi'."),
		"JaneHomeWifi",
	],
	[
		"B4 systemd killed process",
		systemd(
			"ceralive.service: Killing process 123 (janehost) with signal SIGKILL.",
		),
		"janehost",
	],
	[
		"B4 kernel release",
		kernel("Linux version 6.12-janehome secret"),
		"janehome",
	],
	[
		"B4 deauthentication reason name",
		kernel(
			"wlan0: deauthenticating from 3c:a6:2f:11:22:33 by local choice (Reason: 3=JANEHOME)",
		),
		"JANEHOME",
	],
	[
		"B4 link speed text",
		kernel("eth0: Link is Up - jane home wifi"),
		"jane home",
	],
	["B4 USB hub path", kernel("usb janedoe: over-current condition"), "janedoe"],
	[
		"B4 sender name in a streamloop line",
		ceralive("streamloop: janedoe exited (code=1, signal=null)"),
		"janedoe",
	],
	[
		"B4 RPC procedure name",
		event({ level: "debug", msg: "RPC janeDoe.home ok" }),
		"janeDoe",
	],
];

describe("planted identifiers never reach the download", () => {
	test.each(planted)("%s", (_label, record, secret) => {
		expect(exported(record)).not.toContain(secret);
	});
	test("all planted records together", () => {
		const output = exported(...planted.map(([, record]) => record));
		for (const [, , secret] of planted) expect(output).not.toContain(secret);
	});
});

// [record, evidence that must survive]
const typed: [Record<string, unknown>, string][] = [
	[
		modemManager(
			"<msg> [modem0/bearer1] call end reason (1): generic-unspecified",
		),
		"call end reason (1): generic-unspecified",
	],
	[
		modemManager("<msg> [modem0/bearer1] call end reason (1): jane-home-wifi"),
		"call end reason (1): [reason]",
	],
	[
		modemManager(
			"<msg> [modem0/bearer1] verbose call end reason (6,33): [3gpp] option-unsubscribed",
		),
		"verbose call end reason (6,33): [3gpp] option-unsubscribed",
	],
	[
		modemManager(
			"<msg> [modem0/bearer1] verbose call end reason (6,33): [jane-home] jane-relay-account",
		),
		"verbose call end reason (6,33): [reason]",
	],
	[
		modemManager(
			"<wrn> [modem0] failed enabling modem: Call failed: generic-unspecified",
		),
		"failed enabling modem: Call failed: generic-unspecified",
	],
	[
		modemManager(
			"<wrn> [modem0] failed enabling modem: QMI protocol error (14): 'CallFailed'",
		),
		"QMI protocol error (14): 'CallFailed'",
	],
	[
		modemManager(
			"<wrn> [modem0] failed enabling modem: QMI protocol error (14): 'JaneHomeWifi'",
		),
		"QMI protocol error (14): [reason]",
	],
	[
		modemManager(
			"<wrn> [modem0] failed enabling modem: org.freedesktop.ModemManager1.Error.MobileEquipment.SimPin",
		),
		"org.freedesktop.ModemManager1.Error.MobileEquipment.SimPin",
	],
	[
		modemManager("<msg> [modem0] state changed (connected -> JaneDoe)"),
		"state changed (connected -> [state])",
	],
	[
		modemManager("<msg> [modem0] simple connect state (4/10): enable"),
		"simple connect state (4/10): enable",
	],
	[
		modemManager("<msg> [modem0] simple connect state (1/8): jane home wifi"),
		"simple connect state (1/8): [step]",
	],
	[
		modemManager("<msg> [modem0] access technology changed (lte -> lte, 5gnr)"),
		"access technology changed (lte -> lte, 5gnr)",
	],
	[
		modemManager("<wrn> [modem0] modem is locked with 'sim-pin'"),
		"modem is locked with 'sim-pin'",
	],
	[
		modemManager(
			"<msg> [modem0/ttyUSB2/at] port timed out 3 consecutive times",
		),
		"[modem0/ttyUSB2/at] port timed out 3 consecutive times",
	],
	[
		modemManager(
			"<msg> [device /sys/devices/x] creating modem with plugin 'quectel' and '4' ports",
		),
		"creating modem with plugin 'quectel'",
	],
	[
		networkManager(
			"<info>  [1731528245.1234] device (enp1janedoe): state change: activated -> failed (reason 'JaneDoe', managed-type: 'full')",
		),
		"device ([interface]): state change: activated -> failed (reason '[reason]', managed-type: 'full')",
	],
	[
		networkManager(
			"<info>  [1731528245.1234] device (enp1s0u1u2): state change: activated -> failed (reason 'carrier-changed', managed-type: 'full')",
		),
		"device (enp1s0u1u2): state change: activated -> failed (reason 'carrier-changed', managed-type: 'full')",
	],
	[
		networkManager(
			"<info>  [1731528245.1234] device (wlan0): supplicant interface state: 4way_handshake -> disconnected",
		),
		"supplicant interface state: 4way_handshake -> disconnected",
	],
	[kernel("usb 1-1: Product: Jane Home Wifi"), "usb 1-1: Product: [name]"],
	[
		kernel("Out of memory: Killed process 123 (janehost) blah"),
		"Out of memory: Killed process 123 ([process])",
	],
	[
		kernel("Out of memory: Killed process 123 (srtla_send) total-vm:1kB"),
		"Out of memory: Killed process 123 (srtla_send)",
	],
	[
		kernel("Linux version 6.12-janehome secret"),
		"Linux version 6.12-[release]",
	],
	[
		kernel("Linux version 6.1.0-28-arm64 (debian-kernel@lists.debian.org)"),
		"Linux version 6.1.0-28-[release]",
	],
	[
		kernel(
			"wlan0: deauthenticating from 3c:a6:2f:11:22:33 by local choice (Reason: 3=DEAUTH_LEAVING)",
		),
		"(Reason: 3=DEAUTH_LEAVING)",
	],
	[
		kernel("eth0: Link is Up - 1Gbps/Full - flow control rx/tx"),
		"eth0: Link is Up - 1Gbps/Full - flow control rx/tx",
	],
	[
		systemd(
			"wg-quick@janehome.service: Main process exited, code=exited, status=1/FAILURE",
		),
		"[unit]: Main process exited, code=exited, status=1/FAILURE",
	],
	[
		systemd("ceralive.service: Failed with result 'JaneHomeWifi'."),
		"ceralive.service: Failed with result '[result]'.",
	],
	[
		systemd("ceralive.service: Failed with result 'exit-code'."),
		"ceralive.service: Failed with result 'exit-code'.",
	],
	[
		systemd("Started ModemManager.service - Modem Manager."),
		"Started ModemManager.service",
	],
	[
		systemd(
			"ceralive.service: Killing process 123 (srtla_send) with signal SIGKILL.",
		),
		"ceralive.service: Killing process 123 (srtla_send) with signal SIGKILL.",
	],
	[
		systemd(
			"ceralive.service: Scheduled restart job, restart counter is at 3.",
		),
		"ceralive.service: Scheduled restart job, restart counter is at 3.",
	],
	[
		ceralive("streamloop: janedoe exited (code=1, signal=null)"),
		"streamloop: [process] exited (code=1, signal=null)",
	],
	[
		event({ level: "error", msg: "nmConnect err: enp1janedoe" }),
		'"msg":"nmConnect err: [value]"',
	],
	[
		event({
			level: "error",
			msg: "Failed to start stream",
			meta: { ifname: "wlan0" },
		}),
		'"ifname":"wlan0"',
	],
	[errorText("janedoe ENOENT"), '"message":"[value]"'],
	[
		errorText("connect ECONNREFUSED 203.0.113.7:5000"),
		'"message":"connect ECONNREFUSED [value]"',
	],
	[
		errorText("spawn /usr/bin/srtla_send ENOENT"),
		'"message":"spawn /usr/bin/srtla_send ENOENT"',
	],
	[
		errorText("spawn /home/jane/tool ENOENT"),
		'"message":"spawn [value] ENOENT"',
	],
];

describe("typed values survive", () => {
	test.each(typed)("%#: %p", (record, evidence) => {
		expect(exported(record)).toContain(evidence);
	});
});

describe("tool errors keep [value] with a typed class", () => {
	const cls = (err: Record<string, unknown>) =>
		/"class":"([a-z-]+)"/.exec(exported(failed(err)))?.[1];
	test("classes derived from the error's name and code", () => {
		expect(
			cls({ name: "RunTimeoutError", message: "Command timed out: nmcli x" }),
		).toBe("timeout");
		expect(
			cls({ name: "Error", code: "ENOENT", message: "spawn /x/tool ENOENT" }),
		).toBe("missing-executable");
		expect(cls({ name: "Error", code: "EACCES", message: "x" })).toBe(
			"permission",
		);
		expect(cls({ name: "Error", code: "ENETUNREACH", message: "x" })).toBe(
			"network-unreachable",
		);
	});
	test("a class set by the caller is kept only from the closed list", () => {
		expect(
			cls({
				name: "Error",
				failureClass: "rejected-configuration",
				message: "Command failed: nmcli con up id Jane",
			}),
		).toBe("rejected-configuration");
		expect(
			cls({ name: "Error", failureClass: "janedoe", message: "x" }),
		).toBeUndefined();
		expect(
			exported(
				failed({
					name: "Error",
					failureClass: "rejected-configuration",
					message: "Command failed: nmcli con up id Jane",
				}),
			),
		).not.toContain("Jane");
	});
	test("callers classify tool exits", () => {
		expect(classifyToolFailure("nmcli", { code: 2 })).toBe(
			"rejected-configuration",
		);
		expect(classifyToolFailure("nmcli", { code: 10 })).toBe(
			"rejected-configuration",
		);
		expect(classifyToolFailure("nmcli", { code: 3 })).toBe("timeout");
		expect(classifyToolFailure("curl", { code: 6 })).toBe(
			"network-unreachable",
		);
		expect(classifyToolFailure("curl", { code: 28 })).toBe("timeout");
		expect(classifyToolFailure("anything", { code: 126 })).toBe("permission");
		expect(classifyToolFailure("anything", { code: 127 })).toBe(
			"missing-executable",
		);
		expect(classifyToolFailure("anything", { code: 1 })).toBeUndefined();
	});
	test("execFileP attaches the class and the logger keeps it", async () => {
		const missing = await execFileP("/nonexistent/osb-tool").catch((e) => e);
		expect(missing.failureClass).toBe("missing-executable");
		const exit127 = await execFileP("sh", ["-c", "exit 127"]).catch((e) => e);
		expect(exit127.failureClass).toBe("missing-executable");
		const line = formatProdEntry({
			level: "error",
			message: "Failed to start stream",
			err: exit127,
		} as never);
		expect(JSON.parse(line).meta.err.failureClass).toBe("missing-executable");
		expect(JSON.parse(line).meta.err.code).toBe(127);
	});
});

describe("argv masking (S2)", () => {
	test("stream ids, accounts and user options are masked", () => {
		expect(redactArgv(["--streamid", "live-private"])).not.toContain(
			"live-private",
		);
		expect(redactArgv(["--stream-key=live-private"])).not.toContain(
			"live-private",
		);
		expect(redactArgv(["--account", "jane-relay"])).not.toContain("jane-relay");
		expect(redactArgv(["-u", "jane:supersecret"])).not.toContain("jane");
		expect(redactArgv(["--user", "jane:supersecret"])).not.toContain("jane");
		expect(
			redactArgv(["https://jane:supersecret@relay.example/x"]),
		).not.toContain("supersecret");
		expect(redactArgv(["con", "up", "id", "x"])).toBe("con up id x");
	});
	test("execFileP's own message masks them too", async () => {
		const error = await execFileP("false", [
			"--streamid",
			"live-private",
		]).catch((e) => e);
		expect(String(error.message)).not.toContain("live-private");
	});
});

describe("dynamic messages and generator freshness (S1)", () => {
	test("a dynamic message matching a template exports only the template", () => {
		// The real logger serialiser, as a stderr-forwarding call writes it.
		const stderr = "Failed to register modem 7: enp1janedoe";
		const line = formatProdEntry({ level: "error", message: stderr } as never);
		const output = exported(ceralive(line));
		expect(output).not.toContain("janedoe");
		expect(output).not.toContain(" 7:");
	});
	test("reason templates match the source", () => {
		expect([...SUPPORT_REASON_TEMPLATES]).toEqual(collectReasonTemplates());
	}, 60000);
	test("element-access logger calls and new reasons are collected", () => {
		const root = mkdtempSync(join(tmpdir(), "support-collect-"));
		try {
			mkdirSync(join(root, "src"));
			writeFileSync(
				join(root, "src/fixture.ts"),
				[
					"declare const logger: any;",
					"export function a(message: string) { logger['warn'](message); }",
					"export function b() { logger['error']('fixture literal message'); }",
					"export const r = { reason: 'review-new-reason-without-freshness-check' };",
				].join("\n"),
			);
			const collected = collectFrom(root);
			expect(collected.dynamic.join("\n")).toContain("logger['warn']");
			expect(collected.logs).toContainEqual(["fixture literal message"]);
			expect(collected.reasons).toContainEqual([
				"review-new-reason-without-freshness-check",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("boot ordinals count every boot (S3)", () => {
	const at = (boot: string, record: Record<string, unknown>) => ({
		...record,
		_BOOT_ID: boot,
	});
	const records = [
		at(
			"aaaa",
			modemManager("<msg> [modem0] state changed (enabled -> searching)"),
		),
		at("bbbb", modemManager("<msg> unknown line without a shape")),
		at(
			"cccc",
			modemManager("<msg> [modem0] state changed (enabled -> searching)"),
		),
	];
	test("a boot with only withheld records still counts", () => {
		const { text, bootsWithoutShown } = renderSupportJournalWithCounts(
			journal(...records),
			{ currentBootId: "cccc" },
		);
		expect(text).toContain("[boot -2] ");
		expect(text).toContain("[boot 0] ");
		expect(text).not.toContain("[boot -1] ");
		expect(bootsWithoutShown).toEqual([-1]);
	});
	test("journald's boot list labels boots absent from the window", () => {
		const { text, bootsWithoutShown } = renderSupportJournalWithCounts(
			journal(
				records[0] as Record<string, unknown>,
				records[2] as Record<string, unknown>,
			),
			{
				currentBootId: "cccc",
				bootList: ["aaaa", "zzzz", "bbbb", "cccc"],
			},
		);
		expect(text).toContain("[boot -3] ");
		expect(text).toContain("[boot 0] ");
		expect(bootsWithoutShown).toEqual([-2, -1]);
	});
});

describe("typed shapes", () => {
	// Text outside {FIELD} placeholders is copied from the input, so it may
	// only match fixed words, digits, hex digits and whitespace.
	const ALLOWED_CLASSES = new Set([
		"[0-9.]",
		"[0-9:s]",
		"[0-9a-f]",
		"[0-9a-f.]",
		"[01]",
		"[1-5]",
		"[46]",
		"[Oo]",
		"[sz]",
	]);
	test.each(
		Object.entries(LINE_SHAPE_SOURCES).flatMap(([source, shapes]) =>
			shapes.map((shape) => [source, shape] as const),
		),
	)("%s: %s copies no free text", (_source, shape) => {
		const literal = shape
			.replaceAll(STRICT_INTERFACE_PATTERN, "")
			.replace(/\{[A-Z][A-Z0-9]*\}/g, "")
			.replace(/\\[\\[\]().*+?{}|/^$!-]/g, "");
		for (const cls of literal.match(/\[[^\]]*\]/g) ?? [])
			expect(ALLOWED_CLASSES).toContain(cls);
		// No wildcard or negated class outside the allowed classes.
		expect(literal.replace(/\[[^\]]*\]/g, "")).not.toMatch(/\\[SwWD]|\.|\[\^/);
	});
	test("interface names follow the kernel naming grammar", () => {
		for (const name of [
			"wlan0",
			"wwan0",
			"wwan0mbim0",
			"cdc-wdm0",
			"ttyUSB2",
			"enp1s0",
			"enp1s0u1u2",
			"wlP1p1s0",
			"end0",
			"wlx3ca62f112233",
			"eth0.10",
			"lo",
		])
			expect(isInterfaceName(name)).toBe(true);
		for (const name of [
			"enp1janedoe",
			"wlan-janes-phone",
			"Bobs_iPhone",
			"wlan",
			"jane0",
		])
			expect(isInterfaceName(name)).toBe(false);
	});
});

describe("daemon vocabularies from the producers' sources", () => {
	test("libqmi nicknames are keyed by code", () => {
		expect(QMI_CALL_END_REASONS["1"]).toEqual(["generic-unspecified"]);
		expect(QMI_PROTOCOL_ERRORS["14"]).toEqual(["CallFailed"]);
		expect(QMI_VERBOSE_CALL_END_REASONS["6"]?.["33"]).toEqual([
			"option-unsubscribed",
		]);
		expect(WLAN_REASONS["3"]).toEqual(["DEAUTH_LEAVING"]);
	});
	test("closed lists hold real producer values and are sorted", () => {
		expect(DAEMON_VOCABULARY.mmModemStates).toContain("registered");
		expect(DAEMON_VOCABULARY.mmDbusErrors).toContain(
			"org.freedesktop.ModemManager1.Error.MobileEquipment.SimPin",
		);
		expect(DAEMON_VOCABULARY.mmConnectSteps).toContain(
			"wait to get fully enabled",
		);
		expect(DAEMON_VOCABULARY.nmDeviceReasons).toContain("supplicant-timeout");
		expect(DAEMON_VOCABULARY.nmDeviceStates).toContain("ip-config");
		expect(DAEMON_VOCABULARY.nmDeviceStates).not.toContain("connecting");
		for (const list of Object.values(DAEMON_VOCABULARY)) {
			expect([...list]).toEqual([...list].sort());
			for (const value of list) expect(value).toMatch(/^[\x20-\x7e]{1,96}$/);
		}
	});
	test("enum nicknames follow glib-mkenums", () => {
		const enums = parseEnums(`
typedef enum { /*< underscore_name=x_thing >*/
    X_THING_ALPHA_ONE = 1,
    X_THING_ALPHA_TWO,      /* a comment */
    X_THING_BETA = 0x10, /*< nick=Beta >*/
    X_THING_HIDDEN = 99, /*< skip >*/
    X_THING_1xEVDO = 1 << 5,
} XThing;`);
		expect(enums.get("XThing")).toEqual([
			{ name: "X_THING_ALPHA_ONE", value: 1, nick: "alpha-one" },
			{ name: "X_THING_ALPHA_TWO", value: 2, nick: "alpha-two" },
			{ name: "X_THING_BETA", value: 16, nick: "Beta" },
			{ name: "X_THING_1xEVDO", value: 32, nick: "1xevdo" },
		]);
	});
});

describe("download header (S3)", () => {
	afterEach(() => mock.restore());
	test("journald's boot list counts a boot with no shown records", async () => {
		const current = readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
			.trim()
			.replaceAll("-", "");
		const older = "a".repeat(32);
		const quiet = "b".repeat(32);
		const line = "<msg> [modem0] state changed (enabled -> searching)";
		spyOn(runModule, "run").mockImplementation(async (_bin, args) =>
			args.includes("--list-boots")
				? ` -2 ${older} Fri 2026-11-13 10:00:00 UTC Fri 2026-11-13 11:00:00 UTC\n -1 ${quiet} Fri 2026-11-13 11:01:00 UTC Fri 2026-11-13 12:00:00 UTC\n  0 ${current} Fri 2026-11-13 12:01:00 UTC Fri 2026-11-13 13:00:00 UTC\n`
				: journal(
						{ ...modemManager(line), _BOOT_ID: older },
						{ ...modemManager(line), _BOOT_ID: current },
					),
		);
		const result = await getLog({
			send: () => {},
			data: { senderId: "test" },
		} as never);
		expect(result?.contents).toContain("[boot -2] ");
		expect(result?.contents).toContain("[boot 0] ");
		expect(result?.contents).toContain("Boots with no shown records: -1.");
	});
});
