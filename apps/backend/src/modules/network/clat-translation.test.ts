import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { genSrtlaBondEntries } from "../streaming/srtla.ts";
import {
	CLAT_SNAPSHOT_FUTURE_SKEW_MS,
	CLAT_SNAPSHOT_MAX_AGE_MS,
	type ClatReadDeps,
	isSupportedNat64Prefix,
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

const NOW = 1_794_614_400_000;
const snapshot = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		schema_version: 1,
		interface: "wwan0",
		tun: "clat3",
		prefix: "64:ff9b::/96",
		ipv4: "10.254.0.3",
		state: "up",
		last_error: null,
		updated_at: NOW / 1000,
		...over,
	});

interface FakeBox {
	missing?: readonly string[];
	sysfs?: Record<string, string>;
	owner?: number;
	size?: number;
	unit?: boolean;
	invocation?: string;
	modems?: readonly string[];
	now?: () => number;
	monotonic?: () => number;
}

function deps(files: Record<string, string>, box: FakeBox = {}): ClatReadDeps {
	const missing = new Set(box.missing ?? []);
	const sysfs: Record<string, string> = {
		"/sys/class/net/wwan0/ifindex": "3",
		"/sys/class/net/clat3/flags": "0x1091",
		"/sys/class/net/clat3/ifindex": "9",
		...box.sysfs,
	};
	return {
		dir: "/run/ceralive/clat",
		list: async () => Object.keys(files),
		stat: async (path) => {
			if (missing.has(path)) return undefined;
			if (path === "/run/ceralive/clat")
				return { regular: false, directory: true, uid: 0, size: 4096 };
			const name = path.split("/").at(-1) ?? "";
			const text = files[name];
			if (text === undefined) return undefined;
			return {
				regular: true,
				directory: false,
				uid: box.owner ?? 0,
				size: box.size ?? text.length,
			};
		},
		read: async (path) => {
			const name = path.split("/").at(-1) ?? "";
			const text = files[name];
			if (text === undefined) throw new Error("ENOENT");
			return text;
		},
		sysfs: async (path) => (missing.has(path) ? undefined : sysfs[path]),
		unit: async () =>
			box.unit === false
				? undefined
				: { invocation: box.invocation ?? "a".repeat(32), mainPid: 42 },
		isModem: (ifname) => (box.modems ?? ["wwan0"]).includes(ifname),
		now: box.now ?? (() => NOW),
		monotonic: box.monotonic ?? (() => 1000),
	};
}

beforeEach(() => resetClatTranslationStateForTest());

describe("the snapshot contract", () => {
	test("a well-formed snapshot parses, and its TUN must match the file", () => {
		expect(parseClatSnapshot(snapshot(), "3")).toEqual({
			interface: "wwan0",
			tun: "clat3",
			prefix: "64:ff9b::/96",
			ipv4: "10.254.0.3",
			state: "up",
			updatedAt: NOW,
		});
		expect(parseClatSnapshot(snapshot(), "4")).toBeUndefined();
	});

	test("anything unexpected is unavailable, never a guess", () => {
		for (const over of [
			{ schema_version: 2 },
			{ tun: "tun0" },
			{ interface: "../wwan0" },
			{ ipv4: "192.0.2.3" },
			{ ipv4: "10.254.32.1" },
			{ state: "ready" },
			{ updated_at: "now" },
			{ prefix: 64 },
			{ prefix: "64:ff9b::/95" },
			{ last_error: 7 },
			{ expires_at: "soon" },
			{ activation: "has spaces" },
		])
			expect(parseClatSnapshot(snapshot(over), "3")).toBeUndefined();
		expect(parseClatSnapshot("{", "3")).toBeUndefined();
		expect(parseClatSnapshot("[]", "3")).toBeUndefined();
	});
});

const usableSize = async (files: Record<string, string>, box: FakeBox = {}) =>
	(await readClatTranslations(deps(files, box))).size;

describe("which translations may carry stream traffic", () => {
	test("an up, fresh snapshot with its TUN, modem and service present", async () => {
		const usable = await readClatTranslations(deps({ "3.json": snapshot() }));
		expect([...usable.values()]).toEqual([
			{
				parent: "wwan0",
				tun: "clat3",
				ipv4: "10.254.0.3",
				generation: `${"a".repeat(32)}:9:3:`,
			},
		]);
	});

	test("starting, down, error or no prefix yet is unavailable", async () => {
		for (const over of [
			{ state: "starting" },
			{ state: "down" },
			{ state: "error", last_error: "dns64 lost" },
			{ prefix: null },
		])
			expect(await usableSize({ "3.json": snapshot(over) })).toBe(0);
	});

	test("a DNS refresh error on a path that is still up does not reject it", async () => {
		expect(
			await usableSize({
				"3.json": snapshot({ last_error: "dns64 refresh timed out" }),
			}),
		).toBe(1);
	});

	test("freshness: too old, too far ahead, or expired by the producer", async () => {
		const at = (ms: number) => ({ updated_at: (NOW + ms) / 1000 });
		expect(
			await usableSize({
				"3.json": snapshot(at(-CLAT_SNAPSHOT_MAX_AGE_MS - 1000)),
			}),
		).toBe(0);
		expect(
			await usableSize({
				"3.json": snapshot(at(-CLAT_SNAPSHOT_MAX_AGE_MS + 1000)),
			}),
		).toBe(1);
		expect(
			await usableSize({
				"3.json": snapshot(at(CLAT_SNAPSHOT_FUTURE_SKEW_MS + 1000)),
			}),
		).toBe(0);
		expect(
			await usableSize({ "3.json": snapshot({ expires_at: NOW / 1000 - 1 }) }),
		).toBe(0);
		expect(
			await usableSize({ "3.json": snapshot({ expires_at: NOW / 1000 + 10 }) }),
		).toBe(1);
	});

	test("rereading an unchanged snapshot never renews it, even if the clock steps back", async () => {
		let mono = 0;
		const box = { monotonic: () => mono };
		expect(await usableSize({ "3.json": snapshot() }, box)).toBe(1);
		mono = CLAT_SNAPSHOT_MAX_AGE_MS + 1;
		expect(await usableSize({ "3.json": snapshot() }, box)).toBe(0);
		// A new update_at from the producer counts again.
		expect(
			await usableSize(
				{ "3.json": snapshot({ updated_at: (NOW + 1000) / 1000 }) },
				{ ...box, now: () => NOW + 1000 },
			),
		).toBe(1);
	});

	test("only bounded, root-owned regular files count", async () => {
		expect(await usableSize({ "3.json": snapshot() }, { owner: 1000 })).toBe(0);
		expect(await usableSize({ "3.json": snapshot() }, { size: 5000 })).toBe(0);
		expect(
			await usableSize(
				{ "3.json": snapshot() },
				{ missing: ["/run/ceralive/clat"] },
			),
		).toBe(0);
	});

	test("the file must match the modem's current ifindex, and it must be a modem", async () => {
		expect(
			await usableSize(
				{ "3.json": snapshot() },
				{ sysfs: { "/sys/class/net/wwan0/ifindex": "4" } },
			),
		).toBe(0);
		expect(await usableSize({ "3.json": snapshot() }, { modems: [] })).toBe(0);
	});

	test("a snapshot alone is not a liveness lease", async () => {
		expect(await usableSize({ "3.json": snapshot() }, { unit: false })).toBe(0);
		for (const missing of [
			"/sys/class/net/clat3/flags",
			"/sys/class/net/clat3/ifindex",
			"/sys/class/net/wwan0/ifindex",
		])
			expect(
				await usableSize({ "3.json": snapshot() }, { missing: [missing] }),
			).toBe(0);
		// An administratively down TUN does not carry traffic.
		expect(
			await usableSize(
				{ "3.json": snapshot() },
				{ sysfs: { "/sys/class/net/clat3/flags": "0x1090" } },
			),
		).toBe(0);
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

	test("a new unit invocation withdraws the link for one scan before it comes back", async () => {
		const files = { "3.json": snapshot() };
		const tun = {
			ip: "10.254.0.3",
			tp: 0,
			txb: 0,
			rxb: 0,
			enabled: true,
			error: 0,
		};
		await refreshClatTranslations(deps(files));
		expect(isBondCandidate("clat3", tun)).toBe(true);
		await refreshClatTranslations(deps(files, { invocation: "b".repeat(32) }));
		expect(isBondCandidate("clat3", tun)).toBe(false);
		await refreshClatTranslations(deps(files, { invocation: "b".repeat(32) }));
		expect(isBondCandidate("clat3", tun)).toBe(true);
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
	const stanza = (name: string, ip: string, extra = "") =>
		[
			`${name}: flags=4305<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST>  mtu 1480`,
			`        inet ${ip}  netmask 255.255.255.255  destination ${ip}`,
			`        unspec 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  txqueuelen 500  (UNSPEC)${extra}`,
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

	afterEach(() => {
		resetClatTranslationStateForTest();
		resetBondOptOut();
	});

	test("a translator TUN bonds only while its snapshot vouches for it", () => {
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
		setClatTranslationsForTest(
			new Map([
				["clat3", { parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" }],
			]),
		);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(true);
		// A different address on the TUN is not the one the service assigned.
		expect(isBondCandidate("clat3", iface("10.254.0.9"))).toBe(false);
	});

	test("the modem's own bond toggle also covers its translated link", () => {
		setClatTranslationsForTest(
			new Map([
				["clat3", { parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" }],
			]),
		);
		setBondOptOut("wwan0", true);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
	});

	test("the sender binds the translated IPv4 to the TUN", () => {
		setClatTranslationsForTest(
			new Map([
				["clat3", { parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" }],
			]),
		);
		processIfconfigOutput(stanza("clat3", "10.254.0.3"));
		const entries = genSrtlaBondEntries().filter((e) => e.ip === "10.254.0.3");
		expect(entries.map((e) => e.iface)).toEqual(["clat3"]);
		setClatTranslationsForTest(new Map());
		processIfconfigOutput(stanza("clat3", "10.254.0.3"));
		expect(genSrtlaBondEntries().map((e) => e.ip)).not.toContain("10.254.0.3");
	});
});
