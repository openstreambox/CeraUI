import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolvePhysicalDevice } from "../modems/physical-identity.ts";
import { setBondIdentityResolverForTest } from "../streaming/bond-entry.ts";
import { genSrtlaBondEntries } from "../streaming/srtla.ts";
import {
	type ClatReadDeps,
	clatTranslationFor,
	clatTunForParent,
	defaultClatReadDeps,
	isSupportedNat64Prefix,
	leaseLive,
	parseClatSnapshot,
	parseUnitShow,
	readClatTranslations,
	readUnit,
	refreshClatTranslations,
	resetClatTranslationStateForTest,
	setClatTranslationsForTest,
	startClatTranslationPolling,
} from "./clat-translation.ts";
import {
	isBondCandidate,
	type NetworkInterface,
	netIfBuildMsg,
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
	directoryOwner?: number;
	regular?: boolean;
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
				return {
					regular: false,
					directory: true,
					uid: box.directoryOwner ?? 0,
					size: 4096,
				};
			const text = files[path.split("/").at(-1) ?? ""];
			if (text === undefined) return undefined;
			return {
				regular: box.regular ?? true,
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
		ipv4: async () => true,
		modemKey: async () => "synthetic-modem",
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
		expect(leaseLive(up, 149.98)).toBe(true);
		expect(leaseLive(up, 149.995)).toBe(false);
		expect(leaseLive(up, 150)).toBe(false);
		// A future observation fails closed (only /proc/uptime's 10 ms step is allowed).
		expect(leaseLive(up, 119.995)).toBe(false);
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
				generation: `${BOOT}:${INVOCATION}:${GENERATION}:3:7:wwan0:10.254.0.3:synthetic-modem`,
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
	beforeEach(() =>
		setBondIdentityResolverForTest((ifname) =>
			resolvePhysicalDevice({ ifname, idPath: "platform-synthetic-usb-0:1" }),
		),
	);
	afterEach(() => setBondIdentityResolverForTest(null));
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

	test("the modem's TUN is found from its interface only while the lease holds", () => {
		let now = 140;
		expect(clatTunForParent("wwan0")).toBeUndefined();
		setClatTranslationsForTest(
			new Map([["clat3", { ...TUN, expiresAt: 150 }]]),
			() => now,
		);
		expect(clatTunForParent("wwan0")).toBe("clat3");
		expect(clatTunForParent("wwan1")).toBeUndefined();
		now = 150;
		expect(clatTunForParent("wwan0")).toBeUndefined();
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

test("down with an otherwise live lease is never usable", async () => {
	expect(
		leaseLive({ state: "down", observedAt: 120, expiresAt: 150 }, NOW),
	).toBe(false);
	expect(await usableSize({ "3.json": snapshot({ state: "down" }) })).toBe(0);
});

test("non-up snapshots have zero lifetime and unknown fields are rejected", () => {
	expect(parseClatSnapshot(snapshot({ state: "down" }), "3")).toBeUndefined();
	expect(parseClatSnapshot(snapshot({ extra: true }), "3")).toBeUndefined();
	expect(
		parseClatSnapshot(snapshot({ state: "down", expires_at: 120 }), "3"),
	).toBeDefined();
});

test("directory ownership and regular-file guards are independent", async () => {
	expect(
		await usableSize({ "3.json": snapshot() }, { directoryOwner: 1000 }),
	).toBe(0);
	expect(await usableSize({ "3.json": snapshot() }, { regular: false })).toBe(
		0,
	);
});

test("ActiveState and SubState are independently required", () => {
	for (const [active, sub] of [
		["inactive", "running"],
		["active", "dead"],
	])
		expect(
			parseUnitShow(
				`ActiveState=${active}\nSubState=${sub}\nMainPID=42\nInvocationID=${INVOCATION}`,
			),
		).toBeUndefined();
});

test("readUnit checks the actual MainPID in proc and fails closed on errors", async () => {
	const show = (pid: number) => async () =>
		`ActiveState=active\nSubState=running\nMainPID=${pid}\nInvocationID=${INVOCATION}`;
	expect(await readUnit(show(process.pid))).toEqual({
		invocation: INVOCATION,
		mainPid: process.pid,
	});
	expect(await readUnit(show(2147483647))).toBeUndefined();
	expect(
		await readUnit(async () => {
			throw new Error("unit unavailable");
		}),
	).toBeUndefined();
});

test("the TUN suffix must match the file and snapshot index", async () => {
	expect(parseClatSnapshot(snapshot({ tun: "clat4" }), "3")).toBeUndefined();
	expect(
		await usableSize(
			{ "3.json": snapshot({ tun: "clat4" }) },
			{
				sysfs: {
					"/sys/class/net/clat4/flags": "0x1",
					"/sys/class/net/clat4/ifindex": "7",
				},
			},
		),
	).toBe(0);
});

test("an error refreshing an admitted link withdraws it", async () => {
	const d = deps({ "3.json": snapshot() });
	await refreshClatTranslations(d);
	expect(clatTranslationFor("clat3", "10.254.0.3")).toBeDefined();
	expect(
		await refreshClatTranslations({
			...d,
			list: async () => {
				throw new Error("read error");
			},
		}),
	).toBe(true);
	expect(clatTranslationFor("clat3", "10.254.0.3")).toBeUndefined();
});

test("independent two-second polling detects snapshot replacement without an interface event", async () => {
	const files = { "3.json": snapshot() };
	let tick!: () => void;
	let interval: number | undefined;
	let changed!: () => void;
	let change = new Promise<void>((r) => {
		changed = r;
	});
	const stop = startClatTranslationPolling(() => changed(), deps(files), ((
		callback: () => void,
		ms: number,
	) => {
		tick = callback;
		interval = ms;
		return 0;
	}) as unknown as typeof setInterval);
	try {
		await change;
		expect(interval).toBe(2000);
		expect(clatTranslationFor("clat3", "10.254.0.3")).toBeDefined();
		change = new Promise<void>((r) => {
			changed = r;
		});
		files["3.json"] = snapshot({ state: "down", expires_at: 120 });
		tick();
		await change;
		expect(clatTranslationFor("clat3", "10.254.0.3")).toBeUndefined();
	} finally {
		stop();
	}
});

test("IPv4 and parent changes in one producer generation withdraw before readmission", async () => {
	for (const patch of [{ ipv4: "10.254.0.9" }, { interface: "wwan1" }]) {
		resetClatTranslationStateForTest();
		await refreshClatTranslations(deps({ "3.json": snapshot() }));
		const d = deps(
			{ "3.json": snapshot(patch) },
			{
				modems: ["wwan0", "wwan1"],
				sysfs: { "/sys/class/net/wwan1/ifindex": "3" },
			},
		);
		await refreshClatTranslations(d);
		const ip = patch.ipv4 ?? "10.254.0.3";
		expect(clatTranslationFor("clat3", ip)).toBeUndefined();
		await refreshClatTranslations(d);
		expect(clatTranslationFor("clat3", ip)).toBeDefined();
	}
});

test("a translated modem has one UI row and the parent's physical link identity", async () => {
	const { setBondIdentityResolverForTest } = await import(
		"../streaming/bond-entry.ts"
	);
	const { resolvePhysicalDevice } = await import(
		"../modems/physical-identity.ts"
	);
	const record = resolvePhysicalDevice({
		ifname: "wwan0",
		idPath: "platform-synthetic-usb-0:1",
	});
	const seen: string[] = [];
	setBondIdentityResolverForTest((ifname) => {
		seen.push(ifname);
		return record;
	});
	try {
		setClatTranslationsForTest(
			new Map([
				[
					"clat3",
					{
						parent: "wwan0",
						tun: "clat3",
						ipv4: "10.254.0.3",
						generation: "activation",
					},
				],
			]),
		);
		processIfconfigOutput(
			[
				"wwan0: flags=4305<UP,POINTOPOINT,RUNNING> mtu 1500\n",
				"clat3: flags=4305<UP,POINTOPOINT,RUNNING> mtu 1480",
				"        inet 10.254.0.3 netmask 255.255.255.255 destination 10.254.0.3",
				"        TX packets 10 bytes 1000 (1.0 KB)",
			].join("\n"),
		);
		const wire = netIfBuildMsg();
		expect(wire.clat3).toBeUndefined();
		expect(wire.wwan0).toMatchObject({ ip: "10.254.0.3", enabled: true });
		const entry = genSrtlaBondEntries().find((e) => e.iface === "clat3");
		expect(entry).toMatchObject({
			linkId: record.linkId,
			iface: "clat3",
			clatGeneration: "activation",
		});
		expect(seen).not.toContain("clat3");
		const {
			registerBondIdentities,
			identityForIface,
			identityForLinkId,
			resetBondIdentities,
		} = await import("../streaming/link-registry.ts");
		registerBondIdentities(entry ? [entry] : []);
		expect(identityForIface("clat3")?.iface).toBe("wwan0");
		expect(identityForLinkId(record.linkId)?.iface).toBe("wwan0");
		resetBondIdentities();
	} finally {
		setBondIdentityResolverForTest(null);
	}
});

test("publication rechecks the snapshot, unit and TUN instead of trusting the poll", async () => {
	const { publishSrtlaBond } = await import("../streaming/srtla.ts");
	const { setBondIdentityResolverForTest } = await import(
		"../streaming/bond-entry.ts"
	);
	const { resolvePhysicalDevice } = await import(
		"../modems/physical-identity.ts"
	);
	const { resetBindMapWriter } = await import(
		"../streaming/bind-map-writer.ts"
	);
	const record = resolvePhysicalDevice({
		ifname: "wwan0",
		idPath: "platform-synthetic-usb-0:1",
	});
	setBondIdentityResolverForTest(() => record);
	try {
		for (const broken of [
			"valid",
			"snapshot",
			"unit",
			"tun",
			"parent",
			"ipv4",
		] as const) {
			resetBindMapWriter();
			resetClatTranslationStateForTest();
			const files = { "3.json": snapshot() };
			const box: FakeBox = {};
			const d = deps(files, box);
			await refreshClatTranslations(d);
			processIfconfigOutput(
				"clat3: flags=4305<UP,POINTOPOINT,RUNNING> mtu 1480\n        inet 10.254.0.3 netmask 255.255.255.255 destination 10.254.0.3",
			);
			const entries = genSrtlaBondEntries();
			expect(entries).toHaveLength(1);
			const spies = (Object.keys(d) as (keyof ClatReadDeps)[])
				.filter((k) => typeof d[k] === "function")
				.map((k) =>
					spyOn(defaultClatReadDeps, k as "unit").mockImplementation(
						d[k] as never,
					),
				);
			const writes: string[] = [];
			let published: readonly unknown[] = entries;
			try {
				await publishSrtlaBond(
					entries,
					{
						ipsFile: "/synthetic/ips",
						sidecarFile: "/synthetic/map",
						reserve: async () => {
							if (broken === "snapshot")
								files["3.json"] = snapshot({ generation: "f".repeat(32) });
							if (broken === "unit") box.unit = false;
							if (broken === "tun")
								box.missing = ["/sys/class/net/clat3/flags"]; // replace sysfs below as it captures missing
							if (broken === "parent") box.modems = [];
						},
						prepareEntries: async (e) => {
							if (broken === "ipv4")
								spyOn(defaultClatReadDeps, "ipv4").mockImplementation(
									async () => false,
								);
							if (broken === "tun")
								files["3.json"] = snapshot({ tun_ifindex: 8 });
							return e;
						},
						writeFile: async (_path, contents) => {
							writes.push(contents);
						},
						renameFile: async () => {},
						removeFile: async () => {},
					},
					{
						registerBond: (e) => {
							published = e;
						},
					},
				);
				expect(writes[0]).toBe(broken === "valid" ? "10.254.0.3" : "");
				expect(published).toEqual(broken === "valid" ? entries : []);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		}
	} finally {
		resetBindMapWriter();
		setBondIdentityResolverForTest(null);
	}
});

test("CLAT waits for physical identity rather than minting an interface-name link ID", () => {
	const translation = { parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" };
	setClatTranslationsForTest(new Map([["clat3", translation]]));
	const int = {
		ip: translation.ipv4,
		txb: 0,
		rxb: 0,
		tp: 0,
		enabled: true,
		error: 0,
	};
	setBondIdentityResolverForTest((ifname) => resolvePhysicalDevice({ ifname }));
	try {
		expect(isBondCandidate("clat3", int)).toBe(false);
		setBondIdentityResolverForTest((ifname) =>
			resolvePhysicalDevice({ ifname, idPath: "platform-synthetic-usb-0:1" }),
		);
		expect(isBondCandidate("clat3", int)).toBe(true);
	} finally {
		setBondIdentityResolverForTest(null);
	}
});
