import { describe, expect, test } from "bun:test";
import { memoryCloneRegistry } from "./clone-registry.ts";
import type { ActionGate } from "./coordinator.ts";
import {
	type BoundDevice,
	bindDevice,
	channelOf,
	type NmBus,
	systemNmBus,
} from "./nm-bus.ts";
import {
	apOnPhyOf,
	createSearchNm,
	parseCloneUuid,
	parseIwDev,
	parseIwLink,
	parseScanRows,
	searchProfileName,
	splitTerse,
	subnetOf,
	sweepOwnedClones,
	unescapeNmcli,
} from "./nm-port.ts";
import type { ScanRow } from "./policy.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CLONE = "33333333-3333-4333-8333-333333333333";
const MAC = "02:00:00:00:00:0b";
const STALE = "55555555-5555-4555-8555-555555555555";

describe("parsers", () => {
	test("iw link, associated and not", () => {
		expect(
			parseIwLink(
				"Connected to AA:00:00:00:00:02 (on wlan2)\n\tSSID: venue\n\tfreq: 2437\n\tsignal: -61 dBm\n",
			),
		).toEqual({ bssid: "aa:00:00:00:00:02", ssid: "venue", signalDbm: -61 });
		expect(parseIwLink("Not connected.\n")).toBeNull();
	});
	test("terse scan rows with escaped colons; bad rows dropped", () => {
		expect(
			parseScanRows(
				"AA\\:00\\:00\\:00\\:00\\:01:venue:70:1\nAA\\:00\\:00\\:00\\:00\\:02:venue:65:6\ngarbage\n",
			),
		).toEqual([
			{ bssid: "aa:00:00:00:00:01", ssid: "venue", quality: 70, channel: 1 },
			{ bssid: "aa:00:00:00:00:02", ssid: "venue", quality: 65, channel: 6 },
		]);
	});
	test("clone output names the new UUID last", () => {
		expect(
			parseCloneUuid(
				`venue (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`,
			),
		).toBe(CLONE);
		expect(parseCloneUuid("Error: nope")).toBeUndefined();
	});
	test("subnets", () => {
		expect(subnetOf("192.0.2.17/24")).toBe("192.0.2.0/24");
		expect(subnetOf("192.0.2.17/32")).toBe("192.0.2.17/32");
		expect(subnetOf("nonsense")).toBeNull();
	});
	test("iw dev: phys, interfaces and AP legs", () => {
		const devs = parseIwDev(IW_DEV_HYBRID);
		expect(devs.get("wlan1")).toEqual({ phy: "phy1", type: "managed" });
		expect(devs.get("clap-wlan1")).toEqual({ phy: "phy1", type: "AP" });
		expect(apOnPhyOf(devs, "wlan1")).toEqual({ phy: "phy1", apOnPhy: true });
		expect(apOnPhyOf(devs, "wlan2")).toEqual({ phy: "phy2", apOnPhy: false });
		expect(apOnPhyOf(devs, "wlan0")).toEqual({ phy: "phy0", apOnPhy: true });
		expect(apOnPhyOf(devs, "wlan9")).toEqual({ phy: null, apOnPhy: null });
	});
	test("owned profile names are per radio and validated", () => {
		expect(searchProfileName("wlan2")).toBe("ceraui-search-wlan2");
		expect(() => searchProfileName("-x")).toThrow();
	});
});

const IW_DEV_HYBRID = `phy#2
	Interface wlan2
		ifindex 6
		addr 02:00:00:00:00:0b
		type managed
phy#1
	Interface clap-wlan1
		ifindex 7
		addr 02:00:00:00:00:0c
		ssid box-hotspot
		type AP
	Interface wlan1
		ifindex 5
		addr 02:00:00:00:00:0a
		ssid venue
		type managed
phy#0
	Interface wlan0
		ifindex 4
		type AP
`;

/** Answers nmcli/ip/iw from a table; records every call. */
function fakeRun(fail: (args: string[]) => boolean = () => false) {
	const calls: string[] = [];
	const run = async (bin: string, args: string[]) => {
		const line = `${bin} ${args.join(" ")}`;
		calls.push(line);
		if (fail(args)) throw new Error("failed");
		if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
			return `venue:${SOURCE}:802-11-wireless\nvenue:${OTHER}:802-11-wireless\nwired:44444444-4444-4444-8444-444444444444:802-3-ethernet\n`;
		if (
			line.startsWith("nmcli -g 802-11-wireless.ssid") &&
			line.endsWith(SOURCE)
		)
			return `venue\n${MAC.replace(/:/g, "\\:")}\n\n`;
		if (
			line.startsWith("nmcli -g 802-11-wireless.ssid") &&
			line.endsWith(OTHER)
		)
			return "venue\n02\\:00\\:00\\:00\\:00\\:0a\n\n";
		if (line === "iw dev") return IW_DEV_HYBRID;
		if (line === "nmcli -t -f NAME,UUID connection show")
			return `ceraui-search-wlan2:${STALE}\nceraui-search-wlan2:${CLONE}\nvenue:${SOURCE}\n`;
		if (line.startsWith("nmcli connection clone"))
			return `venue (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`;
		return "";
	};
	return { run, calls };
}

describe("hotspot mode", () => {
	test("observe reports the phy and an AP leg on it", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(await nm.observe("wlan1")).toMatchObject({
			phy: "phy1",
			apOnPhy: true,
		});
		expect(await nm.observe("wlan2")).toMatchObject({
			phy: "phy2",
			apOnPhy: false,
		});
	});
	test("an unreadable interface list leaves the mode unknown", async () => {
		const f = fakeRun((args) => args.length === 1 && args[0] === "dev");
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(await nm.observe("wlan2")).toMatchObject({ apOnPhy: null });
	});
});

describe("active-profile listing", () => {
	test("an unreadable listing is reported as unread, not as nothing active", async () => {
		const f = fakeRun((args) => args.includes("--active"));
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(await nm.observe("wlan2")).toMatchObject({
			activation: null,
			activationRead: false,
		});
	});

	test("a readable listing with nothing on the radio is read and empty", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(await nm.observe("wlan2")).toMatchObject({
			activation: null,
			activationRead: true,
		});
	});
});

describe("reads and late checks", () => {
	test("observe uses iw link, nmcli listings without rescan, and ip", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		await nm.observe("wlan1");
		expect(f.calls.some((c) => /rescan|scan/.test(c))).toBe(false);
	});

	test("terse fields: escaped colons and backslashes, both sides alike", () => {
		expect(splitTerse("a\\\\b:c\\:d:e")).toEqual(["a\\b", "c:d", "e"]);
		// A field that ends in a literal backslash, then a separator.
		expect(splitTerse("x\\\\:y")).toEqual(["x\\", "y"]);
		expect(unescapeNmcli("a\\\\b\\:c")).toBe("a\\b:c");
	});

	test("radioMode reads iw dev only", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(await nm.radioMode("wlan1")).toEqual({ phy: "phy1", apOnPhy: true });
		expect(f.calls).toEqual(["iw dev"]);
	});
});

const IFINDEX = 6;
const DEVICE = "/org/freedesktop/NetworkManager/Devices/3";
const ACTIVE_PATH = "/org/freedesktop/NetworkManager/ActiveConnection/9";
const LIFETIME = `${IFINDEX}:2:/sys/devices/platform/usb1/1-1`;

/** A gate for the radio with MAC on ifindex 6, live until `stop()`. */
function gate(over: Partial<ActionGate> = {}) {
	let live = true;
	const g: ActionGate & { stop(): void } = {
		expected: { id: MAC, lifetime: LIFETIME },
		live: () => live,
		...over,
		stop: () => {
			live = false;
		},
	};
	return g;
}

/** NetworkManager on D-Bus as the port sees it: one device per incarnation. */
class FakeBus implements NmBus {
	calls: string[] = [];
	/** Device incarnations NetworkManager knows, by object path. */
	devices = new Map([[DEVICE, { ifindex: IFINDEX, mac: MAC }]]);
	lastScanAt = 10n;
	/** Whether a requested scan finishes (LastScan moves). */
	scanFinishes = true;
	aps: ScanRow[] = [];
	active: { path: string; uuid: string } | null = null;
	/** Active-connection states read after activation, in order. */
	states: number[] = [2];
	onBind: (() => void) | null = null;
	async withDevice<T>(
		radio: { ifname: string; ifindex: number; mac: string },
		fn: (device: BoundDevice) => Promise<T>,
	): Promise<T | undefined> {
		this.calls.push(`bind ${radio.ifindex} ${radio.mac}`);
		this.onBind?.();
		const path = [...this.devices].find(
			([, d]) => d.ifindex === radio.ifindex && d.mac === radio.mac,
		)?.[0];
		if (!path) return undefined;
		return fn({
			path,
			lastScan: async () => this.lastScanAt,
			requestScan: async () => {
				this.calls.push(`RequestScan ${path}`);
				if (this.scanFinishes) this.lastScanAt++;
				return true;
			},
			accessPoints: async () => this.aps,
			activate: async (uuid) => {
				this.calls.push(`Activate ${uuid} ${path}`);
				return ACTIVE_PATH;
			},
			activeState: async () => this.states.shift() ?? 2,
			active: async () => this.active,
			deactivate: async (active) => {
				this.calls.push(`Deactivate ${active}`);
				return true;
			},
		});
	}
}

function port(
	over: Partial<Parameters<typeof createSearchNm>[0]> = {},
	f = fakeRun(),
	bus = new FakeBus(),
) {
	const clones = over.clones ?? memoryCloneRegistry();
	const nm = createSearchNm({
		run: f.run,
		macOf: async () => MAC,
		clones,
		bus,
		pollMs: 1,
		joinWaitMs: 30,
		scanTimeoutMs: 30,
		...over,
	});
	return { nm, f, bus, clones };
}

const nmWrites = (calls: string[]) =>
	calls.filter((c) => /clone|modify| up |delete|rescan/.test(c));

describe("device binding over D-Bus", () => {
	const OWNER = ":1.42";
	const OTHER_DEVICE = "/org/freedesktop/NetworkManager/Devices/4";
	type Call = {
		destination: string;
		path: string;
		member: string;
		args?: readonly unknown[];
	};
	function transport(
		opts: { gone?: Set<string>; owner?: string; names?: [string, string] } = {},
	) {
		const [nameA, nameB] = opts.names ?? ["wlan5", "wlan2"];
		const calls: Call[] = [];
		const v = (signature: string, value: unknown) => ({ signature, value });
		return {
			calls,
			connect: async () => undefined,
			disconnect: async () => undefined,
			callMethod: async (c: {
				destination: string;
				path: string;
				interface: string;
				member: string;
				args?: readonly unknown[];
			}) => {
				calls.push({
					destination: c.destination,
					path: c.path,
					member: c.member,
					...(c.args ? { args: c.args } : {}),
				});
				// NetworkManager refuses a vanished device as the target object and
				// as an argument (ActivateConnection's device).
				if (opts.gone?.has(c.path))
					throw new Error("org.freedesktop.DBus.Error.UnknownObject");
				if (c.args?.some((a) => typeof a === "string" && opts.gone?.has(a)))
					throw new Error("org.freedesktop.NetworkManager.UnknownDevice");
				if (c.member === "GetNameOwner")
					return { signature: "s", body: [opts.owner ?? OWNER] };
				if (c.member === "GetDevices")
					return { signature: "ao", body: [[DEVICE, OTHER_DEVICE]] };
				if (
					c.member === "GetAll" &&
					c.args?.[0] === "org.freedesktop.NetworkManager.Device"
				)
					return {
						signature: "a{sv}",
						body: [
							[
								["Interface", v("s", c.path === DEVICE ? nameA : nameB)],
								["DeviceType", v("u", 2)],
							],
						],
					};
				if (c.member === "Get" && c.args?.[1] === "PermHwAddress")
					return { signature: "v", body: [v("s", MAC.toUpperCase())] };
				if (c.member === "Get" && c.args?.[1] === "LastScan")
					return { signature: "v", body: [v("x", 77n)] };
				if (c.member === "GetConnectionByUuid")
					return {
						signature: "o",
						body: ["/org/freedesktop/NetworkManager/Settings/12"],
					};
				if (c.member === "ActivateConnection")
					return { signature: "o", body: [ACTIVE_PATH] };
				return { signature: "", body: [] };
			},
		};
	}

	const target = { ifname: "wlan2", ifindex: IFINDEX, mac: MAC };
	const sysfs = (...reads: Array<number | undefined>) => {
		const seen: string[] = [];
		const read = async (ifname: string) => {
			seen.push(ifname);
			return reads.length > 1 ? reads.shift() : reads[0];
		};
		return Object.assign(read, { seen });
	};

	test("pins the kernel interface around the lookup, confirms the permanent MAC, then talks only to that device at NetworkManager's unique name", async () => {
		const t = transport();
		const ifindex = sysfs(IFINDEX);
		const device = await bindDevice(t, target, ifindex);
		expect(device?.path).toBe(OTHER_DEVICE);
		// The ifindex is read before and after NetworkManager is asked.
		expect(ifindex.seen).toEqual(["wlan2", "wlan2"]);
		expect(await device?.lastScan()).toBe(77n);
		expect(await device?.requestScan()).toBe(true);
		expect(await device?.activate(CLONE)).toBe(ACTIVE_PATH);
		const [owner, ...rest] = t.calls;
		expect(owner?.member).toBe("GetNameOwner");
		// Every call after the owner lookup goes to the unique name, not to
		// org.freedesktop.NetworkManager, and no call carries an interface name.
		expect(rest.every((c) => c.destination === OWNER)).toBe(true);
		expect(JSON.stringify(t.calls)).not.toContain("wlan");
		expect(rest.find((c) => c.member === "RequestScan")?.path).toBe(
			OTHER_DEVICE,
		);
		expect(rest.find((c) => c.member === "ActivateConnection")?.args).toEqual([
			"/org/freedesktop/NetworkManager/Settings/12",
			OTHER_DEVICE,
			"/",
		]);
	});

	test("binds to nothing when the name holds another kernel interface, the MAC differs, or a replug lands during the lookup", async () => {
		// A replug before the bind: the name is now another ifindex.
		expect(await bindDevice(transport(), target, sysfs(99))).toBeUndefined();
		// A replug during the lookup: the second read differs.
		expect(
			await bindDevice(transport(), target, sysfs(IFINDEX, IFINDEX + 1)),
		).toBeUndefined();
		expect(
			await bindDevice(
				transport(),
				{ ...target, mac: "02:00:00:00:00:99" },
				sysfs(IFINDEX),
			),
		).toBeUndefined();
		// The name gone from the kernel.
		expect(
			await bindDevice(transport(), target, sysfs(undefined)),
		).toBeUndefined();
	});

	test("two NetworkManager devices under one name (mid-replug) bind to nothing", async () => {
		expect(
			await bindDevice(
				transport({ names: ["wlan2", "wlan2"] }),
				target,
				sysfs(IFINDEX),
			),
		).toBeUndefined();
	});

	test("a device that vanished after binding fails the call; nothing is redirected", async () => {
		const gone = new Set<string>();
		const t = transport({ gone });
		const device = await bindDevice(t, target, sysfs(IFINDEX));
		gone.add(OTHER_DEVICE);
		expect(await device?.requestScan()).toBe(false);
		expect(await device?.activate(CLONE)).toBeUndefined();
		expect(await device?.active()).toBeUndefined();
	});

	test("the system bus runs nothing when the device is not there", async () => {
		let ran = false;
		const bus = systemNmBus(sysfs(99), async () => transport());
		expect(
			await bus.withDevice(target, async () => {
				ran = true;
				return 1;
			}),
		).toBeUndefined();
		expect(ran).toBe(false);
	});

	test("channels from centre frequencies", () => {
		expect(channelOf(2412)).toBe(1);
		expect(channelOf(2484)).toBe(14);
		expect(channelOf(5180)).toBe(36);
		expect(channelOf(5955)).toBe(1);
		expect(channelOf(1000)).toBeNull();
	});
});

describe("join", () => {
	test("clones the radio's own bound profile, records it, locks the BSSID, and activates it on the bound device only", async () => {
		const { nm, f, bus, clones } = port();
		expect(
			await nm.join("wlan2", "venue", "AA:00:00:00:00:02", gate()),
		).toEqual({
			activation: CLONE,
		});
		expect(nmWrites(f.calls)).toEqual([
			`nmcli connection clone --temporary ${SOURCE} ceraui-search-wlan2`,
			`nmcli connection modify --temporary ${CLONE} 802-11-wireless.bssid aa:00:00:00:00:02 connection.autoconnect no`,
		]);
		expect(bus.calls).toEqual([
			`bind ${IFINDEX} ${MAC}`,
			`Activate ${CLONE} ${DEVICE}`,
		]);
		expect(await clones.find(`${MAC}|${SOURCE}`)).toBe(CLONE);
		// The sibling's profile (bound to another MAC) is never the source.
		expect(f.calls.join("\n")).not.toContain(`clone --temporary ${OTHER}`);
	});

	test("a later join reuses the radio's clone of that profile", async () => {
		const clones = memoryCloneRegistry([
			{ uuid: CLONE, key: `${MAC}|${SOURCE}` },
		]);
		const { nm, f, bus } = port({ clones });
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:03", gate()),
		).toEqual({
			activation: CLONE,
		});
		expect(nmWrites(f.calls)).toEqual([
			`nmcli connection modify --temporary ${CLONE} 802-11-wireless.bssid aa:00:00:00:00:03 connection.autoconnect no`,
		]);
		expect(bus.calls.at(-1)).toBe(`Activate ${CLONE} ${DEVICE}`);
	});

	test("a recorded clone NetworkManager no longer has is forgotten and cloned afresh", async () => {
		const LOST = "99999999-9999-4999-8999-999999999999";
		const clones = memoryCloneRegistry([
			{ uuid: LOST, key: `${MAC}|${SOURCE}` },
		]);
		const f = fakeRun((args) => args.includes(LOST));
		const { nm } = port({ clones }, f);
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", gate()),
		).toEqual({
			activation: CLONE,
		});
		expect(await clones.list()).toEqual([CLONE]);
	});

	test("owned clones are never a source: not by owned name, not by record", async () => {
		const f = fakeRun();
		const run = async (bin: string, args: string[]) => {
			if (args.join(" ") === "-t -f NAME,UUID,TYPE connection show")
				return `ceraui-search-wlan9:${STALE}:802-11-wireless\nvenue:${OTHER}:802-11-wireless\n`;
			if (args.join(" ").startsWith("-g 802-11-wireless.ssid"))
				return `venue\n${MAC.replace(/:/g, "\\:")}\n\n`;
			return f.run(bin, args);
		};
		const { nm } = port({ run, clones: memoryCloneRegistry([OTHER]) });
		expect(await nm.savedSsids("wlan2")).toEqual(new Set());
	});

	test("a failed activation leaves the clone recorded and deletes nothing", async () => {
		const bus = new FakeBus();
		bus.states = [1, 4];
		const { nm, f, clones } = port({}, fakeRun(), bus);
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", gate()),
		).toBeUndefined();
		expect(f.calls.some((c) => c.includes("delete"))).toBe(false);
		expect(await clones.has(CLONE)).toBe(true);
	});

	test("an activation that does not settle in time is deactivated on the same device", async () => {
		const bus = new FakeBus();
		bus.states = Array(1000).fill(1);
		const { nm } = port({}, fakeRun(), bus);
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", gate()),
		).toBeUndefined();
		expect(bus.calls.at(-1)).toBe(`Deactivate ${ACTIVE_PATH}`);
	});

	test("no bound profile for the SSID: no write at all", async () => {
		const { nm, f, bus } = port();
		expect(
			await nm.join("wlan2", "elsewhere", "aa:00:00:00:00:02", gate()),
		).toBeUndefined();
		expect(nmWrites(f.calls)).toEqual([]);
		expect(bus.calls).toEqual([]);
	});

	test("a malformed BSSID is refused before any command", async () => {
		const { nm, f } = port();
		await expect(
			nm.join("wlan2", "venue", "aa:00:00:00:00", gate()),
		).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});

	test("a join refused at the last check never activates and deletes nothing", async () => {
		const { nm, f, bus } = port();
		expect(
			await nm.join(
				"wlan2",
				"venue",
				"aa:00:00:00:00:02",
				gate({ mayAct: async () => false }),
			),
		).toBe("refused");
		expect(bus.calls).toEqual([]);
		expect(f.calls.some((c) => c.includes("delete"))).toBe(false);
	});

	test("a saved SSID with a colon matches the scan's unescaped SSID", async () => {
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
				return `cafe\\:2:${SOURCE}:802-11-wireless\n`;
			if (line.startsWith("nmcli -g 802-11-wireless.ssid"))
				return `cafe\\:2\n${MAC.replace(/:/g, "\\:")}\n\n`;
			if (line.startsWith("nmcli connection clone"))
				return `cafe:2 (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`;
			return "";
		};
		const { nm } = port({ run });
		expect([...(await nm.savedSsids("wlan2"))]).toEqual(["cafe:2"]);
		expect(
			await nm.join("wlan2", "cafe:2", "aa:00:00:00:00:02", gate()),
		).toEqual({
			activation: CLONE,
		});
	});
});

describe("scan", () => {
	test("requests a scan on the bound device, waits for it to finish, and reads that device's access points", async () => {
		const bus = new FakeBus();
		bus.aps = [
			{ bssid: "aa:00:00:00:00:02", ssid: "venue", quality: 70, channel: 36 },
		];
		const { nm, f } = port({}, fakeRun(), bus);
		expect(await nm.scan("wlan2", gate())).toEqual(bus.aps);
		expect(bus.calls).toEqual([
			`bind ${IFINDEX} ${MAC}`,
			`RequestScan ${DEVICE}`,
		]);
		// No nmcli rescan by interface name.
		expect(f.calls.some((c) => c.includes("rescan"))).toBe(false);
	});

	test("a scan that never finishes is a failed scan", async () => {
		const bus = new FakeBus();
		bus.scanFinishes = false;
		const { nm } = port({}, fakeRun(), bus);
		expect(await nm.scan("wlan2", gate())).toBeUndefined();
	});

	test("a scan SSID with a backslash matches the saved profile", async () => {
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
				return `cafe\\\\2:${SOURCE}:802-11-wireless\n`;
			if (line.startsWith("nmcli -g 802-11-wireless.ssid"))
				return `cafe\\\\2\n${MAC.replace(/:/g, "\\:")}\n\n`;
			return "";
		};
		const bus = new FakeBus();
		bus.aps = [
			{ bssid: "aa:00:00:00:00:02", ssid: "cafe\\2", quality: 70, channel: 6 },
		];
		const { nm } = port({ run }, fakeRun(), bus);
		const rows = await nm.scan("wlan2", gate());
		expect(await nm.savedSsids("wlan2")).toEqual(
			new Set([rows?.[0]?.ssid ?? "?"]),
		);
	});
});

describe("abandon", () => {
	test("deactivates the clone on the bound device when it is the active connection; the clone stays recorded", async () => {
		const bus = new FakeBus();
		bus.active = { path: ACTIVE_PATH, uuid: CLONE };
		const clones = memoryCloneRegistry([CLONE]);
		const { nm, f } = port({ clones }, fakeRun(), bus);
		expect(await nm.abandon("wlan2", CLONE, gate())).toBe(true);
		expect(bus.calls).toEqual([
			`bind ${IFINDEX} ${MAC}`,
			`Deactivate ${ACTIVE_PATH}`,
		]);
		expect(f.calls.some((c) => c.includes("delete"))).toBe(false);
		expect(await clones.has(CLONE)).toBe(true);
	});

	test("nothing to do when something else is active", async () => {
		const bus = new FakeBus();
		bus.active = { path: ACTIVE_PATH, uuid: SOURCE };
		const { nm } = port(
			{ clones: memoryCloneRegistry([CLONE]) },
			fakeRun(),
			bus,
		);
		expect(await nm.abandon("wlan2", CLONE, gate())).toBe(true);
		expect(bus.calls.some((c) => c.startsWith("Deactivate"))).toBe(false);
	});

	test("an operator profile that only shares the clone's name is never touched", async () => {
		const bus = new FakeBus();
		bus.active = { path: ACTIVE_PATH, uuid: STALE };
		const { nm } = port({}, fakeRun(), bus);
		expect(await nm.abandon("wlan2", STALE, gate())).toBe(false);
		expect(bus.calls).toEqual([]);
	});
});

describe("boot sweep", () => {
	const ORPHAN = "55555555-5555-4555-8555-555555555555";
	const LIVE = "66666666-6666-4666-8666-666666666666";
	const OPERATOR = "77777777-7777-4777-8777-777777777777";
	const GONE = "88888888-8888-4888-8888-888888888888";
	const MISNAMED = "99999999-9999-4999-8999-999999999999";
	const table = (listFails = false) => {
		const calls: string[] = [];
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			calls.push(line);
			if (line === "nmcli -t -f NAME,UUID connection show") {
				if (listFails) throw new Error("failed");
				return `ceraui-search-wlan7:${ORPHAN}\nceraui-search-wlan2:${LIVE}\nceraui-search-wlan9:${OPERATOR}\nvenue:${MISNAMED}\n`;
			}
			return "";
		};
		return { run, calls };
	};
	const deletes = (calls: string[]) =>
		calls.filter((c) => c.includes("connection delete"));

	test("deletes every recorded clone under an owned name, active or not; never an unrecorded one", async () => {
		const t = table();
		const clones = memoryCloneRegistry([ORPHAN, LIVE, GONE, MISNAMED]);
		expect(await sweepOwnedClones(t.run, clones)).toBe(2);
		expect(deletes(t.calls)).toEqual([
			`nmcli connection delete uuid ${ORPHAN}`,
			`nmcli connection delete uuid ${LIVE}`,
		]);
		// No activity read at all: at boot nothing else can have activated one.
		expect(t.calls.some((c) => c.includes("--active"))).toBe(false);
		// Records of profiles that are gone, or not ours under that UUID, go too.
		expect(await clones.list()).toEqual([]);
	});

	test("starts no deletion after the deadline; what is left stays recorded", async () => {
		const t = table();
		let clock = 0;
		const run = async (bin: string, args: string[]) => {
			const out = await t.run(bin, args);
			clock += 10;
			return out;
		};
		const clones = memoryCloneRegistry([ORPHAN, LIVE]);
		expect(await sweepOwnedClones(run, clones, 15, () => clock)).toBe(1);
		expect(await clones.list()).toEqual([LIVE]);
	});

	test("an unreadable listing deletes nothing and keeps every record", async () => {
		const t = table(true);
		const clones = memoryCloneRegistry([ORPHAN]);
		expect(await sweepOwnedClones(t.run, clones)).toBe(0);
		expect(deletes(t.calls)).toEqual([]);
		expect(await clones.list()).toEqual([ORPHAN]);
	});

	test("nothing recorded: not even a listing", async () => {
		const t = table();
		expect(await sweepOwnedClones(t.run, memoryCloneRegistry())).toBe(0);
		expect(t.calls).toEqual([]);
	});
});

describe("the effect executor", () => {
	test("a stopped coordinator gets nothing dispatched, not even a bind", async () => {
		const { nm, bus } = port();
		const g = gate();
		g.stop();
		expect(await nm.scan("wlan2", g)).toBeUndefined();
		expect(bus.calls).toEqual([]);
	});

	test("stop during the identity read: no scan is requested", async () => {
		const g = gate();
		const { nm, bus } = port({
			identity: async () => {
				g.stop();
				return true;
			},
		});
		expect(await nm.scan("wlan2", g)).toBeUndefined();
		expect(bus.calls.some((c) => c.startsWith("RequestScan"))).toBe(false);
	});

	test("stop while the device is being bound: no scan is requested", async () => {
		const g = gate();
		const bus = new FakeBus();
		bus.onBind = () => g.stop();
		const { nm } = port({}, fakeRun(), bus);
		expect(await nm.scan("wlan2", g)).toBeUndefined();
		expect(bus.calls).toEqual([`bind ${IFINDEX} ${MAC}`]);
	});

	test("stop while the device is being bound: no activation", async () => {
		const g = gate();
		const bus = new FakeBus();
		bus.onBind = () => g.stop();
		const { nm } = port({}, fakeRun(), bus);
		expect(await nm.join("wlan2", "venue", "aa:00:00:00:00:02", g)).toBe(
			"refused",
		);
		expect(bus.calls).toEqual([`bind ${IFINDEX} ${MAC}`]);
	});

	test("a radio the registry no longer shows is never bound", async () => {
		const { nm, bus } = port({ identity: async () => false });
		expect(await nm.scan("wlan2", gate())).toBeUndefined();
		expect(bus.calls).toEqual([]);
	});

	test("a radio replaced after every check reaches nothing: NetworkManager has no device for its incarnation", async () => {
		const bus = new FakeBus();
		// The replug lands between the last check and the bind.
		bus.onBind = () => {
			bus.devices = new Map([
				[DEVICE.replace(/3$/, "8"), { ifindex: IFINDEX + 1, mac: MAC }],
			]);
		};
		const clones = memoryCloneRegistry([CLONE]);
		bus.active = { path: ACTIVE_PATH, uuid: CLONE };
		const { nm, f } = port({ clones }, fakeRun(), bus);
		expect(await nm.join("wlan2", "venue", "aa:00:00:00:00:02", gate())).toBe(
			"refused",
		);
		expect(await nm.abandon("wlan2", CLONE, gate())).toBe(false);
		expect(await nm.scan("wlan2", gate())).toBeUndefined();
		expect(bus.calls.filter((c) => !c.startsWith("bind"))).toEqual([]);
		expect(f.calls.some((c) => c.includes("delete"))).toBe(false);
	});

	test("an expectation without a lifetime binds nothing", async () => {
		const { nm, bus } = port();
		expect(
			await nm.scan("wlan2", gate({ expected: { id: MAC, lifetime: null } })),
		).toBeUndefined();
		expect(bus.calls).toEqual([]);
	});

	test("effects never interleave: each check is followed by its own command", async () => {
		const order: string[] = [];
		const bus = new FakeBus();
		const withDevice = bus.withDevice.bind(bus);
		bus.withDevice = async (radio, fn) => {
			order.push("bind");
			await Bun.sleep(1);
			return withDevice(radio, async (d) => {
				const out = await fn(d);
				order.push("done");
				return out;
			});
		};
		bus.active = { path: ACTIVE_PATH, uuid: CLONE };
		const { nm } = port(
			{
				identity: async () => {
					order.push("check");
					await Bun.sleep(1);
					return true;
				},
				clones: memoryCloneRegistry([CLONE]),
			},
			fakeRun(),
			bus,
		);
		await Promise.all([
			nm.abandon("wlan2", CLONE, gate()),
			nm.scan("wlan2", gate()),
			nm.abandon("wlan2", CLONE, gate()),
		]);
		expect(order).toEqual([
			"check",
			"bind",
			"done",
			"check",
			"bind",
			"done",
			"check",
			"bind",
			"done",
		]);
	});
});
