import { afterEach, expect, test } from "bun:test";
import { setClatTranslationsForTest } from "../modules/network/clat-translation.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	isHeldOutByModemBlock,
	onNetworkInterfacesChange,
} from "../modules/network/network-interfaces.ts";
import {
	globalStreamHold,
	streamingBlockingMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	ETHERNET,
	journalEntry,
	MODEMS,
	type RealisticBox,
	realisticBox,
	stableKeyOf,
	USB_ETHERNET,
	USB_WIFI,
} from "./fixtures/realistic-box.ts";

let box: RealisticBox | undefined;
afterEach(() => {
	box?.close();
	box = undefined;
});

const ALL = ["eth0", "wwan0", "wwan1", "wwan2"];

test("L1: Ethernet and all three modems on default profiles reach the bond", async () => {
	box = await realisticBox();
	expect(box.bonded()).toEqual(ALL);
});

test("each modem link resolves to its own stable key from udev", () => {
	const keys = MODEMS.map(stableKeyOf);
	expect(new Set(keys).size).toBe(3);
});

test("a modem that leaves and comes back under another name keeps its key", async () => {
	box = await realisticBox();
	const [first, second, third] = MODEMS;
	if (!first || !second || !third) throw new Error("fixture");
	const renamed = { ...first, ifname: "wwan5" };
	await box.scan([ETHERNET, renamed, second, third]);
	expect(box.bonded()).toEqual(["eth0", "wwan1", "wwan2", "wwan5"]);
	expect(stableKeyOf(renamed)).toBe(stableKeyOf(first));
});

test("S1: a failed rollback on one modem no longer holds every stream start", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	await box.journal([journalEntry(first, "failed")]);
	// The journal still says this modem holds streaming; admission doesn't.
	expect(streamingBlockingMutation()?.stableKey).toBe(stableKeyOf(first));
	expect(globalStreamHold()).toBeUndefined();
});

test("S2: a change still in flight keeps holding every start", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	for (const state of ["armed", "executing"] as const) {
		await box.journal([journalEntry(first, state)]);
		expect(globalStreamHold()?.stableKey).toBe(stableKeyOf(first));
	}
});

test("L2: the blocked modem leaves the bond; Ethernet and the other modems stay", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	for (const state of ["failed", "device-absent-quarantine"] as const) {
		await box.journal([journalEntry(first, state)]);
		expect(box.bonded()).toEqual(["eth0", "wwan1", "wwan2"]);
	}
	await box.journal([]);
	expect(box.bonded()).toEqual(ALL);
});

test("L3: a blocked modem that comes back under another name stays out", async () => {
	box = await realisticBox();
	const [first, second, third] = MODEMS;
	if (!first || !second || !third) throw new Error("fixture");
	await box.journal([journalEntry(first, "failed")]);
	await box.scan([ETHERNET, { ...first, ifname: "wwan7" }, second, third]);
	expect(box.bonded()).toEqual(["eth0", "wwan1", "wwan2"]);
});

test("settled USB Ethernet and USB Wi-Fi survive another modem's block without cached ID_PATH", async () => {
	box = await realisticBox();
	await box.scan([ETHERNET, ...MODEMS, USB_ETHERNET, USB_WIFI]);
	for (const link of [USB_ETHERNET, USB_WIFI]) {
		expect(getNetworkInterfaces()[link.ifname]).toMatchObject({
			usb: true,
			identitySettled: true,
		});
	}
	await box.journal([journalEntry(MODEMS[0], "failed")]);
	expect(box.bonded()).toEqual([
		"enx001122334455",
		"eth0",
		"wlx001122334466",
		"wwan1",
		"wwan2",
	]);
});

test("an unresolved modem candidate stays out even after identity settlement or deadline", async () => {
	box = await realisticBox();
	const unknown = {
		ifname: "wwan9",
		ip: "198.51.100.90",
		kind: "unknown" as const,
	};
	await box.scan([ETHERNET, ...MODEMS, unknown]);
	expect(box.bonded()).toContain("wwan9");
	await box.journal([journalEntry(MODEMS[0], "failed")]);
	expect(getNetworkInterfaces().wwan9).toMatchObject({
		usb: true,
		identitySettled: true,
	});
	expect(box.bonded()).not.toContain("wwan9");
});

test("a blocked modem reusing a healthy name cannot borrow its key after failed udev refresh", async () => {
	box = await realisticBox();
	await box.journal([journalEntry(MODEMS[0], "failed")]);
	await box.scan([ETHERNET], { failIdPaths: true, skipPhysical: true });
	const renamed = { ...MODEMS[0], ifname: "wwan1" };
	await box.scan([ETHERNET, renamed], {
		failIdPaths: true,
		skipPhysical: true,
	});
	expect(box.bonded()).not.toContain("wwan1");
	// Even a separately settled caller cannot reuse the removed scan evidence.
	expect(
		isHeldOutByModemBlock("wwan1", {
			...getNetworkInterfaces().wwan1,
			identitySettled: true,
		}),
	).toBe(true);
	await box.scan([ETHERNET, renamed], { failIdPaths: true });
	expect(getNetworkInterfaces().wwan1).toMatchObject({
		usb: true,
		identitySettled: true,
	});
	expect(box.bonded()).toEqual(["eth0"]);
});

test("the bond republishes when a modem is blocked or released", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	let changes = 0;
	onNetworkInterfacesChange(() => {
		changes++;
	});
	await box.journal([journalEntry(first, "failed")]);
	expect(changes).toBeGreaterThan(0);
	const after = changes;
	await box.journal([journalEntry(first, "failed")]);
	expect(changes).toBe(after);
	await box.journal([]);
	expect(changes).toBeGreaterThan(after);
});

test("a blocked IPv6-only modem's translated link leaves with it", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	setClatTranslationsForTest(
		new Map([
			["clat3", { parent: first.ifname, tun: "clat3", ipv4: "10.254.0.3" }],
		]),
	);
	try {
		const tun = {
			ip: "10.254.0.3",
			tp: 0,
			txb: 0,
			rxb: 0,
			enabled: true,
			error: 0,
		};
		expect(isBondCandidate("clat3", tun)).toBe(true);
		await box.journal([journalEntry(first, "failed")]);
		expect(isBondCandidate("clat3", tun)).toBe(false);
	} finally {
		setClatTranslationsForTest(new Map());
	}
});

test("a decommissioned modem never holds streaming", async () => {
	box = await realisticBox();
	const [first] = MODEMS;
	if (!first) throw new Error("fixture");
	await box.journal([journalEntry(first, "decommissioned")]);
	expect(streamingBlockingMutation()).toBeUndefined();
	expect(globalStreamHold()).toBeUndefined();
	expect(box.bonded()).toContain("eth0");
});

test("fresh physical evidence supersedes a stale blocked name and republishes a settled bond", async () => {
	box = await realisticBox();
	await box.journal([journalEntry(MODEMS[0], "failed")]);
	// Same name, newly observed unblocked socket; the failed roster read retains A.
	const replacement = { ...MODEMS[1], ifname: "wwan0", ip: MODEMS[0].ip };
	let changes = 0;
	const unsubscribe = onNetworkInterfacesChange(() => {
		changes++;
	});
	try {
		await box.scan([ETHERNET, replacement], { failIdPaths: true });
		expect(box.bonded()).toContain("wwan0");
		expect(changes).toBeGreaterThan(0);
		const settled = changes;
		await box.scan([ETHERNET, MODEMS[0]], { failIdPaths: true });
		expect(box.bonded()).not.toContain("wwan0");
		expect(changes).toBeGreaterThan(settled);
	} finally {
		unsubscribe();
	}
});
