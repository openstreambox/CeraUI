import { describe, expect, test } from "bun:test";
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
	unescapeNmcli,
} from "./nm-port.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CLONE = "33333333-3333-4333-8333-333333333333";
const MAC = "02:00:00:00:00:0b";

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
		if (line.startsWith("nmcli connection clone"))
			return `venue (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`;
		return "";
	};
	return { run, calls };
}

describe("join", () => {
	test("clones the radio's own bound profile, locks the BSSID, and activates on that radio only", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		expect(await nm.join("wlan2", "venue", "AA:00:00:00:00:02")).toEqual({
			activation: CLONE,
		});
		const writes = f.calls.filter((c) => /clone|modify|up|delete/.test(c));
		expect(writes).toEqual([
			"nmcli connection delete id ceraui-search-wlan2",
			`nmcli connection clone --temporary ${SOURCE} ceraui-search-wlan2`,
			`nmcli connection modify --temporary ${CLONE} 802-11-wireless.bssid aa:00:00:00:00:02 connection.autoconnect no`,
			`nmcli -w 12 connection up ${CLONE} ifname wlan2`,
		]);
		// The sibling's profile (bound to another MAC) is never the source.
		expect(writes.join("\n")).not.toContain(OTHER);
	});

	test("a failed activation deletes the clone", async () => {
		const f = fakeRun((args) => args.includes("up"));
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02"),
		).toBeUndefined();
		expect(f.calls.at(-1)).toBe(`nmcli connection delete ${CLONE}`);
	});

	test("no bound profile for the SSID: no write at all", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		expect(
			await nm.join("wlan2", "elsewhere", "aa:00:00:00:00:02"),
		).toBeUndefined();
		expect(f.calls.filter((c) => /clone|modify|up|delete/.test(c))).toEqual([]);
	});

	test("a malformed BSSID is refused before any command", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		await expect(nm.join("wlan2", "venue", "aa:00:00:00:00")).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});
});

describe("escaped SSIDs", () => {
	test("a saved SSID with a colon matches the scan's unescaped SSID", async () => {
		const calls: string[] = [];
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			calls.push(line);
			if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
				return `cafe\\:2:${SOURCE}:802-11-wireless\n`;
			if (line.startsWith("nmcli -g 802-11-wireless.ssid"))
				return `cafe\\:2\n${MAC.replace(/:/g, "\\:")}\n\n`;
			if (line.startsWith("nmcli connection clone"))
				return `cafe:2 (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`;
			return "";
		};
		const nm = createSearchNm({ run, macOf: async () => MAC });
		expect([...(await nm.savedSsids("wlan2"))]).toEqual(["cafe:2"]);
		expect(await nm.join("wlan2", "cafe:2", "aa:00:00:00:00:02")).toEqual({
			activation: CLONE,
		});
	});
});

describe("hotspot mode", () => {
	test("observe reports the phy and an AP leg on it", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
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
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		expect(await nm.observe("wlan2")).toMatchObject({ apOnPhy: null });
	});
});

describe("reads never scan", () => {
	test("observe uses iw link, nmcli listings without rescan, and ip", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		await nm.observe("wlan1");
		expect(f.calls.some((c) => /rescan|scan/.test(c))).toBe(false);
	});

	test("scan names the radio and waits for a fresh result", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		await nm.scan("wlan2");
		expect(f.calls).toEqual([
			"nmcli -t -f BSSID,SSID,SIGNAL,CHAN device wifi list ifname wlan2 --rescan yes",
		]);
	});
});

describe("backslashes in SSIDs", () => {
	test("terse fields: escaped colons and backslashes, both sides alike", () => {
		expect(splitTerse("a\\\\b:c\\:d:e")).toEqual(["a\\b", "c:d", "e"]);
		// A field that ends in a literal backslash, then a separator.
		expect(splitTerse("x\\\\:y")).toEqual(["x\\", "y"]);
		expect(unescapeNmcli("a\\\\b\\:c")).toBe("a\\b:c");
	});

	test("a scan SSID with a backslash matches the saved profile", async () => {
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			if (line === "nmcli -t -f NAME,UUID,TYPE connection show")
				return `cafe\\\\2:${SOURCE}:802-11-wireless\n`;
			if (line.startsWith("nmcli -g 802-11-wireless.ssid"))
				return `cafe\\\\2\n${MAC.replace(/:/g, "\\:")}\n\n`;
			if (line.startsWith("nmcli -t -f BSSID,SSID,SIGNAL,CHAN"))
				return "AA\\:00\\:00\\:00\\:00\\:02:cafe\\\\2:70:6\n";
			if (line.startsWith("nmcli connection clone"))
				return `x (${SOURCE}) cloned as ceraui-search-wlan2 (${CLONE}).`;
			return "";
		};
		const nm = createSearchNm({ run, macOf: async () => MAC });
		const rows = await nm.scan("wlan2");
		expect(rows?.[0]?.ssid).toBe("cafe\\2");
		expect(await nm.savedSsids("wlan2")).toEqual(new Set(["cafe\\2"]));
	});
});

describe("late checks", () => {
	test("radioMode reads iw dev only", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		expect(await nm.radioMode("wlan1")).toEqual({ phy: "phy1", apOnPhy: true });
		expect(f.calls).toEqual(["iw dev"]);
	});

	test("a join refused right before activation removes the clone and never activates", async () => {
		const f = fakeRun();
		const nm = createSearchNm({ run: f.run, macOf: async () => MAC });
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", async () => false),
		).toBe("refused");
		const writes = f.calls.filter((c) => /clone|modify| up |delete/.test(c));
		expect(writes.some((c) => c.includes("connection up"))).toBe(false);
		expect(writes.at(-1)).toBe(`nmcli connection delete ${CLONE}`);
	});
});
