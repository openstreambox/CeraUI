import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import * as mockService from "../mocks/mock-service.ts";
import { MOCK_DEVICE_STATS } from "../mocks/providers/device-stats.ts";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	type BundleStateDeps,
	collectBundleState,
	parseBootAttempts,
	posixCksum,
	screenState,
} from "../modules/device-logs/bundle-state.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
import * as modemState from "../modules/modems/modems-state.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import * as bitrate from "../modules/streaming/engine-bitrate-status.ts";
import * as lifecycle from "../modules/streaming/stream-lifecycle-status.ts";
import { defaultDeviceDetectionDeps } from "../modules/system/device-detection.ts";
import * as stats from "../modules/system/device-stats-snapshot.ts";
import { bootId, journal, queryFixture } from "./helpers/device-query.ts";

const current = bootId;
const previous = "b".repeat(32);
const older = "c".repeat(32);

/**
 * Identifiers planted in every field the record exports: device serials,
 * operator and account labels, host and person names, a tailnet name, private
 * and public addresses, a compact MAC, a bare phone number, an IMEI, ICCID and
 * IMSI, an SSID and PSK, APN text and credentials. None may reach the file.
 */
const HOSTILE = {
	operator: "Alice Mobile",
	serial: "SN-A7K3L9Q",
	account: "customeracct",
	laptop: "alice-laptop",
	home: "alice-home",
	tailnet: "alice-node.example.ts.net",
	privateIp: "192.168.4.5",
	publicIp: "203.0.113.7",
	mac: "0a1b2c3d4e5f",
	phone: "15551234567",
	imei: "351756051523999",
	iccid: "8901260123456789012",
	imsi: "310260123456789",
	ssid: "JaneDoeHome",
	psk: "hunter2-wifi-pass",
	apn: "private.apn.example",
	apnUser: "apn-user-secret",
	apnPassword: "apn-pass-secret",
	package: "ceralive-alice",
	// The re-check's probe values: compact MACs behind a version prefix and
	// identifiers split into short groups.
	macVersion: "1.0+0a1b2c3d4e5f",
	hashMacVersion: "1.0+g0a1b2c3d4e5f",
	groupedImei: "35175605-1523999",
	groupedIccid: "8901260.123456.789012",
	// Re-check 2: a short asset tag as the last part of a RAUC image version.
	assetTag: "97531",
};

function boot(
	id: string,
	index: number,
	extra: Partial<LogBootInfo> = {},
): LogBootInfo {
	return {
		bootId: id,
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
		version: `2026.11.${HOSTILE.assetTag}`,
		lastSyncedAt: null,
	},
	{
		name: HOSTILE.laptop,
		bootname: HOSTILE.serial,
		state: HOSTILE.home,
		bootStatus: HOSTILE.account,
		version: HOSTILE.groupedImei,
		lastSyncedAt: null,
	},
	{
		name: "rootfs.1",
		bootname: "B",
		state: "inactive",
		bootStatus: "bad",
		version: HOSTILE.groupedIccid,
		lastSyncedAt: null,
	},
];

// Re-check 2: a stanza named after an Object.prototype member. The dpkg file is
// no longer read at all, so it cannot reach any lookup.
const DPKG_STATUS =
	"Package: constructor\nStatus: install ok installed\nVersion: 1.0\n";

const BOOT_STATE = `BOOT_ORDER=B A\nBOOT_A_LEFT=3\nBOOT_B_LEFT=1\nBOOT_CRC=2981376971\n`;

function deps(
	overrides: Partial<BundleStateDeps> = {},
): Partial<BundleStateDeps> {
	return {
		device: async () => true,
		readText: async (path) => {
			if (path === "/boot/boot_state.txt") return BOOT_STATE;
			if (path === "/var/lib/dpkg/status") {
				dpkgReads++;
				return DPKG_STATUS;
			}
			throw new Error(`unexpected read ${path}`);
		},
		readSlots: async () => RAUC_SLOTS,
		uptimeSeconds: () => 3_723.6,
		classify: async (row) =>
			row.bootId === previous
				? {
						shutdown: "unclean",
						evidence: ["no_shutdown_markers", HOSTILE.home],
					}
				: { shutdown: "clean", evidence: ["shutdown_target"] },
		...overrides,
	};
}

let dpkgReads = 0;
const restores: Array<() => void> = [];
beforeEach(() => {
	const spies = [
		spyOn(modemState, "getModems").mockReturnValue({
			1: {
				ifname: "wwan0",
				name: `QUECTEL Broadband Module - ${HOSTILE.imei}`,
				sim_network: HOSTILE.operator,
				model: HOSTILE.serial,
				manufacturer: HOSTILE.operator,
				network_type: { supported: {}, active: "5g4g" },
				status: {
					connection: "connected",
					network: HOSTILE.operator,
					network_type: "5G",
					signal: 67,
					roaming: false,
				},
				sim_presence: "present",
				sim_lock: { required: "none" },
				own_numbers: [HOSTILE.phone],
				iccid: HOSTILE.iccid,
				config: {
					conn: "uuid-private",
					autoconfig: false,
					apn: HOSTILE.apn,
					username: HOSTILE.apnUser,
					password: HOSTILE.apnPassword,
					roaming: false,
					network: HOSTILE.imsi,
				},
			},
			2: {
				ifname: HOSTILE.laptop,
				name: HOSTILE.account,
				sim_network: "",
				model: "RM520N-GL",
				manufacturer: "Quectel",
				network_type: { supported: {}, active: HOSTILE.account },
				status: {
					connection: HOSTILE.home,
					network_type: HOSTILE.phone,
					signal: 400,
					roaming: false,
				},
				sim_presence: HOSTILE.ssid,
				sim_lock: { required: HOSTILE.psk },
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
				ip: HOSTILE.publicIp,
				tp: 0,
				txb: 0,
				rxb: 0,
				tx_bps: 2_500_000,
				rx_bps: 120_000,
				enabled: true,
				error: 0,
			},
			[`enx${HOSTILE.mac}`]: {
				usb: true,
				ip: HOSTILE.privateIp,
				tp: 0,
				txb: 0,
				rxb: 0,
				enabled: false,
				error: netif.NETIF_ERR_NOSIM,
			},
			[HOSTILE.laptop]: { tp: 0, txb: 0, rxb: 0, enabled: false, error: 0 },
			[HOSTILE.tailnet]: { tp: 0, txb: 0, rxb: 0, enabled: false, error: 0 },
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
		spyOn(lifecycle, "getStreamLifecycleState").mockReturnValue("streaming"),
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
	secrets: [],
};

function expectNoHostile(text: string) {
	for (const value of Object.values(HOSTILE)) expect(text).not.toContain(value);
	expect(text).not.toContain("uuid-private");
}

test("the state record exports closed vocabularies and labels, and no versions", async () => {
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
			{ slot: "A", state: "booted", bootStatus: "good" },
			{ slot: null, state: "other", bootStatus: "other" },
			{ slot: "B", state: "inactive", bootStatus: "bad" },
		],
		bootAttempts: { order: ["B", "A"], left: { A: 3, B: 1 } },
		modems: [
			{
				modem: 1,
				connection: "connected",
				mode: "5g4g",
				accessTechnology: "5G",
				signal: 67,
				roaming: false,
				sim: "present",
				simLock: "none",
				apnConfigured: true,
				dataConnectionFailed: false,
			},
			{
				modem: 2,
				connection: "other",
				mode: "other",
				accessTechnology: "other",
				signal: null,
				roaming: false,
				sim: "other",
				simLock: "other",
				apnConfigured: false,
				dataConnectionFailed: true,
			},
		],
		interfaces: [
			{
				label: "other-1",
				usb: false,
				bonded: false,
				ipv4: false,
				flags: [],
				txKbps: null,
				rxKbps: null,
			},
			{
				label: "other-2",
				usb: false,
				bonded: false,
				ipv4: false,
				flags: [],
				txKbps: null,
				rxKbps: null,
			},
			{
				label: "ethernet-1",
				usb: true,
				bonded: false,
				ipv4: true,
				flags: ["no_sim"],
				txKbps: null,
				rxKbps: null,
			},
			{
				label: "wifi-1",
				usb: false,
				bonded: false,
				ipv4: false,
				flags: ["hotspot"],
				txKbps: null,
				rxKbps: null,
			},
			{
				label: "cellular-1",
				usb: false,
				bonded: true,
				ipv4: true,
				flags: [],
				txKbps: 2_500,
				rxKbps: 120,
			},
		],
		stream: { lifecycle: "streaming", bitrateKbps: 3_200, ceilingKbps: 6_000 },
	});
	expectNoHostile(JSON.stringify(state));
	expect(JSON.stringify(state)).not.toContain('"version"');
	expect(dpkgReads).toBe(0);
});

test("a value holding a held secret is dropped, never left to refuse the bundle", async () => {
	const state = await collectBundleState(
		{
			...input,
			secrets: [{ kind: "pin", value: "3200" }],
		},
		deps(),
	);
	expect(state?.stream.bitrateKbps).toBeNull();
	expect(state?.stream.ceilingKbps).toBe(6_000);
});

test("a held secret equal to one of the record's keys drops the whole record", async () => {
	expect(
		await collectBundleState(
			{ ...input, secrets: [{ kind: "password", value: "uptimeSeconds" }] },
			deps(),
		),
	).toBeNull();
	expect(
		screenState({ label: "cellular-1" }, [{ kind: "ssh", value: "label" }]),
	).toBeNull();
	expect(
		screenState({ label: "cellular-1" }, [
			{ kind: "ssh", value: "cellular-1" },
		]),
	).toEqual({ label: null });
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
			boots: [
				boot(previous, -2),
				boot(current, 0),
				boot(older, -1, { logsAvailable: false }),
			],
			journalBoots: [current, previous],
			events: [],
			secrets: [],
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
});

const GRANT =
	'ID=ceralive\nBOARD=example-board\nFAMILY=rk3588\nCAPABILITIES="os-updates"\n';
const DENY =
	'ID=ceralive\nBOARD=example-board\nFAMILY=rk3588\nCAPABILITIES="system-control"\n';

for (const [name, image, expected] of [
	["an image granting os-updates", { release: GRANT }, true],
	["an image without os-updates", { release: DENY }, false],
	[
		"a legacy RK3588 image without a record",
		{ compatible: "rockchip,rk3588" },
		true,
	],
	["a legacy unknown host without a record", {}, false],
	["mock mode on a granting image", { release: GRANT, mocks: true }, false],
] as const) {
	test(`the default gate on ${name} ${expected ? "reads" : "skips"} the device files`, async () => {
		const setup: { release?: string; compatible?: string; mocks?: boolean } =
			image;
		const spies = [
			spyOn(
				defaultDeviceDetectionDeps,
				"getDeviceTypeOverride",
			).mockReturnValue(undefined),
			spyOn(defaultDeviceDetectionDeps, "isDevelopment").mockReturnValue(false),
			spyOn(
				defaultDeviceDetectionDeps,
				"readCeraliveRelease",
			).mockResolvedValue(setup.release ?? ""),
			spyOn(
				defaultDeviceDetectionDeps,
				"readDeviceTreeCompatible",
			).mockResolvedValue(setup.compatible ?? ""),
			spyOn(
				defaultDeviceDetectionDeps,
				"readDeviceTreeModel",
			).mockResolvedValue(""),
			spyOn(defaultDeviceDetectionDeps, "readDmiProductName").mockResolvedValue(
				"",
			),
			spyOn(defaultDeviceDetectionDeps, "readDmiBoardName").mockResolvedValue(
				"",
			),
			spyOn(mockService, "shouldUseMocks").mockReturnValue(
				setup.mocks ?? false,
			),
		];
		restores.push(...spies.map((spy) => () => spy.mockRestore()));
		const reads: string[] = [];
		const { device: _device, ...rest } = deps({
			readText: async (path) => {
				reads.push(path);
				return BOOT_STATE;
			},
			readSlots: async () => {
				reads.push("rauc");
				return RAUC_SLOTS;
			},
		});
		const state = await collectBundleState(input, rest);
		expect(reads.sort()).toEqual(
			expected ? ["/boot/boot_state.txt", "rauc"] : [],
		);
		expect(state?.slots === null).toBe(!expected);
	});
}

test("the CRC matches POSIX cksum", () => {
	expect(posixCksum("")).toBe(4_294_967_295);
	expect(posixCksum("BOOT_ORDER=B A\nBOOT_A_LEFT=3\nBOOT_B_LEFT=1\n")).toBe(
		2_981_376_971,
	);
	expect(posixCksum("BOOT_ORDER=A B\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\n")).toBe(
		697_809_624,
	);
});

test.each([
	[
		"a valid file without a CRC",
		"BOOT_ORDER=A\nBOOT_A_LEFT=2\nBOOT_B_LEFT=0\n",
		{ order: ["A"], left: { A: 2, B: 0 } },
	],
	["a repeated slot", "BOOT_ORDER=A A\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\n", null],
	[
		"a counter over the attempt budget",
		"BOOT_ORDER=A B\nBOOT_A_LEFT=99\nBOOT_B_LEFT=3\n",
		null,
	],
	["an empty order", "BOOT_ORDER=\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\n", null],
	["a missing counter", "BOOT_ORDER=A B\nBOOT_A_LEFT=3\n", null],
	[
		"a duplicate key",
		"BOOT_ORDER=A B\nBOOT_ORDER=B A\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\n",
		null,
	],
	["a foreign slot", "BOOT_ORDER=A C\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\n", null],
	[
		"a CRC mismatch",
		"BOOT_ORDER=A B\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\nBOOT_CRC=1\n",
		null,
	],
	[
		"a matching CRC",
		"BOOT_ORDER=A B\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\nBOOT_CRC=697809624\n",
		{ order: ["A", "B"], left: { A: 3, B: 3 } },
	],
	["garbage", "garbage", null],
] as const)("boot state with %s", (_name, text, expected) => {
	expect(parseBootAttempts(text)).toEqual(expected);
});

async function downloadWith(
	state: Awaited<ReturnType<typeof collectBundleState>>,
	secrets: ReadonlyArray<{ kind: string; value: string }>,
) {
	const fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	const collect = spyOn(data, "collectBundleData").mockResolvedValue({
		exportedBy: {
			bootId,
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
			ceraui: "ui",
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		},
		boots: [{ bootId, versions: null }],
		journalBoots: [bootId],
		settings: {
			logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
			state: { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null },
			updateChannel: "stable",
			autostart: null,
			hardwareKind: "generic",
			data: null,
		},
		state,
		events: [],
		bootRecords: [],
		secrets: [...secrets],
	});
	try {
		const manifest = await previewBundle();
		const ticket = await createBundle({});
		if (!ticket.ok) throw new Error(ticket.error);
		const response = await handleLogBundleRequest(
			new Request(`http://device${ticket.url}`),
		);
		expect(response.status).toBe(200);
		const text = await new Response(
			response.body?.pipeThrough(new DecompressionStream("gzip")),
		).text();
		return {
			settings: manifest.sections.find((row) => row.id === "settings"),
			text,
		};
	} finally {
		await abortLogBundles();
		await abortLogExports();
		collect.mockRestore();
		fixture.restore();
	}
}

test("hostile device values never reach the downloaded bundle, and a four-part version cannot block it", async () => {
	const secrets = [{ kind: "hotspot", value: HOSTILE.home }];
	const state = await collectBundleState({ ...input, secrets }, deps());
	const { settings, text } = await downloadWith(state, secrets);
	expect(settings).toEqual({ id: "settings", entries: 2, redactions: 0 });
	expect(text).toContain('"section":"settings","device":{');
	expect(text).toContain('"label":"cellular-1"');
	expectNoHostile(text);
});

test.each([
	["the uptime", "3724", 2],
	["a key", "uptimeSeconds", 1],
	["the old placeholder", "[value]", 2],
	["the wrapper key", "device", 1],
	["an interface label", "cellular-1", 2],
])(
	"a held secret equal to %s never refuses the bundle",
	async (_name, value, settingsRecords) => {
		const secrets = [{ kind: "password", value }];
		const state = await collectBundleState({ ...input, secrets }, deps());
		const { settings, text } = await downloadWith(state, secrets);
		expect(settings?.entries).toBe(settingsRecords);
		expect(text).not.toContain(value === "device" ? '"device":{' : value);
		expect(text.trimEnd().split("\n").at(-1)).toBe(
			'{"section":"end","complete":true}',
		);
	},
);
