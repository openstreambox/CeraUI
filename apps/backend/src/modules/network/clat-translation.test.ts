import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { genSrtlaBondEntries } from "../streaming/srtla.ts";
import {
	type ClatReadDeps,
	isSupportedNat64Prefix,
	leaseLive,
	parseClatSnapshot,
	parseUnitShow,
	readClatTranslations,
	refreshClatTranslations,
	resetClatTranslationStateForTest,
	setClatTranslationsForTest,
} from "./clat-translation.ts";
import {
	isBondCandidate,
	type NetworkInterface,
	processIfconfigOutput,
	resetBondOptOut,
	setBondOptOut,
} from "./network-interfaces.ts";

const BOOT = "e35d2950-56b9-4324-858a-c577b756106b";
const INVOCATION = "5f31d8d55f3141faa50e248d73538aae";
const GENERATION = "375be5e8cd6d4179909196f2d42ae78c";
const NOW = 125; // CLOCK_BOOTTIME seconds

const snapshot = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		schema_version: 2,
		interface: "wwan0",
		ifindex: 3,
		tun: "clat3",
		tun_ifindex: 7,
		prefix: "64:ff9b::/96",
		ipv4: "10.254.0.3",
		state: "up",
		last_error: null,
		boot_id: BOOT,
		invocation_id: INVOCATION,
		generation: GENERATION,
		updated_at: 1794614400,
		observed_at: 120.0,
		expires_at: 150.0,
		...over,
	});

interface FakeBox {
	missing?: readonly string[];
	sysfs?: Record<string, string>;
	owner?: number;
	size?: number;
	unit?: false | string;
	boot?: string;
	modems?: readonly string[];
	now?: number;
}

function deps(files: Record<string, string>, box: FakeBox = {}): ClatReadDeps {
	const missing = new Set(box.missing ?? []);
	const sysfs: Record<string, string> = {
		"/sys/class/net/wwan0/ifindex": "3",
		"/sys/class/net/clat3/flags": "0x1091",
		"/sys/class/net/clat3/ifindex": "7",
		...box.sysfs,
	};
	return {
		dir: "/run/ceralive/clat",
		list: async () => Object.keys(files),
		stat: async (path) => {
			if (missing.has(path)) return undefined;
			if (path === "/run/ceralive/clat")
				return { regular: false, directory: true, uid: 0, size: 4096 };
			const text = files[path.split("/").at(-1) ?? ""];
			if (text === undefined) return undefined;
			return {
				regular: true,
				directory: false,
				uid: box.owner ?? 0,
				size: box.size ?? text.length,
			};
		},
		read: async (path) => {
			const text = files[path.split("/").at(-1) ?? ""];
			if (text === undefined) throw new Error("ENOENT");
			return text;
		},
		sysfs: async (path) => (missing.has(path) ? undefined : sysfs[path]),
		unit: async () =>
			box.unit === false
				? undefined
				: { invocation: box.unit ?? INVOCATION, mainPid: 42 },
		isModem: async (ifname) => (box.modems ?? ["wwan0"]).includes(ifname),
		bootId: () => box.boot ?? BOOT,
		boottime: () => box.now ?? NOW,
	};
}
const usableSize = async (files: Record<string, string>, box: FakeBox = {}) =>
	(await readClatTranslations(deps(files, box))).size;

beforeEach(() => resetClatTranslationStateForTest());

describe("the v2 snapshot contract", () => {
	test("a well-formed snapshot parses; the file index must match", () => {
		expect(parseClatSnapshot(snapshot(), "3")).toMatchObject({
			interface: "wwan0",
			ifindex: 3,
			tun: "clat3",
			tunIfindex: 7,
			state: "up",
			observedAt: 120,
			expiresAt: 150,
		});
		expect(parseClatSnapshot(snapshot(), "4")).toBeUndefined();
	});

	test("v1, a missing field or any malformed field is unavailable", () => {
		const v1 = JSON.stringify({
			schema_version: 1,
			interface: "wwan0",
			tun: "clat3",
			prefix: "64:ff9b::/96",
			ipv4: "10.254.0.3",
			state: "up",
			last_error: null,
			updated_at: 1794614400,
		});
		expect(parseClatSnapshot(v1, "3")).toBeUndefined();
		const full = JSON.parse(snapshot()) as Record<string, unknown>;
		for (const key of Object.keys(full)) {
			const without = { ...full };
			delete without[key];
			expect(parseClatSnapshot(JSON.stringify(without), "3")).toBeUndefined();
		}
		for (const over of [
			{ ifindex: 0 },
			{ ifindex: "3" },
			{ tun: "tun0" },
			{ tun_ifindex: -1 },
			{ interface: "../wwan0" },
			{ ipv4: "192.0.2.3" },
			{ ipv4: "10.254.32.1" },
			{ state: "ready" },
			{ prefix: "64:ff9b::/95" },
			{ last_error: 7 },
			{ boot_id: "not-a-uuid" },
			{ invocation_id: "5F31D8D55F3141FAA50E248D73538AAE" },
			{ generation: `${GENERATION}a` },
			{ updated_at: "now" },
			{ observed_at: "later" },
			{ expires_at: null },
		])
			expect(parseClatSnapshot(snapshot(over), "3")).toBeUndefined();
		expect(parseClatSnapshot("{", "3")).toBeUndefined();
		expect(parseClatSnapshot("[]", "3")).toBeUndefined();
	});

	test("the lease: up, 0 <= observed <= now < expires, exactly 30 s long", () => {
		const up = { state: "up" as const, observedAt: 120, expiresAt: 150 };
		expect(leaseLive(up, 120)).toBe(true);
		expect(leaseLive(up, 149.99)).toBe(true);
		expect(leaseLive(up, 150)).toBe(false);
		// A future observation fails closed (only /proc/uptime's 10 ms step is allowed).
		expect(leaseLive(up, 119.995)).toBe(true);
		expect(leaseLive(up, 119.9)).toBe(false);
		expect(leaseLive({ ...up, expiresAt: 151 }, 125)).toBe(false);
		expect(leaseLive({ ...up, observedAt: -1, expiresAt: 29 }, 0)).toBe(false);
		for (const state of ["starting", "unavailable", "down", "error"] as const)
			expect(leaseLive({ state, observedAt: 120, expiresAt: 120 }, 120)).toBe(
				false,
			);
	});
});

describe("which translations may carry stream traffic", () => {
	test("an up lease on this boot, with its unit, modem and TUN", async () => {
		const usable = await readClatTranslations(deps({ "3.json": snapshot() }));
		expect([...usable.values()]).toEqual([
			{
				parent: "wwan0",
				tun: "clat3",
				ipv4: "10.254.0.3",
				generation: `${BOOT}:${INVOCATION}:${GENERATION}:3:7`,
				expiresAt: 150,
			},
		]);
	});

	test("a DNS refresh warning on a path that is still up is not a rejection", async () => {
		expect(
			await usableSize({
				"3.json": snapshot({ last_error: "dns64 refresh timed out" }),
			}),
		).toBe(1);
	});

	test("no prefix or no TUN yet, another boot or another invocation is unavailable", async () => {
		expect(await usableSize({ "3.json": snapshot({ prefix: null }) })).toBe(0);
		expect(
			await usableSize({ "3.json": snapshot({ tun_ifindex: null }) }),
		).toBe(0);
		expect(
			await usableSize(
				{ "3.json": snapshot() },
				{ boot: "00000000-0000-4000-8000-000000000000" },
			),
		).toBe(0);
		expect(
			await usableSize({ "3.json": snapshot() }, { unit: "0".repeat(32) }),
		).toBe(0);
		expect(await usableSize({ "3.json": snapshot() }, { unit: false })).toBe(0);
	});

	test("an expired or future lease is unavailable; updated_at cannot help", async () => {
		expect(await usableSize({ "3.json": snapshot() }, { now: 151 })).toBe(0);
		expect(await usableSize({ "3.json": snapshot() }, { now: 100 })).toBe(0);
		expect(
			await usableSize(
				{ "3.json": snapshot({ updated_at: 9_999_999_999 }) },
				{ now: 151 },
			),
		).toBe(0);
	});

	test("only bounded, root-owned regular files in a root-owned directory", async () => {
		expect(await usableSize({ "3.json": snapshot() }, { owner: 1000 })).toBe(0);
		expect(await usableSize({ "3.json": snapshot() }, { size: 5000 })).toBe(0);
		expect(
			await usableSize(
				{ "3.json": snapshot() },
				{ missing: ["/run/ceralive/clat"] },
			),
		).toBe(0);
	});

	test("the modem's current ifindex, a known modem, an up TUN with its ifindex", async () => {
		for (const box of [
			{ sysfs: { "/sys/class/net/wwan0/ifindex": "4" } },
			{ modems: [] },
			{ sysfs: { "/sys/class/net/clat3/flags": "0x1090" } },
			{ sysfs: { "/sys/class/net/clat3/ifindex": "8" } },
			{ missing: ["/sys/class/net/clat3/flags"] },
		])
			expect(await usableSize({ "3.json": snapshot() }, box)).toBe(0);
	});

	test("unrelated files are ignored and an unreadable one drops only itself", async () => {
		const usable = await readClatTranslations(
			deps({
				README: "x",
				"3.json.tmp": snapshot(),
				"3.json": snapshot(),
				"4.json": "{",
			}),
		);
		expect([...usable.keys()]).toEqual(["clat3"]);
	});

	test("the unit must be active and running with a live main process", () => {
		const id = "c".repeat(32);
		expect(
			parseUnitShow(
				`ActiveState=active\nSubState=running\nMainPID=812\nInvocationID=${id}\n`,
			),
		).toEqual({ invocation: id, mainPid: 812 });
		for (const text of [
			`ActiveState=activating\nSubState=start\nMainPID=812\nInvocationID=${id}`,
			`ActiveState=active\nSubState=running\nMainPID=0\nInvocationID=${id}`,
			"ActiveState=active\nSubState=running\nMainPID=812\nInvocationID=",
		])
			expect(parseUnitShow(text)).toBeUndefined();
	});

	test("supported NAT64 prefix lengths only", () => {
		for (const ok of ["64:ff9b::/96", "2001:db8::/32", "2001:db8:1::/48"])
			expect(isSupportedNat64Prefix(ok)).toBe(true);
		for (const bad of ["64:ff9b::/95", "64:ff9b::", "10.0.0.0/96", "::/128"])
			expect(isSupportedNat64Prefix(bad)).toBe(false);
	});
});

describe("the bond", () => {
	const stanza = (name: string, ip: string) =>
		[
			`${name}: flags=4305<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST>  mtu 1480`,
			`        inet ${ip}  netmask 255.255.255.255  destination ${ip}`,
			"        unspec 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  txqueuelen 500  (UNSPEC)",
			"        RX packets 20  bytes 2000 (2.0 KB)",
			"        TX packets 10  bytes 1000 (1.0 KB)",
		].join("\n");
	const iface = (ip: string): NetworkInterface =>
		({
			ip,
			txb: 0,
			rxb: 0,
			tp: 0,
			enabled: true,
			error: 0,
		}) as NetworkInterface;
	const TUN = { parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" };

	afterEach(() => {
		resetClatTranslationStateForTest();
		resetBondOptOut();
	});

	test("a translator TUN bonds only while its lease vouches for it", () => {
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
		setClatTranslationsForTest(new Map([["clat3", TUN]]));
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(true);
		// A different address on the TUN is not the one the service assigned.
		expect(isBondCandidate("clat3", iface("10.254.0.9"))).toBe(false);
	});

	test("an expired lease drops out at the next bond read, before any poll", () => {
		let now = 140;
		setClatTranslationsForTest(
			new Map([["clat3", { ...TUN, expiresAt: 150 }]]),
			() => now,
		);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(true);
		now = 150;
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
	});

	test("the modem's own bond toggle also covers its translated link", () => {
		setClatTranslationsForTest(new Map([["clat3", TUN]]));
		setBondOptOut("wwan0", true);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
	});

	test("a new activation withdraws the link for one poll before it comes back", async () => {
		const files = { "3.json": snapshot() };
		expect(await refreshClatTranslations(deps(files))).toBe(true);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(true);
		expect(await refreshClatTranslations(deps(files))).toBe(false);
		const next = { "3.json": snapshot({ generation: "f".repeat(32) }) };
		expect(await refreshClatTranslations(deps(next))).toBe(true);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
		expect(await refreshClatTranslations(deps(next))).toBe(true);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(true);
	});

	test("the sender binds the translated IPv4 to the TUN", () => {
		setClatTranslationsForTest(new Map([["clat3", TUN]]));
		processIfconfigOutput(stanza("clat3", "10.254.0.3"));
		const entries = genSrtlaBondEntries().filter((e) => e.ip === "10.254.0.3");
		expect(entries.map((e) => e.iface)).toEqual(["clat3"]);
		resetClatTranslationStateForTest();
		processIfconfigOutput(stanza("clat3", "10.254.0.3"));
		expect(genSrtlaBondEntries().map((e) => e.ip)).not.toContain("10.254.0.3");
	});
});
