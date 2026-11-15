import { afterEach, describe, expect, test } from "bun:test";
import { genSrtlaBondEntries } from "../streaming/srtla.ts";
import {
	CLAT_SNAPSHOT_MAX_AGE_MS,
	type ClatReadDeps,
	parseClatSnapshot,
	readClatTranslations,
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

function deps(
	files: Record<string, string>,
	over: Partial<ClatReadDeps> & { missing?: readonly string[] } = {},
): ClatReadDeps {
	const missing = new Set(over.missing ?? []);
	return {
		dir: "/run/ceralive/clat",
		list: async () => Object.keys(files),
		read: async (path) => {
			const name = path.split("/").at(-1) ?? "";
			const text = files[name];
			if (text === undefined) throw new Error("ENOENT");
			return text;
		},
		exists: async (path) => !missing.has(path),
		now: () => NOW,
		...over,
	};
}

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
		])
			expect(parseClatSnapshot(snapshot(over), "3")).toBeUndefined();
		expect(parseClatSnapshot("{", "3")).toBeUndefined();
		expect(parseClatSnapshot("[]", "3")).toBeUndefined();
	});
});

describe("which translations may carry stream traffic", () => {
	test("an up, fresh snapshot with its TUN, modem and service present", async () => {
		const usable = await readClatTranslations(deps({ "3.json": snapshot() }));
		expect([...usable.values()]).toEqual([
			{ parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" },
		]);
	});

	test("starting, down, error or no prefix yet is unavailable", async () => {
		for (const over of [
			{ state: "starting" },
			{ state: "down" },
			{ state: "error", last_error: "dns64 lost" },
			{ prefix: null },
		])
			expect(
				(await readClatTranslations(deps({ "3.json": snapshot(over) }))).size,
			).toBe(0);
	});

	test("a stale snapshot is unavailable", async () => {
		const old = (NOW - CLAT_SNAPSHOT_MAX_AGE_MS - 1000) / 1000;
		expect(
			(
				await readClatTranslations(
					deps({ "3.json": snapshot({ updated_at: old }) }),
				)
			).size,
		).toBe(0);
		const recent = (NOW - CLAT_SNAPSHOT_MAX_AGE_MS + 1000) / 1000;
		expect(
			(
				await readClatTranslations(
					deps({ "3.json": snapshot({ updated_at: recent }) }),
				)
			).size,
		).toBe(1);
	});

	test("a snapshot alone is not a liveness lease", async () => {
		for (const missing of [
			"/run/systemd/units/invocation:ceralive-clat.service",
			"/sys/class/net/clat3",
			"/sys/class/net/wwan0",
		])
			expect(
				(
					await readClatTranslations(
						deps({ "3.json": snapshot() }, { missing: [missing] }),
					)
				).size,
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
		setClatTranslationsForTest(new Map());
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
