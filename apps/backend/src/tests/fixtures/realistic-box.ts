/*
    A described box for cellular admission tests: three USB modems on default
    automatic profiles and one platform Ethernet port.

    The fixture replaces I/O only (sysfs links, D-Bus/ModemManager/
    NetworkManager reads, the kernel session). Capture, the runtime root, the
    path owner, source admission, exclusion and bond collection are the
    production code, so a change that keeps a healthy modem out of the bond
    fails here. Every change to cellular admission or recovery must keep
    `expectedBond()` true on this box.
*/

import { deriveModemStableKey } from "@ceraui/rpc/schemas";
import type { CellularNmIpSnapshot } from "../../modules/modems/cellular-nm-ip.ts";
import {
	type CellularRuntimeHostIo,
	initCellularRuntimeAdmission,
	setCellularRuntimeHostIoForTest,
} from "../../modules/modems/cellular-runtime-host.ts";
import { CellularRuntimeSession } from "../../modules/modems/cellular-runtime-session.ts";
import {
	refreshModemIdPaths,
	setModemIdPathReader,
} from "../../modules/modems/modem-wire-producer.ts";
import type { CellularNetworkTarget } from "../../modules/modems/modems.ts";
import { removeModem, setModem } from "../../modules/modems/modems-state.ts";
import type { NativeBearerSnapshot } from "../../modules/modems/native-bearer.ts";
import { resolvePhysicalDevice } from "../../modules/modems/physical-identity.ts";
import { resetCellularSourcesForTest } from "../../modules/network/cellular-source-state.ts";
import {
	netIfBuildMsg,
	processIfconfigOutput,
} from "../../modules/network/network-interfaces.ts";
import { setNonUsbNetEvidenceIoForTest } from "../../modules/network/non-usb-net-evidence.ts";
import { resetLifecycleInterlock } from "../../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../../modules/streaming/recovery-barrier.ts";
import {
	genSrtlaBondEntries,
	setBondIdentityResolverForTest,
} from "../../modules/streaming/srtla.ts";
import {
	clearBondNetworkFixture,
	resetBondFixture,
} from "../helpers/bond-toggle-fixture.ts";

const MM_OWNER = ":1.21",
	NM_OWNER = ":1.22";

export interface BoxModem {
	readonly id: number;
	readonly ifname: string;
	readonly ip: string;
	/** udev ID_PATH of the net interface, as the id-path cache reports it. */
	readonly idPath: string;
	/** Only some modems publish a usable USB serial; the others anchor on the port. */
	readonly serial?: string;
	/** Resolved `/sys/class/net/<ifname>/device`. */
	readonly sysfs: string;
	readonly uuid: string;
}

export const BOX_ETHERNET = {
	ifname: "eth0",
	ip: "192.168.50.20",
	sysfs: "/sys/devices/platform/fe1c0000.ethernet",
} as const;

export const BOX_MODEMS: readonly BoxModem[] = [
	{
		id: 0,
		ifname: "wwan0",
		ip: "10.64.0.2",
		idPath: "platform-fc800000.usb-usb-0:1.1:1.4",
		serial: "0123456789ab",
		sysfs: "/sys/devices/platform/fc800000.usb/usb1/1-1/1-1.1/1-1.1:1.4",
		uuid: "00000000-0000-4000-8000-000000000000",
	},
	{
		id: 1,
		ifname: "wwan1",
		ip: "10.65.0.2",
		idPath: "platform-fc800000.usb-usb-0:1.2:1.4",
		sysfs: "/sys/devices/platform/fc800000.usb/usb1/1-1/1-1.2/1-1.2:1.4",
		uuid: "00000000-0000-4000-8000-000000000001",
	},
	{
		id: 2,
		ifname: "wwan2",
		ip: "10.66.0.2",
		idPath: "platform-fc800000.usb-usb-0:1.3:1.4",
		sysfs: "/sys/devices/platform/fc800000.usb/usb1/1-1/1-1.3/1-1.3:1.4",
		uuid: "00000000-0000-4000-8000-000000000002",
	},
];

export function boxModemKey(modem: BoxModem): string {
	const key = deriveModemStableKey(modem.idPath);
	if (!key) throw new Error("Fixture modem has no stable key");
	return key;
}

/** An I/O step that succeeds and leaves nothing behind on this box. */
async function settled(): Promise<void> {
	await Promise.resolve();
}

function enoent(): never {
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

/** The box's sysfs, as far as device ancestry is concerned. A node is on the
 * USB bus when one of its path segments names a USB device or interface. */
function boxSysfs(devices: ReadonlyMap<string, string>) {
	return {
		realpath: (path: string) => {
			const match = /^\/sys\/class\/net\/([^/]+)\/device$/.exec(path);
			return (match?.[1] && devices.get(match[1])) || enoent();
		},
		readlink: (path: string) => {
			const node = path.replace(/\/subsystem$/, ""),
				last = node.split("/").pop() ?? "";
			if (![...devices.values()].some((device) => device.startsWith(node)))
				enoent();
			if (/^usb\d+$/.test(last) || /^\d+-\d+(\.\d+)*(:\d+\.\d+)?$/.test(last))
				return "../../../bus/usb";
			if (node === "/sys/devices/platform") enoent();
			return "../../../bus/platform";
		},
	};
}

function stanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 0.0.0.0`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function target(modem: BoxModem, key: string): CellularNetworkTarget {
	return {
		id: modem.id,
		key,
		deviceId: `device-${modem.id}`,
		simId: `sim-${modem.id}`,
		subscriber: `subscriber-${modem.id}`,
		equipment: `equipment-${modem.id}`,
		ifname: modem.ifname,
		ifindex: String(10 + modem.id),
		netDevice: modem.sysfs,
		usbDevice: modem.sysfs.replace(/\/[^/]+$/, ""),
		generation: `usb-${modem.id}`,
		identity: { model: "Unlisted", firmware: "unlisted", mode: "qmi" },
		sim: {
			modemInfo: {
				"modem.generic.sim": `/org/freedesktop/ModemManager1/SIM/${modem.id}`,
			},
			simInfo: { "sim.properties.operator-code": "00101" },
		} as never,
	};
}

export interface RealisticBox {
	readonly sessions: CellularRuntimeSession[];
	/** Interfaces the bond is offered right now, sorted. */
	bond(): string[];
	/** What a healthy box must offer: every modem and the Ethernet port. */
	expectedBond(): string[];
	/** Move the runtime clock; a withdrawn path is reinstalled after a minute. */
	advance(ms: number): void;
	/** Re-point an interface (a re-enumeration under a new name) or remove it. */
	setSysfs(ifname: string, device: string | undefined): void;
	close(): void;
}

/** Install the box. `io` adds or replaces I/O boundaries for one test. */
export async function installRealisticBox(
	io: Partial<CellularRuntimeHostIo> = {},
): Promise<RealisticBox> {
	resetBondFixture();
	resetCellularSourcesForTest();
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	const devices = new Map<string, string>([
		[BOX_ETHERNET.ifname, BOX_ETHERNET.sysfs],
		...BOX_MODEMS.map((modem) => [modem.ifname, modem.sysfs] as const),
	]);
	setNonUsbNetEvidenceIoForTest(boxSysfs(devices));
	setModemIdPathReader(
		async () =>
			new Map(BOX_MODEMS.map((modem) => [modem.ifname, modem.idPath])),
	);
	await refreshModemIdPaths();
	setBondIdentityResolverForTest((ifname) => {
		const modem = BOX_MODEMS.find((row) => row.ifname === ifname);
		return resolvePhysicalDevice({
			ifname,
			...(modem
				? {
						idPath: modem.idPath,
						vid: "2c7c",
						...(modem.serial ? { serial: modem.serial } : {}),
					}
				: {}),
		});
	});
	for (const modem of BOX_MODEMS)
		setModem(modem.id, {
			ifname: modem.ifname,
			name: "Synthetic LTE modem",
			sim_network: "",
			network_type: { supported: {}, active: null },
			// The profile a newly seen modem gets once its connection exists.
			config: {
				conn: modem.uuid,
				autoconfig: true,
				apn: "internet",
				username: "",
				password: "",
				roaming: true,
				network: "",
			},
		});
	processIfconfigOutput(
		[
			stanza(BOX_ETHERNET.ifname, BOX_ETHERNET.ip),
			...BOX_MODEMS.map((modem) => stanza(modem.ifname, modem.ip)),
		].join("\n\n"),
	);
	netIfBuildMsg();
	const sessions: CellularRuntimeSession[] = [];
	let now = 0;
	const byIfname = (ifname: string) => {
		const modem = BOX_MODEMS.find((row) => row.ifname === ifname);
		if (!modem) throw new Error(`Fixture has no modem ${ifname}`);
		return modem;
	};
	setCellularRuntimeHostIoForTest({
		now: () => now,
		mocked: () => false,
		bootId: async () => "11111111-1111-4111-8111-111111111111",
		lifetime: () => ({
			current: true,
			start: settled,
			close: settled,
			select: () => true,
			owner: (service) =>
				service === "org.freedesktop.NetworkManager" ? NM_OWNER : MM_OWNER,
		}),
		readTarget: async (id, key) => {
			const modem = BOX_MODEMS.find((row) => row.id === id);
			return modem && key === boxModemKey(modem)
				? target(modem, key)
				: undefined;
		},
		targetPresent: async () => true,
		connFields: (async (uuid: string) => {
			const modem = BOX_MODEMS.find((row) => row.uuid === uuid);
			return modem
				? [`device-${modem.id}`, `sim-${modem.id}`, "yes", "internet"]
				: undefined;
		}) as CellularRuntimeHostIo["connFields"],
		carrierIntent: async () => undefined,
		activationReady: async () => true,
		readBearer: async (row): Promise<NativeBearerSnapshot> => ({
			path: `/org/freedesktop/ModemManager1/Bearer/${row.id}`,
			iface: row.ifname,
			ipv4: {
				family: 4,
				method: "static",
				address: byIfname(row.ifname).ip,
				gateway: byIfname(row.ifname).ip.replace(/\.2$/, ".1"),
				prefix: 30,
				mtu: 1428,
				dns: ["192.0.2.53"],
			},
		}),
		readNmIp: async (row): Promise<CellularNmIpSnapshot> => ({
			service: NM_OWNER,
			device: `/org/freedesktop/NetworkManager/Devices/${row.id}`,
			active: `/org/freedesktop/NetworkManager/ActiveConnection/${row.id}`,
			ipv4Path: `/org/freedesktop/NetworkManager/IP4Config/${row.id}`,
			ipv6Path: "/",
			ipv4: {
				addresses: [{ address: byIfname(row.ifname).ip, prefix: 30 }],
				gateway: byIfname(row.ifname).ip.replace(/\.2$/, ".1"),
				dns: ["192.0.2.53"],
			},
		}),
		kernelAddresses: async (ifname) => [
			{
				ifname,
				ifindex: 10 + byIfname(ifname).id,
				mtu: 1500,
				flags: ["UP", "LOWER_UP"],
				addr_info: [
					{
						family: "inet",
						local: byIfname(ifname).ip,
						prefixlen: 30,
						scope: "global",
						preferred_life_time: "forever",
					},
				],
			},
		],
		reconnect: async () => false,
		senderCapable: async () => true,
		reserve: async () => ({ remaining: 1024 * 1024 }),
		// The kernel owner is the one layer a host test cannot run. This stand-in
		// keeps the real session state machine and answers every probe healthy.
		session: (grant, slot, _owner, epoch, deps) => {
			const iface = grant.physical.ifname,
				session = new CellularRuntimeSession(grant, slot, epoch, {
					current: deps.current,
					currentNow: deps.currentNow,
					withdraw: deps.withdraw,
					bootstrap: async () => undefined,
					consumersReleased: async () => true,
					host: async () => ({
						binding: {
							source: grant.source,
							device: iface,
							generation: epoch,
							translated: false,
						},
						dns: { source: grant.source, device: iface, dns: grant.dns },
						install: settled,
						valid: async () => deps.currentNow(),
						prepareProbe: async () => true,
						setReady: async () => true,
						cancelProbe: () => {
							/* No probe outlives its call here. */
						},
						cleanup: async () => true,
					}),
					dns: async () => ({ ok: true }),
					https: async () => "ok",
					httpsPath: async () => ({
						source: grant.source,
						device: iface,
						ifindex: Number(grant.physical.ifindex),
					}),
				});
			sessions.push(session);
			return session;
		},
		...io,
	});
	initCellularRuntimeAdmission();
	return {
		sessions,
		bond: () =>
			genSrtlaBondEntries()
				.map((entry) => entry.iface)
				.sort(),
		expectedBond: () =>
			[BOX_ETHERNET.ifname, ...BOX_MODEMS.map((modem) => modem.ifname)].sort(),
		advance: (ms) => {
			now += ms;
		},
		setSysfs: (ifname, device) => {
			if (device === undefined) devices.delete(ifname);
			else devices.set(ifname, device);
		},
		close: () => {
			for (const modem of BOX_MODEMS) removeModem(modem.id);
			setCellularRuntimeHostIoForTest(null);
			setNonUsbNetEvidenceIoForTest(null);
			setModemIdPathReader(null);
			clearBondNetworkFixture();
			resetBondFixture();
			resetCellularSourcesForTest();
			resetRecoveryBarrier();
			resetLifecycleInterlock();
		},
	};
}
