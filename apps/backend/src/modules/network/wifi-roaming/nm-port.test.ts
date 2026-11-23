import { describe, expect, test } from "bun:test";
import type { ActionGate } from "./coordinator.ts";
import {
	type BoundDevice,
	bindDevice,
	channelOf,
	EffectCancelled,
	type NmBus,
	systemNmBus,
} from "./nm-bus.ts";
import {
	apOnPhyOf,
	createSearchNm,
	parseIwDev,
	parseIwLink,
	parseScanRows,
	searchProfileName,
	splitTerse,
	subnetOf,
	unescapeNmcli,
} from "./nm-port.ts";
import type { ScanRow } from "./policy.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
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
		});
		expect(await nm.radioMode("wlan1")).toEqual({ phy: "phy1", apOnPhy: true });
		expect(f.calls).toEqual(["iw dev"]);
	});
});

const IFINDEX = 6;
const DEVICE = "/org/freedesktop/NetworkManager/Devices/3";
const ACTIVE_PATH = "/org/freedesktop/NetworkManager/ActiveConnection/9";
const LIFETIME = `${IFINDEX}:2:/sys/devices/platform/usb1/1-1`;
/** The UUID NetworkManager gives a volatile copy. */
const COPY = "33333333-3333-4333-8333-333333333333";

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

type Active = { path: string; uuid: string; id: string; volatile: boolean };
const ours = (uuid = COPY): Active => ({
	path: ACTIVE_PATH,
	uuid,
	id: "ceraui-search-wlan2",
	volatile: true,
});

/**
 * NetworkManager on D-Bus as the port sees it: one device per incarnation.
 * Like the real bus, every state change reads `live()` last and is not sent
 * once it says no.
 */
class FakeBus implements NmBus {
	calls: string[] = [];
	/** Device incarnations NetworkManager knows, by object path. */
	devices = new Map([[DEVICE, { ifindex: IFINDEX, mac: MAC }]]);
	lastScanAt = 10n;
	/** Whether a requested scan finishes (LastScan moves). */
	scanFinishes = true;
	aps: ScanRow[] = [];
	active: Active | null = null;
	/** Active-connection states read after activation, in order. */
	states: number[] = [2];
	onBind: (() => void) | null = null;
	/** Runs inside addAndActivate before its dispatch (a slow profile read). */
	beforeAdd: (() => void) | null = null;
	async withDevice<T>(
		radio: { ifname: string; ifindex: number; mac: string },
		live: () => boolean,
		fn: (device: BoundDevice) => Promise<T>,
	): Promise<T | undefined> {
		this.calls.push(`bind ${radio.ifindex} ${radio.mac}`);
		this.onBind?.();
		const path = [...this.devices].find(
			([, d]) => d.ifindex === radio.ifindex && d.mac === radio.mac,
		)?.[0];
		if (!path) return undefined;
		const send = (what: string) => {
			if (!live()) throw new EffectCancelled();
			this.calls.push(what);
		};
		try {
			return await fn({
				path,
				lastScan: async () => this.lastScanAt,
				requestScan: async () => {
					send(`RequestScan ${path}`);
					if (this.scanFinishes) this.lastScanAt++;
					return true;
				},
				accessPoints: async () => this.aps,
				addAndActivate: async (source, o) => {
					this.beforeAdd?.();
					send(`AddAndActivate ${source} ${o.id} ${o.bssid} ${path}`);
					return { active: ACTIVE_PATH, uuid: COPY };
				},
				activeState: async () => this.states.shift() ?? 2,
				active: async () => this.active,
				deactivate: async (active) => {
					send(`Deactivate ${active}`);
					return true;
				},
			});
		} catch (error) {
			if (error instanceof EffectCancelled) return undefined;
			throw error;
		}
	}
}

function port(
	over: Partial<Parameters<typeof createSearchNm>[0]> = {},
	f = fakeRun(),
	bus = new FakeBus(),
) {
	const nm = createSearchNm({
		run: f.run,
		macOf: async () => MAC,
		bus,
		pollMs: 1,
		joinWaitMs: 30,
		scanTimeoutMs: 30,
		...over,
	});
	return { nm, f, bus };
}

/** Any nmcli call that would change state: none is left in the design. */
const nmcliWrites = (calls: string[]) =>
	calls.filter((c) => /clone|modify| up |delete|rescan|add /.test(c));

describe("device binding over D-Bus", () => {
	const OWNER = ":1.42";
	const OTHER_DEVICE = "/org/freedesktop/NetworkManager/Devices/4";
	const SOURCE_PATH = "/org/freedesktop/NetworkManager/Settings/12";
	type Call = {
		destination: string;
		path: string;
		member: string;
		signature?: string;
		args?: readonly unknown[];
	};
	const v = (signature: string, value: unknown) => ({ signature, value });
	function transport(
		opts: {
			gone?: Set<string>;
			owner?: string;
			names?: [string, string];
			psk?: boolean;
			/** Runs when the source profile is looked up. */
			onLookup?: () => Promise<void> | void;
		} = {},
	) {
		const [nameA, nameB] = opts.names ?? ["wlan5", "wlan2"];
		const calls: Call[] = [];
		return {
			calls,
			connect: async () => undefined,
			disconnect: async () => undefined,
			callMethod: async (c: {
				destination: string;
				path: string;
				interface: string;
				member: string;
				signature?: string;
				args?: readonly unknown[];
			}) => {
				calls.push({
					destination: c.destination,
					path: c.path,
					member: c.member,
					...(c.signature ? { signature: c.signature } : {}),
					...(c.args ? { args: c.args } : {}),
				});
				// NetworkManager refuses a vanished device as the target object and
				// as an argument (the device AddAndActivateConnection2 is for).
				if (opts.gone?.has(c.path))
					throw new Error("org.freedesktop.DBus.Error.UnknownObject");
				if (c.args?.some((a) => typeof a === "string" && opts.gone?.has(a)))
					throw new Error("org.freedesktop.NetworkManager.UnknownDevice");
				switch (c.member) {
					case "GetNameOwner":
						return { signature: "s", body: [opts.owner ?? OWNER] };
					case "GetDevices":
						return { signature: "ao", body: [[DEVICE, OTHER_DEVICE]] };
					case "GetAll":
						if (c.args?.[0] === "org.freedesktop.NetworkManager.Device")
							return {
								signature: "a{sv}",
								body: [
									[
										["Interface", v("s", c.path === DEVICE ? nameA : nameB)],
										["DeviceType", v("u", 2)],
									],
								],
							};
						return {
							signature: "a{sv}",
							body: [
								[
									["Uuid", v("s", COPY)],
									["Id", v("s", "ceraui-search-wlan2")],
									["Connection", v("o", `${SOURCE_PATH}9`)],
								],
							],
						};
					case "Get":
						if (c.args?.[1] === "PermHwAddress")
							return { signature: "v", body: [v("s", MAC.toUpperCase())] };
						if (c.args?.[1] === "LastScan")
							return { signature: "v", body: [v("x", 77n)] };
						if (c.args?.[1] === "Uuid")
							return { signature: "v", body: [v("s", COPY)] };
						if (c.args?.[1] === "ActiveConnection")
							return { signature: "v", body: [v("o", ACTIVE_PATH)] };
						if (c.args?.[1] === "Flags")
							return { signature: "v", body: [v("u", 5)] };
						break;
					case "GetConnectionByUuid":
						await opts.onLookup?.();
						return { signature: "o", body: [SOURCE_PATH] };
					case "GetSettings":
						return {
							signature: "a{sa{sv}}",
							body: [
								[
									[
										"connection",
										[
											["id", v("s", "venue")],
											["uuid", v("s", SOURCE)],
											["type", v("s", "802-11-wireless")],
											["autoconnect", v("b", true)],
											["timestamp", v("t", 1n)],
										],
									],
									[
										"802-11-wireless",
										[
											["ssid", v("ay", new Uint8Array([118, 101]))],
											["mac-address", v("ay", new Uint8Array(6))],
										],
									],
									...(opts.psk
										? [
												[
													"802-11-wireless-security",
													[["key-mgmt", v("s", "wpa-psk")]],
												],
											]
										: []),
								],
							],
						};
					case "GetSecrets":
						return {
							signature: "a{sa{sv}}",
							body: [
								[["802-11-wireless-security", [["psk", v("s", "secret")]]]],
							],
						};
					case "AddAndActivateConnection2":
						return {
							signature: "ooa{sv}",
							body: [`${SOURCE_PATH}9`, ACTIVE_PATH, []],
						};
				}
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
	/** The settings sent to AddAndActivateConnection2, as plain maps. */
	const sentSettings = (calls: Call[]) => {
		const add = calls.find((c) => c.member === "AddAndActivateConnection2");
		const settings = add?.args?.[0] as Array<
			[string, Array<[string, { signature: string; value: unknown }]>]
		>;
		return new Map(settings.map(([k, vals]) => [k, new Map(vals)]));
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
		expect(
			await device?.addAndActivate(SOURCE, {
				id: "ceraui-search-wlan2",
				bssid: "aa:00:00:00:00:02",
			}),
		).toEqual({ active: ACTIVE_PATH, uuid: COPY });
		const [owner, ...rest] = t.calls;
		expect(owner?.member).toBe("GetNameOwner");
		// Every call after the owner lookup goes to the unique name, not to
		// org.freedesktop.NetworkManager, and no call carries an interface name.
		expect(rest.every((c) => c.destination === OWNER)).toBe(true);
		expect(
			t.calls.every(
				(c) => !c.path.includes("wlan") && !(c.args ?? []).includes("wlan2"),
			),
		).toBe(true);
		expect(rest.find((c) => c.member === "RequestScan")?.path).toBe(
			OTHER_DEVICE,
		);
		const add = rest.find((c) => c.member === "AddAndActivateConnection2");
		expect(add?.signature).toBe("a{sa{sv}}ooa{sv}");
		expect(add?.args?.slice(1, 3)).toEqual([OTHER_DEVICE, "/"]);
		expect(new Map(add?.args?.[3] as Array<[string, unknown]>)).toEqual(
			new Map([
				["persist", v("s", "volatile")],
				["bind-activation", v("s", "none")],
			]),
		);
	});

	test("a join's profile is a volatile copy: the source's settings without its UUID, renamed, BSSID-locked, autoconnect off", async () => {
		const t = transport();
		const device = await bindDevice(t, target, sysfs(IFINDEX));
		await device?.addAndActivate(SOURCE, {
			id: "ceraui-search-wlan2",
			bssid: "aa:00:00:00:00:02",
		});
		const sent = sentSettings(t.calls);
		const connection = sent.get("connection");
		expect(connection?.has("uuid")).toBe(false);
		expect(connection?.has("timestamp")).toBe(false);
		expect(connection?.get("id")).toEqual(v("s", "ceraui-search-wlan2"));
		expect(connection?.get("autoconnect")).toEqual(v("b", false));
		expect(connection?.get("type")).toEqual(v("s", "802-11-wireless"));
		const wireless = sent.get("802-11-wireless");
		expect(wireless?.get("bssid")).toEqual(
			v("ay", new Uint8Array([0xaa, 0, 0, 0, 0, 2])),
		);
		expect(wireless?.get("ssid")).toEqual(v("ay", new Uint8Array([118, 101])));
		// No secrets were asked for a profile without a security setting.
		expect(t.calls.some((c) => c.member === "GetSecrets")).toBe(false);
	});

	test("the source's secrets go into the copy; nothing is stored", async () => {
		const t = transport({ psk: true });
		const device = await bindDevice(t, target, sysfs(IFINDEX));
		await device?.addAndActivate(SOURCE, {
			id: "ceraui-search-wlan2",
			bssid: "aa:00:00:00:00:02",
		});
		expect(t.calls.find((c) => c.member === "GetSecrets")?.args).toEqual([
			"802-11-wireless-security",
		]);
		expect(sentSettings(t.calls).get("802-11-wireless-security")).toEqual(
			new Map([
				["key-mgmt", v("s", "wpa-psk")],
				["psk", v("s", "secret")],
			]),
		);
		// No AddConnection, Update or Save: the only write is the volatile add.
		expect(
			t.calls.filter((c) =>
				/^(AddConnection|AddConnection2|AddConnectionUnsaved|Update|Update2|Save|Delete|ActivateConnection)$/.test(
					c.member,
				),
			),
		).toEqual([]);
	});

	test("stop during the source lookup: AddAndActivateConnection2 is never sent", async () => {
		let live = true;
		const t = transport({
			onLookup: () => {
				live = false;
			},
		});
		const device = await bindDevice(t, target, sysfs(IFINDEX), () => live);
		await expect(
			device?.addAndActivate(SOURCE, {
				id: "ceraui-search-wlan2",
				bssid: "aa:00:00:00:00:02",
			}),
		).rejects.toBeInstanceOf(EffectCancelled);
		expect(t.calls.some((c) => c.member === "AddAndActivateConnection2")).toBe(
			false,
		);
	});

	test("stop is read right before a scan request and a deactivation too", async () => {
		const t = transport();
		const device = await bindDevice(t, target, sysfs(IFINDEX), () => false);
		await expect(device?.requestScan()).rejects.toBeInstanceOf(EffectCancelled);
		await expect(device?.deactivate(ACTIVE_PATH)).rejects.toBeInstanceOf(
			EffectCancelled,
		);
		expect(
			t.calls.filter((c) =>
				["RequestScan", "DeactivateConnection"].includes(c.member),
			),
		).toEqual([]);
	});

	test("the active connection reports whether its profile is a volatile one of ours", async () => {
		const device = await bindDevice(transport(), target, sysfs(IFINDEX));
		expect(await device?.active()).toEqual({
			path: ACTIVE_PATH,
			uuid: COPY,
			id: "ceraui-search-wlan2",
			volatile: true,
		});
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
		expect(
			await device?.addAndActivate(SOURCE, {
				id: "ceraui-search-wlan2",
				bssid: "aa:00:00:00:00:02",
			}),
		).toBeUndefined();
		expect(await device?.active()).toBeUndefined();
	});

	test("the system bus runs nothing when the device is not there, and a cancelled effect ends as nothing", async () => {
		let ran = false;
		const bus = systemNmBus(sysfs(99), async () => transport());
		expect(
			await bus.withDevice(
				target,
				() => true,
				async () => {
					ran = true;
					return 1;
				},
			),
		).toBeUndefined();
		expect(ran).toBe(false);
		const stopped = systemNmBus(sysfs(IFINDEX), async () => transport());
		expect(
			await stopped.withDevice(
				target,
				() => false,
				(d) => d.requestScan(),
			),
		).toBeUndefined();
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
	test("activates a volatile copy of the radio's own bound profile on the bound device; no nmcli write at all", async () => {
		const { nm, f, bus } = port();
		expect(
			await nm.join("wlan2", "venue", "AA:00:00:00:00:02", gate()),
		).toEqual({ activation: COPY });
		expect(nmcliWrites(f.calls)).toEqual([]);
		expect(bus.calls).toEqual([
			`bind ${IFINDEX} ${MAC}`,
			`AddAndActivate ${SOURCE} ceraui-search-wlan2 aa:00:00:00:00:02 ${DEVICE}`,
		]);
		// The sibling's profile (bound to another MAC) is never the source.
		expect(bus.calls.join("\n")).not.toContain(OTHER);
	});

	test("owned copies are never a source", async () => {
		const f = fakeRun();
		const run = async (bin: string, args: string[]) => {
			if (args.join(" ") === "-t -f NAME,UUID,TYPE connection show")
				return `ceraui-search-wlan9:${STALE}:802-11-wireless\n`;
			if (args.join(" ").startsWith("-g 802-11-wireless.ssid"))
				return `venue\n${MAC.replace(/:/g, "\\:")}\n\n`;
			return f.run(bin, args);
		};
		const { nm } = port({ run });
		expect(await nm.savedSsids("wlan2")).toEqual(new Set());
	});

	test("a failed activation is a failed join; nothing is deleted or deactivated", async () => {
		const bus = new FakeBus();
		bus.states = [1, 4];
		const { nm, f } = port({}, fakeRun(), bus);
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", gate()),
		).toBeUndefined();
		expect(nmcliWrites(f.calls)).toEqual([]);
		expect(bus.calls.some((c) => c.startsWith("Deactivate"))).toBe(false);
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

	test("no bound profile for the SSID: nothing is bound or sent", async () => {
		const { nm, f, bus } = port();
		expect(
			await nm.join("wlan2", "elsewhere", "aa:00:00:00:00:02", gate()),
		).toBeUndefined();
		expect(nmcliWrites(f.calls)).toEqual([]);
		expect(bus.calls).toEqual([]);
	});

	test("a malformed BSSID is refused before any command", async () => {
		const { nm, f } = port();
		await expect(
			nm.join("wlan2", "venue", "aa:00:00:00:00", gate()),
		).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});

	test("a join refused at the last check creates nothing", async () => {
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
		expect(nmcliWrites(f.calls)).toEqual([]);
	});

	test("a saved SSID with a colon matches the scan's unescaped SSID", async () => {
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
				return `cafe\\:2:${SOURCE}:802-11-wireless\n`;
			if (line.startsWith("nmcli -g 802-11-wireless.ssid"))
				return `cafe\\:2\n${MAC.replace(/:/g, "\\:")}\n\n`;
			return "";
		};
		const { nm } = port({ run });
		expect([...(await nm.savedSsids("wlan2"))]).toEqual(["cafe:2"]);
		expect(
			await nm.join("wlan2", "cafe:2", "aa:00:00:00:00:02", gate()),
		).toEqual({ activation: COPY });
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
	test("deactivates our volatile copy on the bound device when it is the active connection", async () => {
		const bus = new FakeBus();
		bus.active = ours();
		const { nm, f } = port({}, fakeRun(), bus);
		expect(await nm.abandon("wlan2", COPY, gate())).toBe(true);
		expect(bus.calls).toEqual([
			`bind ${IFINDEX} ${MAC}`,
			`Deactivate ${ACTIVE_PATH}`,
		]);
		expect(nmcliWrites(f.calls)).toEqual([]);
	});

	test("nothing to do when something else is active", async () => {
		const bus = new FakeBus();
		bus.active = { ...ours(SOURCE), id: "venue", volatile: false };
		const { nm } = port({}, fakeRun(), bus);
		expect(await nm.abandon("wlan2", COPY, gate())).toBe(true);
		expect(bus.calls.some((c) => c.startsWith("Deactivate"))).toBe(false);
	});

	test("a stored profile is never deactivated, even under the same UUID or an owned name", async () => {
		const bus = new FakeBus();
		bus.active = { ...ours(STALE), volatile: false };
		const { nm } = port({}, fakeRun(), bus);
		expect(await nm.abandon("wlan2", STALE, gate())).toBe(true);
		bus.active = { ...ours(STALE), id: "venue" };
		expect(await nm.abandon("wlan2", STALE, gate())).toBe(true);
		expect(bus.calls.some((c) => c.startsWith("Deactivate"))).toBe(false);
	});

	test("an unreadable active connection does nothing and reports it", async () => {
		const bus = new FakeBus();
		const { nm } = port({}, fakeRun(), bus);
		bus.active = undefined as unknown as null;
		const active = bus.withDevice.bind(bus);
		bus.withDevice = (radio, live, fn) =>
			active(radio, live, (d) => fn({ ...d, active: async () => undefined }));
		expect(await nm.abandon("wlan2", COPY, gate())).toBe(false);
		expect(bus.calls.some((c) => c.startsWith("Deactivate"))).toBe(false);
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

	test("stop while the source profile is read: no activation, and the join ends as refused", async () => {
		const g = gate();
		const bus = new FakeBus();
		bus.beforeAdd = () => g.stop();
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
		bus.active = ours();
		const { nm, f } = port({}, fakeRun(), bus);
		expect(await nm.join("wlan2", "venue", "aa:00:00:00:00:02", gate())).toBe(
			"refused",
		);
		expect(await nm.abandon("wlan2", COPY, gate())).toBe(false);
		expect(await nm.scan("wlan2", gate())).toBeUndefined();
		expect(bus.calls.filter((c) => !c.startsWith("bind"))).toEqual([]);
		expect(nmcliWrites(f.calls)).toEqual([]);
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
		bus.withDevice = async (radio, live, fn) => {
			order.push("bind");
			await Bun.sleep(1);
			return withDevice(radio, live, async (d) => {
				const out = await fn(d);
				order.push("done");
				return out;
			});
		};
		bus.active = ours();
		const { nm } = port(
			{
				identity: async () => {
					order.push("check");
					await Bun.sleep(1);
					return true;
				},
			},
			fakeRun(),
			bus,
		);
		await Promise.all([
			nm.abandon("wlan2", COPY, gate()),
			nm.scan("wlan2", gate()),
			nm.abandon("wlan2", COPY, gate()),
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
