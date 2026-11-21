import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import { MOCK_DEVICE_STATS } from "../mocks/providers/device-stats.ts";
import {
	type BundleStateDeps,
	collectBundleState,
	parseBootAttempts,
	parseInstalledPackages,
} from "../modules/device-logs/bundle-state.ts";
import * as modemState from "../modules/modems/modems-state.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import * as bitrate from "../modules/streaming/engine-bitrate-status.ts";
import * as lifecycle from "../modules/streaming/stream-lifecycle-status.ts";
import * as stats from "../modules/system/device-stats-snapshot.ts";

const current = "a".repeat(32);
const previous = "b".repeat(32);
const older = "c".repeat(32);

// Every value a support file must never carry, planted in the sources the
// state record reads. The record is built field by field, so none can pass.
const SENSITIVE = {
	imei: "351756051523999",
	iccid: "8901260123456789012",
	imsi: "310260123456789",
	phone: "+15551234567",
	operator: "Jane Doe Mobile",
	ssid: "JaneDoeHome",
	psk: "hunter2-wifi-pass",
	apn: "private.apn.example",
	apnUser: "apn-user-secret",
	apnPassword: "apn-pass-secret",
	publicIpv4: "203.0.113.7",
	publicIpv6: "2001:db8:1234::7",
	mac: "0a1b2c3d4e5f",
	serialModel: "RM520N-GL 351756",
	privatePackage: "janedoe-notes",
};

function boot(
	bootId: string,
	index: number,
	extra: Partial<LogBootInfo> = {},
): LogBootInfo {
	return {
		bootId,
		index,
		firstTs: 1_000 + index * -100,
		lastTs: 1_050 + index * -100,
		current: index === 0,
		shutdown: index === 0 ? "current" : "unknown",
		evidence: [],
		logsAvailable: true,
		versions: null,
		...extra,
	};
}

const RAUC_SLOTS = [
	{
		name: "rootfs.0",
		bootname: "A",
		state: "booted",
		bootStatus: "good",
		version: "2026.11.20T1200Z",
		lastSyncedAt: null,
	},
	{
		name: "rootfs.1",
		bootname: "B",
		state: "inactive",
		bootStatus: "bad",
		version: `2026.11.19 ${SENSITIVE.ssid}`,
		lastSyncedAt: null,
	},
];

const DPKG_STATUS = [
	"Package: ceralive-device",
	"Status: install ok installed",
	"Version: 2026.11.3-1",
	"Description: owner text JaneDoeHome",
	"",
	"Package: cerastream",
	"Status: install ok installed",
	"Version: 1.9.0",
	"",
	"Package: srtla",
	"Status: deinstall ok config-files",
	"Version: 2.0.0",
	"",
	`Package: ${SENSITIVE.privatePackage}`,
	"Status: install ok installed",
	"Version: 1.0",
	"",
	"Package: modemmanager",
	"Status: install ok installed",
	`Version: 1.24.2 ${SENSITIVE.operator}`,
	"",
].join("\n");

const BOOT_STATE =
	"BOOT_ORDER=B A\nBOOT_A_LEFT=3\nBOOT_B_LEFT=1\nBOOT_CRC=123\n";

function deps(
	overrides: Partial<BundleStateDeps> = {},
): Partial<BundleStateDeps> {
	return {
		device: async () => true,
		readText: async (path) => {
			if (path === "/boot/boot_state.txt") return BOOT_STATE;
			if (path === "/var/lib/dpkg/status") return DPKG_STATUS;
			throw new Error(`unexpected read ${path}`);
		},
		readSlots: async () => RAUC_SLOTS,
		uptimeSeconds: () => 3_723.6,
		classify: async (row) =>
			row.bootId === previous
				? { shutdown: "unclean", evidence: ["no_shutdown_markers"] }
				: { shutdown: "clean", evidence: ["shutdown_target"] },
		...overrides,
	};
}

const restores: Array<() => void> = [];
beforeEach(() => {
	const spies = [
		spyOn(modemState, "getModems").mockReturnValue({
			1: {
				ifname: "wwan0",
				name: `QUECTEL Broadband Module - ${SENSITIVE.imei}`,
				sim_network: SENSITIVE.operator,
				model: "RM520N-GL",
				manufacturer: "Quectel",
				network_type: { supported: {}, active: "4g5g" },
				status: {
					connection: "connected",
					network: SENSITIVE.operator,
					network_type: "5g",
					signal: 67,
					roaming: false,
				},
				sim_presence: "present",
				sim_lock: { required: "none" },
				own_numbers: [SENSITIVE.phone],
				iccid: SENSITIVE.iccid,
				config: {
					conn: "uuid-private",
					autoconfig: false,
					apn: SENSITIVE.apn,
					username: SENSITIVE.apnUser,
					password: SENSITIVE.apnPassword,
					roaming: false,
					network: SENSITIVE.imsi,
				},
			},
			2: {
				ifname: "wwan1",
				name: "second",
				sim_network: "",
				model: SENSITIVE.serialModel,
				network_type: { supported: {}, active: null },
				sim_presence: "absent",
				data_connection_failed: true,
			},
			3: {
				ifname: "wwan2",
				name: "gone",
				sim_network: "",
				network_type: { supported: {}, active: null },
				removed: true,
			},
		} as unknown as ReturnType<typeof modemState.getModems>),
		spyOn(netif, "getNetworkInterfaces").mockReturnValue({
			wwan0: {
				ip: SENSITIVE.publicIpv4,
				ipv6: SENSITIVE.publicIpv6,
				tp: 0,
				txb: 0,
				rxb: 0,
				tx_bps: 2_500_000,
				rx_bps: 120_000,
				enabled: true,
				error: 0,
			},
			[`enx${SENSITIVE.mac}`]: {
				usb: true,
				ip: "192.168.8.100",
				tp: 0,
				txb: 0,
				rxb: 0,
				enabled: false,
				error: netif.NETIF_ERR_NOSIM,
			},
			wlan0: {
				tp: 0,
				txb: 0,
				rxb: 0,
				enabled: false,
				error: netif.NETIF_ERR_HOTSPOT,
			},
		} as unknown as ReturnType<typeof netif.getNetworkInterfaces>),
		spyOn(stats, "getDeviceStatsSnapshot").mockReturnValue(
			MOCK_DEVICE_STATS as unknown as ReturnType<
				typeof stats.getDeviceStatsSnapshot
			>,
		),
		spyOn(lifecycle, "getStreamLifecycleState").mockReturnValue("live"),
		spyOn(bitrate, "getEngineBitrateStatus").mockReturnValue({
			applied_kbps: 3_200,
			ceiling_kbps: 6_000,
		}),
	];
	for (const spy of spies) restores.push(() => spy.mockRestore());
});
afterEach(() => {
	for (const reset of restores.splice(0)) reset();
});

const input = {
	boots: [boot(current, 0), boot(previous, -1), boot(older, -2)],
	journalBoots: [current, previous],
	events: [],
};

test("the state record carries only allowlisted device facts", async () => {
	const state = await collectBundleState(input, deps());
	expect(state).toEqual({
		uptimeSeconds: 3_724,
		memory: {
			totalBytes: MOCK_DEVICE_STATS.memTotalBytes,
			availableBytes: MOCK_DEVICE_STATS.memAvailableBytes,
		},
		boots: [
			{
				bootId: current,
				current: true,
				firstTs: 1_000,
				lastTs: 1_050,
				shutdown: "current",
				evidence: [],
			},
			{
				bootId: previous,
				current: false,
				firstTs: 1_100,
				lastTs: 1_150,
				shutdown: "unclean",
				evidence: ["no_shutdown_markers"],
			},
		],
		slots: [
			{
				name: "rootfs.0",
				bootname: "A",
				state: "booted",
				bootStatus: "good",
				version: "2026.11.20T1200Z",
			},
			{
				name: "rootfs.1",
				bootname: "B",
				state: "inactive",
				bootStatus: "bad",
				version: "[value]",
			},
		],
		bootAttempts: { order: ["B", "A"], left: { A: 3, B: 1 } },
		packages: [
			{ name: "ceralive-device", version: "2026.11.3-1" },
			{ name: "cerastream", version: "1.9.0" },
			{ name: "modemmanager", version: "[value]" },
		],
		modems: [
			{
				modem: 1,
				manufacturer: "Quectel",
				model: "RM520N-GL",
				connection: "connected",
				mode: "4g5g",
				accessTechnology: "5g",
				signal: 67,
				roaming: false,
				sim: "present",
				simLock: "none",
				apnConfigured: true,
				dataConnectionFailed: false,
			},
			{
				modem: 2,
				manufacturer: null,
				model: "[value]",
				connection: "unknown",
				mode: null,
				accessTechnology: null,
				signal: null,
				roaming: null,
				sim: "absent",
				simLock: null,
				apnConfigured: false,
				dataConnectionFailed: true,
			},
		],
		interfaces: [
			{
				name: "[interface]",
				usb: true,
				bonded: false,
				ipv4: true,
				flags: ["no_sim"],
				txKbps: null,
				rxKbps: null,
			},
			{
				name: "wlan0",
				usb: false,
				bonded: false,
				ipv4: false,
				flags: ["hotspot"],
				txKbps: null,
				rxKbps: null,
			},
			{
				name: "wwan0",
				usb: false,
				bonded: true,
				ipv4: true,
				flags: [],
				txKbps: 2_500,
				rxKbps: 120,
			},
		],
		stream: { lifecycle: "live", bitrateKbps: 3_200, ceilingKbps: 6_000 },
	});
	const text = JSON.stringify(state);
	for (const value of Object.values(SENSITIVE))
		expect(text).not.toContain(value);
	expect(text).not.toContain("192.168.8.100");
	expect(text).not.toContain("uuid-private");
});

test("a finished boot whose ending cannot be read reports unknown, not a failure", async () => {
	const state = await collectBundleState(
		input,
		deps({
			classify: async () => {
				throw new Error("journal unreadable");
			},
		}),
	);
	expect(state.boots[1]).toMatchObject({
		bootId: previous,
		shutdown: "unknown",
		evidence: ["read_failed"],
	});
});

test("the ending of a boot is read against the boot that followed it", async () => {
	const seen: Array<[string, string | undefined]> = [];
	await collectBundleState(
		{
			// Unordered input, with a journal-less boot between the two.
			boots: [
				boot(previous, -2),
				boot(current, 0),
				boot(older, -1, { logsAvailable: false }),
			],
			journalBoots: [current, previous],
			events: [],
		},
		deps({
			classify: async (row, next) => {
				seen.push([row.bootId, next?.bootId]);
				return { shutdown: "clean", evidence: ["journal_stopped"] };
			},
		}),
	);
	expect(seen).toEqual([[previous, current]]);
});

test("unreadable device sources leave their fields empty and keep the rest", async () => {
	const state = await collectBundleState(
		input,
		deps({
			readText: async () => {
				throw new Error("ENOENT");
			},
			readSlots: async () => {
				throw new Error("rauc missing");
			},
		}),
	);
	expect(state.slots).toBeNull();
	expect(state.bootAttempts).toBeNull();
	expect(state.packages).toEqual([]);
	expect(state.modems).toHaveLength(2);
});

test("a host that is not a device reads no device files", async () => {
	const state = await collectBundleState(
		input,
		deps({
			device: async () => false,
			readText: async (path) => {
				throw new Error(`read ${path} off-device`);
			},
			readSlots: async () => {
				throw new Error("rauc off-device");
			},
		}),
	);
	expect(state.slots).toBeNull();
	expect(state.bootAttempts).toBeNull();
	expect(state.packages).toEqual([]);
});

test("boot attempts accept only the boot-state helper's keys and slot names", () => {
	expect(parseBootAttempts("BOOT_ORDER=A\nBOOT_A_LEFT=2\n")).toEqual({
		order: ["A"],
		left: { A: 2 },
	});
	expect(
		parseBootAttempts("BOOT_ORDER=A $(reboot)\nBOOT_A_LEFT=2\n"),
	).toBeNull();
	expect(parseBootAttempts("BOOT_A_LEFT=999\nBOOT_ORDER=B\n")).toEqual({
		order: ["B"],
		left: {},
	});
	expect(parseBootAttempts("garbage")).toBeNull();
});

test("installed packages keep allowlisted names and valid versions only", () => {
	expect(parseInstalledPackages(DPKG_STATUS).map((row) => row.name)).toEqual([
		"ceralive-device",
		"cerastream",
		"modemmanager",
	]);
});
