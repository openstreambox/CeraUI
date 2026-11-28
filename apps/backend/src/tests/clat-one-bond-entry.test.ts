/*
  ONE BOND ENTRY PER MODEM WHEN AN IPV6-ONLY BEARER IS TRANSLATED.

  The box state below is what the IPv6-only carrier harness measured with the
  image's CLAT controller up: `wwan0` holds only a global IPv6 address, the
  controller's `clat2` TUN holds 10.254.0.2/32, and `/run/ceralive/clat/2.json`
  is a live v2 snapshot naming both. The ifconfig and `ip addr show` text is the
  harness's own capture; only the snapshot reader's I/O and the USB identity of
  `wwan0` are supplied in memory, the scan, the CLAT checks, the identity ladder
  and the bond list are production code.

  Both links resolve to the same modem, so they share one `linkId`. Offering
  both put two rows with one id in the sidecar, which the sender rejects, and it
  kept an uplink that can never reach the receiver of the other family.
*/
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";
import { getConfigFilePath, setConfigFilePath } from "../modules/config.ts";
import {
	refreshModemIdPaths,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import { resolvePhysicalDevice } from "../modules/modems/physical-identity.ts";
import * as clatModule from "../modules/network/clat-translation.ts";
import {
	type ClatReadDeps,
	readClatTranslations,
	refreshClatTranslations,
	resetClatTranslationStateForTest,
	setClatTranslationsForTest,
} from "../modules/network/clat-translation.ts";
import { NmcliMonitorManager } from "../modules/network/monitor/monitor-manager.ts";
import {
	getNetworkInterfaceIncarnation,
	getNetworkInterfaces,
	handleNetif,
	isBondCandidate,
	parseIpAddrShow,
	processIfconfigOutput,
	resetNetifSnapshotForTest,
	setBondOptOut,
} from "../modules/network/network-interfaces.ts";
import {
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { setup } from "../modules/setup.ts";
import {
	defaultBindMapWriterDeps,
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import {
	peekBondKeys,
	resolveBondPhysicalIdentity,
	setBondIdentityResolverForTest,
} from "../modules/streaming/bond-entry.ts";
import {
	genSrtlaBondEntries,
	resolveSrtla,
	revalidateClatBondEntries,
} from "../modules/streaming/srtla.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/srtla-ip-preparation.ts";
import { bootDevice, installDevice } from "./helpers/bond-guard-install.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.1:1.4";
const BOOT_ID = "6ab061a3-6541-46cf-a8b5-39e58f4efd47";
const INVOCATION = "73bb5942d4284a0aac55c8cbb78ee30d";
const OBSERVED_AT = 66395.009039243;

const CLAT2 = `clat2: flags=4305<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST>  mtu 1500
        inet 10.254.0.2  netmask 255.255.255.255  destination 10.254.0.2
        inet6 fe80::3823:89a1:dc9e:2776  prefixlen 64  scopeid 0x20<link>
        unspec 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  txqueuelen 500  (UNSPEC)
        RX packets 7080  bytes 7413966 (7.4 MB)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 7084  bytes 7301750 (7.3 MB)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0`;

function wwan0(nativeIpv4?: string): string {
	return [
		"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500",
		...(nativeIpv4
			? [`        inet ${nativeIpv4}  netmask 255.255.255.0  broadcast 0.0.0.0`]
			: []),
		"        inet6 2001:db8:1::100  prefixlen 64  scopeid 0x0<global>",
		"        inet6 fe80::8085:f0ff:fe6b:9b08  prefixlen 64  scopeid 0x20<link>",
		"        ether 82:85:f0:6b:9b:08  txqueuelen 1000  (Ethernet)",
		"        RX packets 754  bytes 80289 (80.2 KB)",
		"        RX errors 0  dropped 0  overruns 0  frame 0",
		"        TX packets 6387  bytes 7453395 (7.4 MB)",
		"        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0",
	].join("\n");
}

const IP_ADDR = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
2: wwan0@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000
    link/ether 82:85:f0:6b:9b:08 brd ff:ff:ff:ff:ff:ff link-netns carrier
    inet6 2001:db8:1::100/64 scope global nodad
       valid_lft forever preferred_lft forever
    inet6 fe80::8085:f0ff:fe6b:9b08/64 scope link proto kernel_ll
       valid_lft forever preferred_lft forever
3: clat2: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 500
    link/none
    inet 10.254.0.2/32 scope global clat2
       valid_lft forever preferred_lft forever
    inet6 fe80::3823:89a1:dc9e:2776/64 scope link stable-privacy proto kernel_ll
       valid_lft forever preferred_lft forever
`;

/** `/run/ceralive/clat/2.json` as the controller wrote it, lease live. */
const SNAPSHOT = JSON.stringify({
	schema_version: 2,
	interface: "wwan0",
	ifindex: 2,
	tun: "clat2",
	tun_ifindex: 3,
	prefix: "64:ff9b::/96",
	ipv4: "10.254.0.2",
	state: "up",
	last_error: null,
	boot_id: BOOT_ID,
	invocation_id: INVOCATION,
	generation: "b6932a6419334350a002b135c0dfacc8",
	updated_at: 1795249501,
	observed_at: OBSERVED_AT,
	expires_at: OBSERVED_AT + 30,
});

function clatDeps(now: number): ClatReadDeps {
	const sysfs = new Map([
		["/sys/class/net/wwan0/ifindex", "2"],
		["/sys/class/net/clat2/ifindex", "3"],
		["/sys/class/net/clat2/flags", "0x1091"],
	]);
	return {
		dir: "/run/ceralive/clat",
		list: async () => ["2.json"],
		stat: async (path) =>
			path === "/run/ceralive/clat"
				? { regular: false, directory: true, uid: 0, size: 4096 }
				: { regular: true, directory: false, uid: 0, size: SNAPSHOT.length },
		read: async () => SNAPSHOT,
		sysfs: async (path) => sysfs.get(path),
		unit: async () => ({ invocation: INVOCATION, mainPid: 55 }),
		ipv4: async (tun, ip) => tun === "clat2" && ip === "10.254.0.2",
		isModem: async (ifname) => ifname === "wwan0",
		modemKey: async (ifname) =>
			ifname === "wwan0" ? deriveModemStableKey(ID_PATH) : undefined,
		bootId: () => BOOT_ID,
		boottime: () => now,
	};
}

function parentScanDeps(): RouterCellularScanDeps {
	const parent = "/sys/devices/usb1/1-1";
	const iface = `${parent}/1-1:1.4`;
	const attrs = new Map([
		[`${parent}/idVendor`, "2c7c"],
		[`${parent}/idProduct`, "0801"],
		[`${parent}/bDeviceClass`, "00"],
		[`${parent}/busnum`, "1"],
		[`${parent}/devnum`, "2"],
		[`${parent}/devpath`, "1"],
		[`${iface}/bInterfaceClass`, "ff"],
		[`${iface}/bInterfaceSubClass`, "ff"],
		[`${iface}/bInterfaceProtocol`, "ff"],
		["/run/udev/data/c189:1", `E:ID_PATH=${ID_PATH}`],
	]);
	return {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		readAttr: async (path) => attrs.get(path),
		resolveLink: async (path) =>
			path === "/sys/class/net/wwan0/device" ? iface : undefined,
		listDir: async (path) => (path === parent ? ["1-1:1.4"] : []),
		readLinkName: async (path) =>
			path === `${iface}/driver` ? "qmi_wwan" : undefined,
	};
}

async function scanBox(
	options: { now?: number; nativeIpv4?: string } = {},
): Promise<void> {
	await refreshClatTranslations(clatDeps(options.now ?? OBSERVED_AT + 5));
	const ifconfig = `${CLAT2}\n\n${wwan0(options.nativeIpv4)}\n`;
	const ifindices = new Map<string, number>();
	const overrides = parseIpAddrShow(IP_ADDR, ifindices);
	setModemIdPathReader(async () => new Map([["wwan0", ID_PATH]]));
	await refreshModemIdPaths();
	for (let observation = 0; observation < 2; observation++) {
		processIfconfigOutput(
			ifconfig,
			overrides,
			undefined,
			new Map([
				[
					"wwan0",
					{
						result: { kind: "bus" as const, bus: "usb" },
						seen: getNetworkInterfaceIncarnation("wwan0") ?? 0,
					},
				],
				[
					"clat2",
					{
						result: { kind: "no-device" as const },
						seen: getNetworkInterfaceIncarnation("clat2") ?? 0,
					},
				],
			]),
			ifindices,
		);
	}
	await refreshUsbNetMarkers(["clat2", "wwan0"], parentScanDeps());
}

let dir: string | undefined;

beforeEach(async () => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetClatTranslationStateForTest();
	// An IPv4 receiver unless a test says otherwise.
	await resolveSrtla("192.0.2.2");
});

afterEach(() => {
	setModemIdPathReader(null);
	resetClatTranslationStateForTest();
	// The empty snapshot retires the case's interfaces; reset the USB scan and
	// netdev lifetime state after it so neither a retirement hold nor a retired
	// lifetime reaches the next file in this process.
	processIfconfigOutput("");
	resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

test("the harness state is what the fix must handle: both links are candidates of one modem", async () => {
	await scanBox();
	const interfaces = getNetworkInterfaces();
	expect(interfaces.wwan0?.ip).toBeUndefined();
	expect(interfaces.wwan0?.ipv6).toBe("2001:db8:1::100");
	expect(interfaces.clat2?.ip).toBe("10.254.0.2");
	const wwan = interfaces.wwan0;
	const tun = interfaces.clat2;
	expect(wwan && isBondCandidate("wwan0", wwan)).toBe(true);
	expect(tun && isBondCandidate("clat2", tun)).toBe(true);
});

test("an IPv4 receiver gets the translator only, never the IPv6 parent beside it", async () => {
	await scanBox();
	const entries = genSrtlaBondEntries();
	expect(entries.map((e) => [e.iface, e.ip])).toEqual([
		["clat2", "10.254.0.2"],
	]);
	expect(entries[0]?.parentIface).toBe("wwan0");
	expect(entries[0]?.linkId).toMatch(/^lnk_/);
});

test("the published sidecar has one row per link id, so the sender keeps the map", async () => {
	await scanBox();
	dir = mkdtempSync(join(tmpdir(), "clat-bond-"));
	const ips = join(dir, "ips.txt");
	// The same write-time CLAT recheck publishSrtlaBond installs, reading the
	// in-memory snapshot instead of /run.
	const publication = await publishBondMapping(genSrtlaBondEntries(), {
		...defaultBindMapWriterDeps(ips, `${ips}.bindmap.json`),
		prepareEntries: (submitted) =>
			revalidateClatBondEntries(submitted, () =>
				readClatTranslations(clatDeps(OBSERVED_AT + 5)),
			),
	});
	expect(publication.ok).toBe(true);
	expect(readFileSync(ips, "utf8").trim().split("\n")).toEqual(["10.254.0.2"]);
	const sidecar = JSON.parse(readFileSync(`${ips}.bindmap.json`, "utf8")) as {
		links: { link_id: string; ip: string; iface: string }[];
	};
	const ids = sidecar.links.map((row) => row.link_id);
	expect(new Set(ids).size).toBe(ids.length);
	expect(sidecar.links.map((row) => row.iface)).toEqual(["clat2"]);
});

test("the local sender keeps a translated subnet route through write-time revalidation", async () => {
	await scanBox();
	const receiver = "10.254.0.2";
	const snapshot = await readClatTranslations(clatDeps(OBSERVED_AT + 5));
	const first = snapshot.get("clat2");
	if (!first) throw new Error("missing translator");
	dir = mkdtempSync(join(tmpdir(), "clat-local-bond-"));
	const configPath = getConfigFilePath();
	const ipsPath = setup.ips_file;
	const bindMapPath = setup.bind_map_file;
	const ips = join(dir, "ips.txt");
	const read = spyOn(clatModule, "readClatTranslations").mockResolvedValue(
		snapshot,
	);
	setConfigFilePath(join(dir, "config.json"));
	setup.ips_file = ips;
	setup.bind_map_file = `${ips}.bindmap.json`;
	resetBindMapWriter();
	try {
		setBondOptOut("wwan0", true);
		expect(genSrtlaBondEntries()).toEqual([]);
		expect((await prepareSrtlaIpAddresses(receiver)).ok).toBe(true);
		expect(readFileSync(ips, "utf8").trim()).toBe(receiver);

		read.mockImplementationOnce(async () => {
			setClatTranslationsForTest(
				new Map([["clat2", { ...first, generation: "successor" }]]),
			);
			return snapshot;
		});
		expect(
			(await prepareSrtlaIpAddresses(receiver, undefined, "refresh")).ok,
		).toBe(true);
		expect(readFileSync(ips, "utf8")).toBe("");
	} finally {
		setBondOptOut("wwan0", false);
		setConfigFilePath(configPath);
		if (ipsPath === undefined) delete setup.ips_file;
		else setup.ips_file = ipsPath;
		if (bindMapPath === undefined) delete setup.bind_map_file;
		else setup.bind_map_file = bindMapPath;
		read.mockRestore();
		resetBindMapWriter();
	}
});

test("an IPv6 receiver gets the native parent only, never the IPv4 translator", async () => {
	await scanBox();
	await resolveSrtla("2001:db8:2::10");
	expect(genSrtlaBondEntries().map((e) => [e.iface, e.ip])).toEqual([
		["wwan0", "2001:db8:1::100"],
	]);
});

test("with the lease expired the parent is offered again on its own", async () => {
	await scanBox({ now: OBSERVED_AT + 31 });
	expect(genSrtlaBondEntries().map((e) => [e.iface, e.ip])).toEqual([
		["wwan0", "2001:db8:1::100"],
	]);
});

test("native IPv4 on the parent wins over its translator, as on the modem's UI row", async () => {
	await scanBox({ nativeIpv4: "198.51.100.10" });
	expect(genSrtlaBondEntries().map((e) => [e.iface, e.ip])).toEqual([
		["wwan0", "198.51.100.10"],
	]);
});

test("the last-uplink veto reads a translator's keys from its modem", async () => {
	await scanBox();
	const parent = peekBondKeys("wwan0");
	expect(parent?.anchor).toBe("id-path");
	expect(peekBondKeys("clat2")).toEqual(parent);
	expect(peekBondKeys("clat2")?.linkId).toBe(
		resolveBondPhysicalIdentity("clat2")?.linkId,
	);
});

test("with the lease expired a translator has no bond keys", async () => {
	await scanBox({ now: OBSERVED_AT + 31 });
	expect(peekBondKeys("clat2")).toBeUndefined();
});

test("a translator whose modem has no stable identity has no bond keys", async () => {
	await scanBox();
	setBondIdentityResolverForTest((ifname) => resolvePhysicalDevice({ ifname }));
	try {
		expect(peekBondKeys("wwan0")?.anchor).toBe("ifname");
		expect(peekBondKeys("clat2")).toBeUndefined();
		expect(resolveBondPhysicalIdentity("clat2")).toBeUndefined();
	} finally {
		setBondIdentityResolverForTest(null);
	}
});

const simulationSelectors = [
	"NODE_ENV",
	"MOCK_MODE",
	"MOCK_SCENARIO",
	"HWSIM_REPO",
] as const;

test("a real device refuses to disable a translated modem that is the last uplink", async () => {
	await scanBox();
	const saved = simulationSelectors.map(
		(key) => [key, process.env[key]] as const,
	);
	for (const key of simulationSelectors) delete process.env[key];
	process.env.NODE_ENV = "production";
	// A regression that lets the disable through must not write the shared config.
	const configPath = getConfigFilePath();
	dir = mkdtempSync(join(tmpdir(), "clat-last-uplink-"));
	setConfigFilePath(join(dir, "config.json"));
	const sent: string[] = [];
	try {
		installDevice(
			bootDevice({
				getDeviceTypeOverride: () => "real",
				isDevelopment: () => false,
				readDeviceTreeCompatible: async () => "",
				readDeviceTreeModel: async () => "",
				readCeraliveRelease: async () => "",
				readDmiProductName: async () => "",
				readDmiBoardName: async () => "",
			}),
			new NmcliMonitorManager(() => undefined),
		);
		const interfaces = getNetworkInterfaces();
		const wwan = interfaces.wwan0;
		const tun = interfaces.clat2;
		expect(wwan && isBondCandidate("wwan0", wwan)).toBe(true);
		expect(tun && isBondCandidate("clat2", tun)).toBe(true);
		const outcome = handleNetif(makeRpcContext(sent).ws, {
			name: "wwan0",
			ip: wwan?.ip,
			enabled: false,
		} as Parameters<typeof handleNetif>[1]);
		expect(outcome).toEqual({ ok: false, reason: "disable_all_refused" });
		expect(wwan && isBondCandidate("wwan0", wwan)).toBe(true);
		expect(tun && isBondCandidate("clat2", tun)).toBe(true);
	} finally {
		installDevice(undefined, {});
		setConfigFilePath(configPath);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
