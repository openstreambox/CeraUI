import { describe, expect, test } from "bun:test";
import { memoryCloneRegistry } from "./clone-registry.ts";
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

describe("join", () => {
	test("an operator profile that only shares the clone's name is never deleted", async () => {
		const f = fakeRun();
		// STALE is named ceraui-search-wlan2 but this coordinator never cloned it.
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry(),
		});
		await nm.join("wlan2", "venue", "AA:00:00:00:00:02");
		expect(f.calls).not.toContain(`nmcli connection delete uuid ${STALE}`);
		expect(await nm.abandon("wlan2", STALE)).toBe(false);
		expect(f.calls).not.toContain(`nmcli connection delete uuid ${STALE}`);
	});

	test("clones the radio's own bound profile, locks the BSSID, and activates on that radio only", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(await nm.join("wlan2", "venue", "AA:00:00:00:00:02")).toEqual({
			activation: CLONE,
		});
		const writes = f.calls.filter((c) => /clone|modify|up|delete/.test(c));
		// The earlier clone of this radio goes only after the last check before
		// activation, and the new one is kept.
		expect(writes.slice(0, 4)).toEqual([
			`nmcli connection clone --temporary ${SOURCE} ceraui-search-wlan2`,
			`nmcli connection modify --temporary ${CLONE} 802-11-wireless.bssid aa:00:00:00:00:02 connection.autoconnect no`,
			`nmcli connection delete uuid ${STALE}`,
			`nmcli -w 12 connection up uuid ${CLONE} ifname wlan2`,
		]);
		// After activation only earlier clones are cleaned up, never the new one.
		expect(
			writes
				.slice(4)
				.every((c) => c === `nmcli connection delete uuid ${STALE}`),
		).toBe(true);
		// The sibling's profile (bound to another MAC) is never the source.
		expect(writes.join("\n")).not.toContain(OTHER);
	});

	test("a failed activation deletes the clone", async () => {
		const f = fakeRun((args) => args.includes("up"));
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02"),
		).toBeUndefined();
		expect(f.calls.at(-1)).toBe(`nmcli connection delete uuid ${CLONE}`);
	});

	test("no bound profile for the SSID: no write at all", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(
			await nm.join("wlan2", "elsewhere", "aa:00:00:00:00:02"),
		).toBeUndefined();
		expect(f.calls.filter((c) => /clone|modify|up|delete/.test(c))).toEqual([]);
	});

	test("a malformed BSSID is refused before any command", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
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
		const nm = createSearchNm({
			run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect([...(await nm.savedSsids("wlan2"))]).toEqual(["cafe:2"]);
		expect(await nm.join("wlan2", "cafe:2", "aa:00:00:00:00:02")).toEqual({
			activation: CLONE,
		});
	});
});

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

describe("reads never scan", () => {
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

	test("scan names the radio and waits for a fresh result", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
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
		const nm = createSearchNm({
			run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		const rows = await nm.scan("wlan2");
		expect(rows?.[0]?.ssid).toBe("cafe\\2");
		expect(await nm.savedSsids("wlan2")).toEqual(new Set(["cafe\\2"]));
	});
});

describe("late checks", () => {
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

	test("a join refused right before activation removes the clone and never activates", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", async () => false),
		).toBe("refused");
		const writes = f.calls.filter((c) => /clone|modify| up |delete/.test(c));
		expect(writes.some((c) => c.includes("connection up"))).toBe(false);
		expect(writes.at(-1)).toBe(`nmcli connection delete uuid ${CLONE}`);
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

	test("a refused join leaves the earlier clone alone", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		await nm.join("wlan2", "venue", "aa:00:00:00:00:02", async () => false);
		expect(f.calls).not.toContain(`nmcli connection delete uuid ${STALE}`);
	});
});

describe("join's last check and stale clones", () => {
	test("a hotspot that comes up during the stale-clone listing stops the activation", async () => {
		const f = fakeRun();
		let ap = false;
		const run = async (bin: string, args: string[]) => {
			const out = await f.run(bin, args);
			// The mode flips to AP while the old clones are being listed.
			if (args.join(" ") === "-t -f NAME,UUID connection show") ap = true;
			return out;
		};
		const nm = createSearchNm({
			run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", async () => !ap),
		).toBe("refused");
		expect(f.calls.some((c) => c.includes("connection up"))).toBe(false);
		expect(f.calls.at(-1)).toBe(`nmcli connection delete uuid ${CLONE}`);
	});

	test("an earlier clone that is still active is not deleted before activation, only after", async () => {
		const f = fakeRun();
		let upDone = false;
		const run = async (bin: string, args: string[]) => {
			const line = args.join(" ");
			if (line.includes("connection up")) upDone = true;
			if (line === "-t -f DEVICE,UUID connection show --active") {
				f.calls.push(`${bin} ${line}`);
				return upDone ? `wlan2:${CLONE}\n` : `wlan2:${STALE}\n`;
			}
			if (line === "-t -f UUID,DEVICE connection show --active") {
				f.calls.push(`${bin} ${line}`);
				return upDone ? `${CLONE}:wlan2\n` : `${STALE}:wlan2\n`;
			}
			return f.run(bin, args);
		};
		const nm = createSearchNm({
			run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		expect(
			await nm.join("wlan2", "venue", "aa:00:00:00:00:02", async () => true),
		).toEqual({ activation: CLONE });
		const up = f.calls.findIndex((c) => c.includes("connection up"));
		const del = f.calls.indexOf(`nmcli connection delete uuid ${STALE}`);
		expect(up).toBeGreaterThan(-1);
		expect(del).toBeGreaterThan(up);
	});

	test("an unreadable active listing deletes no earlier clone", async () => {
		const f = fakeRun((args) => args.includes("--active"));
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		await nm.join("wlan2", "venue", "aa:00:00:00:00:02", async () => true);
		expect(f.calls).not.toContain(`nmcli connection delete uuid ${STALE}`);
	});
});

describe("sweep of orphaned clones", () => {
	const ORPHAN = "55555555-5555-4555-8555-555555555555";
	const LIVE = "66666666-6666-4666-8666-666666666666";
	const OPERATOR = "77777777-7777-4777-8777-777777777777";
	const GONE = "88888888-8888-4888-8888-888888888888";
	const table = (activeFails: boolean) => {
		const calls: string[] = [];
		const run = async (bin: string, args: string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			calls.push(line);
			if (line === "nmcli -t -f UUID,DEVICE connection show --active") {
				if (activeFails) throw new Error("failed");
				return `${LIVE}:wlan2\n${SOURCE}:wlan1\n`;
			}
			if (line === "nmcli -t -f NAME,UUID connection show")
				return `ceraui-search-wlan7:${ORPHAN}\nceraui-search-wlan2:${LIVE}\nceraui-search-wlan9:${OPERATOR}\nvenue:${OTHER}\n`;
			return "";
		};
		return { run, calls };
	};
	const deletes = (calls: string[]) =>
		calls.filter((c) => c.includes("connection delete"));

	test("deletes only recorded, inactive clones; never an active one or an unrecorded profile with the same prefix", async () => {
		const t = table(false);
		const clones = memoryCloneRegistry([ORPHAN, LIVE, GONE]);
		const nm = createSearchNm({ run: t.run, macOf: async () => MAC, clones });
		expect(await nm.sweepOrphans()).toBe(1);
		expect(deletes(t.calls)).toEqual([
			`nmcli connection delete uuid ${ORPHAN}`,
		]);
		// The orphan and the record of a profile NetworkManager no longer has go.
		expect([...(await clones.list())].sort()).toEqual([LIVE]);
	});

	test("activity is read again right before each deletion", async () => {
		const t = table(false);
		const nm = createSearchNm({
			run: t.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([ORPHAN]),
		});
		await nm.sweepOrphans();
		const del = t.calls.indexOf(`nmcli connection delete uuid ${ORPHAN}`);
		expect(t.calls[del - 1]).toBe(
			"nmcli -t -f UUID,DEVICE connection show --active",
		);
	});

	test("deletes nothing when the active listing cannot be read", async () => {
		const t = table(true);
		const nm = createSearchNm({
			run: t.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([ORPHAN]),
		});
		expect(await nm.sweepOrphans()).toBe(0);
		expect(deletes(t.calls)).toEqual([]);
	});
});

describe("the effect executor", () => {
	const radio = { id: "02:00:00:00:00:aa", lifetime: "1" };

	test("a recorded clone that becomes active during the stale-clone listing is not deleted", async () => {
		const f = fakeRun();
		let listed = false;
		const run = async (bin: string, args: string[]) => {
			const line = args.join(" ");
			if (line === "-t -f NAME,UUID connection show") listed = true;
			// Once listed, STALE is active somewhere (activated meanwhile).
			if (line === "-t -f UUID,DEVICE connection show --active") {
				f.calls.push(`${bin} ${line}`);
				return listed ? `${STALE}:wlan3\n` : "";
			}
			return f.run(bin, args);
		};
		const nm = createSearchNm({
			run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry([STALE]),
		});
		await nm.join(
			"wlan2",
			"venue",
			"aa:00:00:00:00:02",
			async () => true,
			radio,
		);
		expect(f.calls).not.toContain(`nmcli connection delete uuid ${STALE}`);
	});

	test("abandon after an identity change deletes nothing; the record keeps the clone", async () => {
		const f = fakeRun();
		const clones = memoryCloneRegistry([CLONE]);
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones,
			identity: async () => false,
		});
		expect(await nm.abandon("wlan2", CLONE, radio)).toBe(false);
		expect(f.calls.some((c) => c.includes("connection delete"))).toBe(false);
		expect(await clones.has(CLONE)).toBe(true);
	});

	test("a scan whose radio was replaced right before the command never rescans", async () => {
		const f = fakeRun();
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			identity: async () => false,
		});
		expect(await nm.scan("wlan2", radio)).toBeUndefined();
		expect(f.calls.some((c) => c.includes("--rescan"))).toBe(false);
	});

	test("an activation whose radio was replaced never runs connection up", async () => {
		const f = fakeRun();
		let replaced = false;
		const nm = createSearchNm({
			run: f.run,
			macOf: async () => MAC,
			clones: memoryCloneRegistry(),
			identity: async () => !replaced,
		});
		expect(
			await nm.join(
				"wlan2",
				"venue",
				"aa:00:00:00:00:02",
				async () => {
					// The replug lands between the coordinator's check and the command.
					replaced = true;
					return true;
				},
				radio,
			),
		).toBe("refused");
		expect(f.calls.some((c) => c.includes("connection up"))).toBe(false);
	});

	test("effects never interleave: each check is followed by its own command", async () => {
		const f = fakeRun();
		const order: string[] = [];
		const run = async (bin: string, args: string[]) => {
			const line = args.join(" ");
			if (line.includes("--active")) order.push("check");
			if (line.includes("connection delete") || line.includes("--rescan"))
				order.push(line.includes("--rescan") ? "scan" : "delete");
			await Bun.sleep(1);
			return f.run(bin, args);
		};
		const clones = memoryCloneRegistry([
			"55555555-5555-4555-8555-555555555555",
			"66666666-6666-4666-8666-666666666666",
		]);
		const nm = createSearchNm({ run, macOf: async () => MAC, clones });
		await Promise.all([
			nm.abandon("wlan2", "55555555-5555-4555-8555-555555555555", radio),
			nm.scan("wlan2", radio),
			nm.abandon("wlan2", "66666666-6666-4666-8666-666666666666", radio),
		]);
		expect(order).toEqual(["check", "delete", "scan", "check", "delete"]);
	});
});
