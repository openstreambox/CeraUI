import { afterEach, expect, test } from "bun:test";
import { setClatTranslationsForTest } from "../modules/network/clat-translation.ts";
import {
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

test("L4: while a modem is blocked, a USB link with no udev path is held out; Ethernet never", async () => {
	box = await realisticBox();
	const [first, second, third] = MODEMS;
	if (!first || !second || !third) throw new Error("fixture");
	const unknown = { ifname: "wwan9", ip: "198.51.100.90" };
	await box.scan([ETHERNET, first, second, third, unknown]);
	// Without a block, an interface without a udev path bonds as before.
	expect(box.bonded()).toContain("wwan9");
	await box.journal([journalEntry(first, "failed")]);
	const usb = {
		ip: unknown.ip,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	};
	expect(isHeldOutByModemBlock("wwan9", { ...usb, usb: true })).toBe(true);
	expect(isHeldOutByModemBlock("wwan9", usb)).toBe(false);
	expect(isHeldOutByModemBlock("eth0", { ...usb, ip: ETHERNET.ip })).toBe(
		false,
	);
	expect(box.bonded()).toContain("eth0");
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
