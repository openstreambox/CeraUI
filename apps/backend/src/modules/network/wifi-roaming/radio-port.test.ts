import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../../tests/helpers/wifi-registry.ts";
import {
	type SeedRadio,
	seedWifiRadios,
} from "../../../tests/helpers/wifi-verified-radios.ts";
import { admitWifiAdapter } from "../../wifi/wifi-adapter-admission.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../../wifi/wifi-connections.ts";
import type { WifiInterface } from "../../wifi/wifi-interfaces.ts";
import {
	apOnPhyOf,
	createRadioPort,
	parseIwDev,
	parseIwLink,
	type RadioPortDeps,
} from "./radio-port.ts";

const MAC1 = "02:00:00:00:d0:01";
const MAC2 = "02:00:00:00:d0:02";
const CONN = "11111111-1111-4111-8111-111111111111";

const IW_DEV = `phy#5
	Interface wlan1
		ifindex 51
		type managed
phy#6
	Interface clap-wlan2
		ifindex 62
		type AP
	Interface wlan2
		ifindex 61
		type managed
`;
const LINK = `Connected to AA:00:00:00:00:01 (on wlan1)
	SSID: venue
	freq: 5180
	signal: -63 dBm
`;

const station = (over: Partial<SeedRadio> = {}): SeedRadio => ({
	ifname: "wlan1",
	mac: MAC1,
	ifindex: 51,
	phy: 5,
	row: { conn: CONN, activeMode: "infrastructure" } as Partial<WifiInterface>,
	...over,
});

/** Answers `iw` from a table and records every command. */
function fakeIw(answers: Record<string, string | Error> = {}) {
	const calls: string[] = [];
	const loud: string[] = [];
	const run = async (
		bin: string,
		args: string[],
		opts?: { timeout?: number; quiet?: boolean },
	) => {
		const line = `${bin} ${args.join(" ")}`;
		calls.push(line);
		if (opts?.quiet !== true) loud.push(line);
		const answer =
			answers[line] ??
			(line === "iw dev" ? IW_DEV : line.endsWith(" link") ? LINK : "");
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { run, calls, loud };
}

describe("parsers", () => {
	test("iw link, associated and not", () => {
		expect(parseIwLink(LINK)).toEqual({
			bssid: "aa:00:00:00:00:01",
			ssid: "venue",
			signalDbm: -63,
		});
		expect(parseIwLink("Not connected.\n")).toBeNull();
	});
	test("iw dev: phys, interfaces and AP legs", () => {
		const devs = parseIwDev(IW_DEV);
		expect(devs.get("clap-wlan2")).toEqual({ phy: "phy6", type: "AP" });
		expect(apOnPhyOf(devs, "wlan1")).toEqual({ phy: "phy5", apOnPhy: false });
		expect(apOnPhyOf(devs, "wlan2")).toEqual({ phy: "phy6", apOnPhy: true });
		expect(apOnPhyOf(devs, "wlan9")).toEqual({ phy: null, apOnPhy: null });
	});
});

describe("radios as the observer reads them", () => {
	let inherited: ReturnType<typeof isolateWifiRegistry>;
	let seed: Awaited<ReturnType<typeof seedWifiRadios>>;

	beforeEach(async () => {
		inherited = isolateWifiRegistry();
		seed = await seedWifiRadios();
	});
	afterEach(async () => {
		await seed.restore();
		restoreWifiRegistry(inherited);
	});

	let clock = 0;
	const port = (
		iw = fakeIw(),
		exclude: ReadonlySet<string> = new Set(),
		over: Partial<RadioPortDeps> = {},
	) =>
		createRadioPort({
			run: iw.run,
			now: () => clock,
			rows: getWifiInterfacesByMacAddress,
			admit: (key) => admitWifiAdapter(key),
			exclude,
			...over,
		});

	test("an admitted station: physical id, NetworkManager state, its link and phy", async () => {
		await seed.publish([station()]);
		const iw = fakeIw();
		const read = await port(iw).read();
		expect(read.skipped).toEqual([]);
		expect(read.radios).toHaveLength(1);
		const radio = read.radios[0];
		expect(radio).toMatchObject({
			permanentMac: MAC1,
			ifname: "wlan1",
			station: true,
			reserved: false,
			link: { bssid: "aa:00:00:00:00:01", ssid: "venue", signalDbm: -63 },
		});
		expect(radio?.id.startsWith(`${MAC1}/51:`)).toBe(true);
		// Only reads: the interface list and the radio's link, never a scan,
		// and none of them leaves a debug trace.
		expect(iw.calls).toEqual(["iw dev", "iw dev wlan1 link"]);
		expect(iw.loud).toEqual([]);
	});

	test("the interface list is read at most every 5 s, the link every round", async () => {
		await seed.publish([station()]);
		const iw = fakeIw();
		const p = port(iw);
		clock = 0;
		await p.read();
		clock = 4_000;
		await p.read();
		clock = 5_000;
		await p.read();
		expect(iw.calls.filter((c) => c === "iw dev")).toHaveLength(2);
		expect(iw.calls.filter((c) => c.endsWith(" link"))).toHaveLength(3);
	});

	test("a radio that could serve a hotspot but does not is a client radio", async () => {
		// Discovery gives every AP-capable radio a hotspot object.
		await seed.publish([
			station({
				row: {
					conn: CONN,
					activeMode: "infrastructure",
					hotspot: {
						availableChannels: [],
						bandCapability: ["auto"],
						warnings: {},
					},
				} as unknown as Partial<WifiInterface>,
			}),
		]);
		const read = await port().read();
		expect(read.radios[0]).toMatchObject({ station: true, reserved: false });
	});

	test("an active concurrent AP leg reserves the radio; a leg without an active connection does not", async () => {
		const leg = (activeConn: string | null) =>
			station({
				row: {
					conn: CONN,
					activeMode: "infrastructure",
					concurrentHotspot: { ifname: "clap-wlan1", activeConn },
				} as unknown as Partial<WifiInterface>,
			});
		await seed.publish([leg(CONN)]);
		expect((await port().read()).radios[0]?.reserved).toBe(true);
		await seed.publish([leg(null)]);
		expect((await port().read()).radios[0]?.reserved).toBe(false);
	});

	test("a radio in an unknown NetworkManager mode is not a station", async () => {
		await seed.publish([
			station({
				row: { conn: CONN, activeMode: "unknown" } as Partial<WifiInterface>,
			}),
		]);
		expect((await port().read()).radios[0]?.station).toBe(false);
	});

	test("a radio whose phy carries an AP leg is reserved", async () => {
		await seed.publish([station({ ifname: "wlan2", ifindex: 61, phy: 6 })]);
		const read = await port().read();
		expect(read.radios[0]?.reserved).toBe(true);
	});

	test("a row serving a hotspot is reserved even when iw cannot be read", async () => {
		await seed.publish([
			station({
				row: {
					conn: CONN,
					activeMode: "ap",
				} as Partial<WifiInterface>,
			}),
		]);
		const read = await port(
			fakeIw({ "iw dev": new Error("iw failed") }),
		).read();
		expect(read.radios[0]).toMatchObject({ reserved: true, station: false });
	});

	test("an unreadable phy leaves the hotspot state unknown, an unreadable link undefined", async () => {
		await seed.publish([station()]);
		const read = await port(
			fakeIw({
				"iw dev": new Error("iw failed"),
				"iw dev wlan1 link": new Error("iw failed"),
			}),
		).read();
		expect(read.radios[0]?.reserved).toBeNull();
		expect(read.radios[0]?.link).toBeUndefined();
	});

	test("an idle radio is not a station and has no link", async () => {
		await seed.publish([station({ row: {} })]);
		const read = await port(
			fakeIw({ "iw dev wlan1 link": "Not connected.\n" }),
		).read();
		expect(read.radios[0]).toMatchObject({ station: false, link: null });
	});

	test("a Limited radio is skipped as not admitted, and gets no command", async () => {
		await seed.publish([
			station({ mac: undefined }),
			station({ ifname: "wlan2", mac: MAC2, ifindex: 61, phy: 6 }),
		]);
		const iw = fakeIw();
		const read = await port(iw).read();
		expect(read.skipped).toEqual([{ ifname: "wlan1", reason: "not-admitted" }]);
		expect(read.radios.map((r) => r.ifname)).toEqual(["wlan2"]);
		expect(iw.calls).not.toContain("iw dev wlan1 link");
	});

	test("an unpublished radio is skipped until discovery republishes it", async () => {
		await seed.publish([station()]);
		seed.invalidate();
		expect((await port().read()).skipped).toEqual([
			{ ifname: "wlan1", reason: "not-admitted" },
		]);
		await seed.republish();
		expect((await port().read()).radios).toHaveLength(1);
	});

	test("an excluded radio is skipped", async () => {
		await seed.publish([station()]);
		const read = await port(fakeIw(), new Set([MAC1])).read();
		expect(read).toEqual({
			radios: [],
			skipped: [{ ifname: "wlan1", reason: "excluded" }],
		});
	});

	test("an AP leg is a witness, not a radio", async () => {
		await seed.publish([station()]);
		addWifiInterface("02:00:00:00:d0:0c", {
			id: 90,
			ifname: "clap-wlan1",
			conn: null,
			hw: "leg",
			available: new Map(),
			saved: {},
			savedAll: {},
		} as WifiInterface);
		try {
			const read = await port().read();
			expect(read.radios.map((r) => r.ifname)).toEqual(["wlan1"]);
			expect(read.skipped).toEqual([]);
		} finally {
			removeWifiInterface("02:00:00:00:d0:0c");
		}
	});

	test("a radio replugged while its link is read is skipped for the round", async () => {
		await seed.publish([station()]);
		const iw = fakeIw();
		let replugged = false;
		const read = await port(iw, new Set(), {
			run: async (bin, args) => {
				const out = await iw.run(bin, args);
				if (args.at(-1) === "link" && !replugged) {
					replugged = true;
					await seed.publish([station({ ifindex: 52 })]);
				}
				return out;
			},
		}).read();
		expect(read.radios).toEqual([]);
		expect(read.skipped).toEqual([
			{ ifname: "wlan1", reason: "changed-during-read" },
		]);
	});

	test("a radio republished with a new lifetime under the same row while its link is read is skipped", async () => {
		await seed.publish([station()]);
		const iw = fakeIw();
		let changed = false;
		const read = await port(iw, new Set(), {
			run: async (bin, args) => {
				const out = await iw.run(bin, args);
				if (args.at(-1) === "link" && !changed) {
					changed = true;
					// Same registry row object, a new radio behind the name.
					seed.sysfs([station({ ifindex: 52 })]);
					await seed.republish();
				}
				return out;
			},
		}).read();
		expect(read.radios).toEqual([]);
		expect(read.skipped).toEqual([
			{ ifname: "wlan1", reason: "changed-during-read" },
		]);
	});

	test("a radio replugged while another radio's link is read is skipped too", async () => {
		await seed.publish([
			station(),
			station({ ifname: "wlan2", mac: MAC2, ifindex: 61, phy: 6 }),
		]);
		const iw = fakeIw();
		let replugged = false;
		const read = await port(iw, new Set(), {
			run: async (bin, args) => {
				const out = await iw.run(bin, args);
				// wlan1 was read already; it is replugged while wlan2 is read.
				if (args[1] === "wlan2" && !replugged) {
					replugged = true;
					await seed.publish([
						station({ ifindex: 52 }),
						station({ ifname: "wlan2", mac: MAC2, ifindex: 61, phy: 6 }),
					]);
				}
				return out;
			},
		}).read();
		expect(read.skipped).toContainEqual({
			ifname: "wlan1",
			reason: "changed-during-read",
		});
		expect(read.radios.map((r) => r.ifname)).not.toContain("wlan1");
	});

	test("a verified twin (registry key MAC@port) is skipped as a twin", async () => {
		addWifiInterface("02:00:00:00:d0:09@usb-1.2", {
			id: 91,
			ifname: "wlan7",
			conn: null,
			hw: "twin",
			available: new Map(),
			saved: {},
			savedAll: {},
		} as WifiInterface);
		try {
			const read = await port().read();
			expect(read.skipped).toContainEqual({ ifname: "wlan7", reason: "twin" });
		} finally {
			removeWifiInterface("02:00:00:00:d0:09@usb-1.2");
		}
	});

	test("no radio admitted: nothing is run", async () => {
		await seed.publish([station({ mac: undefined })]);
		const iw = fakeIw();
		await port(iw).read();
		expect(iw.calls).toEqual([]);
	});
});
