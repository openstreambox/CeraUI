import { expect, test } from "bun:test";
import * as fc from "fast-check";
import * as bsc from "../helpers/backend-singleton-credentials.ts";
import * as udev from "../modules/cellular/udev-cellular-events.ts";
import * as ceil from "../modules/device-logs/ceiling.ts";
import * as cont from "../modules/device-logs/continuation.ts";
import { readFollowOutput } from "../modules/device-logs/follow-stream.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import * as clat from "../modules/network/clat-translation.ts";
import * as cc from "../modules/network/connectivity-candidates.ts";
import * as dri from "../modules/network/default-route-inventory.ts";
import * as dbp from "../modules/network/device-bound-probe.ts";
import * as hs from "../modules/network/hilink-session.ts";
import * as mon from "../modules/network/monitor/monitor-manager.ts";
import * as nat64 from "../modules/network/nat64.ts";
import * as ning from "../modules/network/network-ingest.ts";
import * as ni from "../modules/network/network-interfaces.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as rap from "../modules/network/router-admin-proxy.ts";
import * as rcap from "../modules/network/router-capabilities.ts";
import * as rdet from "../modules/network/router-details.ts";
import * as rsig from "../modules/network/router-signal.ts";
import * as rsh from "../modules/network/router-subnet-hygiene.ts";
import * as nft from "../modules/network/sharing-diag/nft-ruleset.ts";
import * as tc from "../modules/network/uplink-shaper/tc-runtime.ts";
import * as rp from "../modules/network/uplink-steering/route-parsers.ts";
import * as rpol from "../modules/network/uplink-steering/route-policy.ts";
import * as ds from "../modules/system/device-stats.ts";
import * as elp from "../modules/system/encoder-load-proc.ts";
import * as sus from "../modules/system/software-update-service-state.ts";
import * as su from "../modules/system/software-updates.ts";
import * as ut from "../modules/system/update-transport/core.ts";
import * as rd from "../modules/wifi/regdomain.ts";
import * as apsta from "../modules/wifi/wifi-ap-sta-capability.ts";
import * as wcap from "../modules/wifi/wifi-capabilities.ts";
import * as wc from "../modules/wifi/wifi-connections.ts";
import * as wcl from "../modules/wifi/wifi-hotspot-clients.ts";
import * as wse from "../modules/wifi/wifi-hotspot-station-events.ts";
import * as wnd from "../modules/wifi/wifi-network-diversity.ts";
import * as pm from "../modules/wifi/wifi-permanent-mac.ts";
import * as wrr from "../modules/wifi/wifi-regulatory-rules.ts";
import { fuzz } from "./helpers/property.ts";

// Parsers of tool output, kernel files and device replies. Most are written to
// fail closed with an Error on input they do not recognise; none may fail with
// a language-level error (TypeError, RangeError), which means the code walked
// into a property of undefined or an invalid operation on input it did not check.
const parsers: Record<string, (s: string) => unknown> = {
	parseIpv4: nat64.parseIpv4,
	parseIpv6: nat64.parseIpv6,
	parseNat64Prefix: nat64.parseNat64Prefix,
	parseIpAddrShow: (s) => ni.parseIpAddrShow(s),
	parseMonitorLine: mon.parseMonitorLine,
	parseNftRuleset: nft.parseNftRuleset,
	parseIpRules: rp.parseIpRules,
	parseHasDefaultRoute: rp.parseHasDefaultRoute,
	parseOwnedFwmarkRules: rpol.parseOwnedFwmarkRules,
	parseSteeringSourceRules: rpol.parseSteeringSourceRules,
	parseWifiScanRow: wc.parseWifiScanRow,
	parseRegulatoryDomain: rd.parseRegulatoryDomain,
	parseIwPhyChannels: (s) => rd.parseIwPhyChannels(s),
	parseInterfaceCombination: wcap.parseInterfaceCombination,
	parseIwPhyCapabilities: wcap.parseIwPhyCapabilities,
	parseIwRegDomains: wcap.parseIwRegDomains,
	parseIwDevPhyMap: wcap.parseIwDevPhyMap,
	parseNmcliWifiProperties: wcap.parseNmcliWifiProperties,
	parseIwLinkTelemetry: wcap.parseIwLinkTelemetry,
	parseIwStationDump: wcl.parseIwStationDump,
	parseIwStationEvent: wse.parseIwStationEvent,
	parseRegulatoryRules: wrr.parseRegulatoryRules,
	parseRegulatoryRuleLine: (s) => wrr.parseRegulatoryRuleLine(s),
	parseLoadAvg: ds.parseLoadAvg,
	parseSocTemp: ds.parseSocTemp,
	parseDfOutput: ds.parseDfOutput,
	parseProcNetDev: ds.parseProcNetDev,
	parseRaucSlot: ds.parseRaucSlot,
	parseLoadPercent: elp.parseLoadPercent,
	parseMppLoadRows: elp.parseMppLoadRows,
	parseMppLoad: elp.parseMppLoad,
	parseMppDecodeLoad: elp.parseMppDecodeLoad,
	parseMppSessions: elp.parseMppSessions,
	parseRgaLoad: elp.parseRgaLoad,
	parseUpgradePackageCount: su.parseUpgradePackageCount,
	parseUpgradeDownloadSize: su.parseUpgradeDownloadSize,
	parseHeldBackPackages: su.parseHeldBackPackages,
	parseKeptBackPackageNames: su.parseKeptBackPackageNames,
	parseAptPackageList: (s) => su.parseAptPackageList(s, "The following"),
	parseAptUpgradeSummary: su.parseAptUpgradeSummary,
	classifyAptUpdateResult: (s) => su.classifyAptUpdateResult(100, s),
	parseUdevPropertyBlock: (s) => udev.parseUdevPropertyBlock(s.split("\n")),
	parseHostSubnets: rsh.parseHostSubnets,
	parseRootQdisc: tc.parseRootQdisc,
	parseBacklogBytes: tc.parseBacklogBytes,
	parseDongleAdminPath: (s) => rap.parseDongleAdminPath(s, "/dongle"),
	parseAdminHeaderDump: rap.parseAdminHeaderDump,
	parseCurlProbeResponse: dbp.parseCurlProbeResponse,
	parseClatSnapshot: (s) => clat.parseClatSnapshot(s, "1"),
	parseUnitShow: clat.parseUnitShow,
	parseZteDetails: rdet.parseZteDetails,
	parseHilinkDetails: (s) =>
		rdet.parseHilinkDetails({ information: s, signal: s } as never),
	parseUfiDetails: (s) => rdet.parseUfiDetails({ a: s } as never),
	parseHilinkSignal: (s) =>
		rsig.parseHilinkSignal({ status: s, signal: s } as never),
	parseZteSignal: rsig.parseZteSignal,
	parseHilinkNetModeList: rcap.parseHilinkNetModeList,
	parseHilinkSession: hs.parseHilinkSession,
	parseNmConnAddUuid: nm.parseNmConnAddUuid,
	parseNmHotspotUuid: nm.parseNmHotspotUuid,
	parseNmConnDeleted: nm.parseNmConnDeleted,
	parseNmConnActivated: nm.parseNmConnActivated,
	decodePosition: (s) =>
		cont.decodePosition(s, { boot: "a", filter: "b" } as never),
	parseDiskUsage: ceil.parseDiskUsage,
	parseDebianSources: ut.parseDebianSources,
	parseSingletonUids: bsc.parseSingletonUids,
	parseRouteInventory4: (s) => dri.parseRouteInventory(s, 4),
	parseRouteInventory6: (s) => dri.parseRouteInventory(s, 6),
	parseDefaultRouteInterface: cc.parseDefaultRouteInterface,
	normalizeMacAddress: pm.normalizeMacAddress,
	parseMediamtxSrtEnabled: ning.parseMediamtxSrtEnabled,
	parseDetachedAptServiceState: sus.parseDetachedAptServiceState,
	parseDetachedAptServiceProbe: (s) =>
		sus.parseDetachedAptServiceProbe(
			{ stdout: s, stderr: s, exitCode: s.length % 2 } as never,
			["systemctl", "show"],
		),
	parseDiversityLinks: (s) => wnd.parseDiversityLinks(s.split("\n")),
	parseApStaConcurrencySupport: apsta.parseApStaConcurrencySupport,
};

const vocab = [
	" ",
	"\n",
	"\t",
	"\r",
	":",
	"=",
	"{",
	"}",
	"[",
	"]",
	'"',
	"'",
	"\\",
	"/",
	"-",
	"*",
	"#",
	"0",
	"1",
	"9",
	"255",
	"::",
	".",
	",",
	";",
	"a",
	"inet",
	"inet6",
	"dev",
	"via",
	"default",
	"scope",
	"mtu",
	"fwmark",
	"table",
	"lookup",
	"from",
	"all",
	"priority",
	"Interface",
	"phy#0",
	"Station",
	"signal",
	"rx bytes",
	"tx bitrate",
	"freq",
	"MHz",
	"dBm",
	"country",
	"US",
	"DFS",
	"NO-IR",
	"Mem",
	"Filesystem",
	"Packages",
	"upgraded",
	"newly installed",
	"__proto__",
	"constructor",
	"é",
	"\u0000",
	"𐀀",
	"-1",
	"1e999",
	"NaN",
	"Infinity",
	"0x10",
];

const soup = fc
	.array(fc.constantFrom(...vocab), { maxLength: 60 })
	.map((parts) => parts.join(""));
const anyText = fc.oneof(
	fc.string({ maxLength: 200, unit: "binary" }),
	fc.string({ maxLength: 200 }),
	soup,
);
const INTERNAL_ERRORS = [TypeError, RangeError, ReferenceError];

fuzz("text parsers reject input without internal errors", anyText, (input) => {
	for (const [name, parse] of Object.entries(parsers)) {
		try {
			parse(input);
		} catch (error) {
			if (INTERNAL_ERRORS.some((kind) => error instanceof kind))
				throw new Error(`${name}: ${error}`);
		}
	}
});

// Cost check, opt-in with PARSER_FUZZ_COST=1. A parser that rescans its input
// from every position costs about 16 times more on four times the input; a
// linear one about 4 times. Comparing two sizes does not depend on how fast the
// machine is. Each size is the median of several samples, so one garbage
// collection or scheduling pause cannot decide the result, and a parser too
// cheap to time at the starting size is tried on larger input (up to 8 times as
// much) before it counts as fast.
const costTest = process.env.PARSER_FUZZ_COST === "1" ? test : test.skip;
const COST_LARGE = 40_000;
const COST_SCALES = [1, 4, 8];
const COST_SCREEN_MS = 10;
const COST_SAMPLES = 5;
const COST_MAX_RATIO = 10;

function timeOnce(parse: (input: string) => unknown, input: string): number {
	const start = performance.now();
	try {
		parse(input);
	} catch {
		// rejecting the input is fine; only the cost matters here
	}
	return performance.now() - start;
}

function timeMedian(parse: (input: string) => unknown, input: string): number {
	const samples = Array.from({ length: COST_SAMPLES }, () =>
		timeOnce(parse, input),
	);
	samples.sort((a, b) => a - b);
	return samples[Math.floor(COST_SAMPLES / 2)] ?? 0;
}

costTest(
	"text parsers cost grows linearly with long repetitive input",
	() => {
		const units = [
			" ",
			"\n",
			"1",
			"a",
			":",
			".",
			"=",
			"-",
			"/",
			"\t",
			",",
			"(",
		];
		for (const [name, parse] of Object.entries(parsers)) {
			for (const unit of units) {
				for (const scale of COST_SCALES) {
					const size = COST_LARGE * scale;
					const large = unit.repeat(size);
					// The first call also warms the parser up.
					if (timeOnce(parse, large) < COST_SCREEN_MS) continue;
					const largeMs = timeMedian(parse, large);
					const smallMs = Math.max(timeMedian(parse, unit.repeat(size / 4)), 1);
					expect(
						largeMs / smallMs,
						`${name} on ${JSON.stringify(unit)}: ${smallMs.toFixed(0)} ms at ${size / 4}, ${largeMs.toFixed(0)} ms at ${size}`,
					).toBeLessThan(COST_MAX_RATIO);
					break;
				}
			}
		}
	},
	300_000,
);

const record = (message: string, index: number) =>
	JSON.stringify({
		__CURSOR: `cursor-${index}`,
		__REALTIME_TIMESTAMP: String(1_700_000_000_000_000 + index),
		_BOOT_ID: "a".repeat(32),
		MESSAGE: message,
	});

function follow(bytes: Uint8Array, cuts: number[]) {
	const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort(
		(a, b) => a - b,
	);
	const chunks: Uint8Array[] = [];
	let from = 0;
	for (const point of [...points, bytes.length]) {
		chunks.push(bytes.subarray(from, point));
		from = point;
	}
	const stream = (parts: Uint8Array[]) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			},
		});
	return {
		stdout: stream(chunks),
		stderr: stream([]),
	} as unknown as Parameters<typeof readFollowOutput>[0];
}

fuzz(
	"journal follow output yields every record however the pipe is chunked",
	fc.tuple(
		fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 6 }),
		fc.array(fc.nat(), { maxLength: 12 }),
	),
	async ([messages, cuts]) => {
		// Multi-byte characters make some cut points fall inside a code point.
		const lines = messages.map((message, index) => record(message, index));
		const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
		const seen: string[] = [];
		await readFollowOutput(follow(bytes, cuts), (entry) => {
			seen.push(entry.message);
			return "continue";
		});
		expect(seen).toEqual(messages);
	},
);

test("journal follow output refuses a record over the size limit", async () => {
	const oversize = new TextEncoder().encode(
		`${record("x".repeat(1024 * 1024 + 1), 0)}\n`,
	);
	await expect(
		readFollowOutput(follow(oversize, [100, 200_000]), () => "continue"),
	).rejects.toBeInstanceOf(JournalReadError);
});
