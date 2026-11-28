import { afterEach, expect, spyOn, test } from "bun:test";
import { createUsbEnumerator } from "@ceralive/modem-control";
import * as time from "../helpers/time.ts";
import {
	captureModemUnitLinkId,
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import { setClatTranslationsForTest } from "../modules/network/clat-translation.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	isHeldOutByModemBlock,
	onNetworkInterfacesChange,
} from "../modules/network/network-interfaces.ts";
import { getUsbPhysicalDescriptor } from "../modules/network/router-cellular-scan.ts";
import {
	globalStreamHold,
	streamingBlockingMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
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

test("a name that keeps the same address but changes ifindex cannot borrow the old modem key", async () => {
	box = await realisticBox();
	await box.scan(undefined, {
		ifindices: new Map([
			["wwan0", 10],
			["wwan1", 11],
			["wwan2", 12],
		]),
	});
	await box.journal([journalEntry(MODEMS[0], "device-absent-quarantine")]);
	expect(box.bonded()).toEqual(["eth0", "wwan1", "wwan2"]);

	// Both devices were replaced between polls. The kernel reports wwan1
	// again at the same address, now backed by the blocked USB slot.
	const renamed = { ...MODEMS[0], ifname: "wwan1", ip: MODEMS[1].ip };
	const links = [ETHERNET, renamed, MODEMS[2]];
	const ifindices = new Map([
		["wwan1", 21],
		["wwan2", 12],
	]);
	await box.scan(links, { ifindices, failIdPaths: true, skipPhysical: true });
	expect(box.bonded()).toEqual(["eth0", "wwan2"]);
	expect(getNetworkInterfaces().wwan1?.identitySettled).not.toBe(true);
	await box.scan(links, { ifindices, failIdPaths: true });
	expect(box.bonded()).toEqual(["eth0", "wwan2"]);
});

test("an observed USB return without an ifindex waits for a current scan", async () => {
	box = await realisticBox();
	await box.scan(undefined, {
		ifindices: new Map([
			["wwan0", 10],
			["wwan1", 11],
			["wwan2", 12],
		]),
	});
	await box.journal([journalEntry(MODEMS[0], "failed")]);
	await box.scan([ETHERNET, MODEMS[2]], { skipPhysical: true });
	const links = [
		ETHERNET,
		{ ...MODEMS[0], ifname: "wwan1", ip: MODEMS[1].ip },
		MODEMS[2],
	];
	await box.scan(links, {
		ifindices: new Map([["wwan2", 12]]),
		skipPhysical: true,
	});
	expect(box.bonded()).not.toContain("wwan1");
	await box.scan([links[0], MODEMS[1], links[2]], {
		ifindices: new Map([["wwan2", 12]]),
	});
	expect(box.bonded()).toContain("wwan1");
});

test("a USB return with the first readable index waits for current identity", async () => {
	box = await realisticBox();
	const links = [ETHERNET, MODEMS[1]];
	await box.scan(links, { ifindices: new Map() });
	expect(box.bonded()).toContain("wwan1");
	await box.scan([ETHERNET], { ifindices: new Map(), skipPhysical: true });
	const ifindices = new Map([["wwan1", 21]]);
	await box.scan(links, { ifindices, skipPhysical: true });
	expect(box.bonded()).not.toContain("wwan1");
	await box.scan(links, { ifindices });
	expect(box.bonded()).toContain("wwan1");
});

test("a healthy USB link stays admitted across repeated missing indices after its scan", async () => {
	box = await realisticBox();
	const links = [ETHERNET, MODEMS[1]];
	await box.scan(links, { ifindices: new Map([["wwan1", 11]]) });
	await box.scan(links, { ifindices: new Map() });
	await box.scan(links, { ifindices: new Map(), skipPhysical: true });
	expect(box.bonded()).toContain("wwan1");
});

test("a verified USB Ethernet replacement can be admitted without a serial or port key", async () => {
	box = await realisticBox();
	await box.scan([ETHERNET, USB_ETHERNET], {
		ifindices: new Map([[USB_ETHERNET.ifname, 11]]),
	});
	await box.scan([ETHERNET, USB_ETHERNET], {
		ifindices: new Map([[USB_ETHERNET.ifname, 21]]),
	});
	expect(box.bonded()).toContain(USB_ETHERNET.ifname);
});

test("a reliable modem unit and its original port remain quarantined after a move", async () => {
	box = await realisticBox();
	const original = { ...MODEMS[0], serial: "fixture-move-a981" };
	const moved = { ...MODEMS[1], serial: original.serial };
	const replacement = { ...MODEMS[0], serial: "fixture-other-c722" };
	await box.scan([ETHERNET, original]);
	const unitLinkId = genSrtlaBondEntries().find(
		(link) => link.iface === original.ifname,
	)?.linkId;
	expect(unitLinkId).toBeDefined();
	if (unitLinkId === undefined) throw new Error("fixture modem has no link ID");
	await box.journal([{ ...journalEntry(original, "failed"), unitLinkId }]);
	await box.scan([ETHERNET, replacement, moved]);
	expect(box.bonded()).toEqual(["eth0"]);
	expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.200")).toEqual([]);
	await box.scan([ETHERNET, replacement, { ...moved, serial: "" }]);
	expect(box.bonded()).toEqual(["eth0"]);
	expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.200")).toEqual([]);
	await box.scan([
		ETHERNET,
		replacement,
		{ ...moved, serial: "fixture-distinct-c914" },
	]);
	expect(box.bonded()).toEqual(["eth0", "wwan1"]);
	await box.journal([]);
	expect(box.bonded()).toEqual(["eth0", "wwan0", "wwan1"]);
});

test("an RM520 unit block holds its port and possible units without excluding a DW5821e", async () => {
	box = await realisticBox();
	const original = { ...MODEMS[0], serial: "rm520-fixture", pid: "0801" };
	const dw = {
		...MODEMS[1],
		serial: "0123456789ABCDEF",
		vid: "413c",
		pid: "81d7",
	};
	const unknownPort = { ifname: "wwan2", ip: MODEMS[2].ip, pid: "0801" };
	const dwNoPort = { ...dw, idPath: undefined };
	await box.scan([ETHERNET, original, dw, unknownPort]);
	const unitLinkId = genSrtlaBondEntries().find(
		(entry) => entry.iface === original.ifname,
	)?.linkId;
	if (unitLinkId === undefined) throw new Error("missing unit");
	await box.journal([
		{
			...journalEntry(original, "failed"),
			unitLinkId,
			deviceVidPid: "2c7c:0801",
		},
	]);
	const recovery = getPersistentNotifications(true).show.find(
		({ name }) => name === `modem_held_out:${stableKeyOf(original)}`,
	);
	expect(recovery?.params).toMatchObject({ links: "wwan0, wwan2" });
	expect(box.bonded()).toEqual(["eth0", dw.ifname]);
	expect(
		genSrtlaBondEntriesForLocalIpAddress("198.51.100.200").map(
			(entry) => entry.iface,
		),
	).toEqual([dw.ifname]);
	await box.scan([
		ETHERNET,
		{ ...original, serial: dw.serial, vid: dw.vid, pid: dw.pid },
		dwNoPort,
		unknownPort,
	]);
	expect(box.bonded()).toEqual(["eth0", dw.ifname]);
});

test.each(["usb-mode", "modem-config"] as const)(
	"a %s unit hold handles a same-vendor candidate with a changed PID",
	async (kind) => {
		box = await realisticBox();
		const original = {
			...MODEMS[0],
			vid: "1e0e",
			pid: "9001",
			serial: "unique-mode-fixture",
		};
		const returned = { ...MODEMS[1], vid: "1e0e", pid: "9011" };
		const unrelated = { ...MODEMS[2], vid: "413c", pid: "9011" };
		await box.scan([ETHERNET, original]);
		const unitLinkId = genSrtlaBondEntries().find(
			(entry) => entry.iface === original.ifname,
		)?.linkId;
		if (unitLinkId === undefined) throw new Error("missing unit");
		await box.journal([
			{
				...journalEntry(original, "failed", kind),
				deviceVidPid: "1e0e:9001",
				unitLinkId,
			},
		]);
		await box.scan([ETHERNET, returned, unrelated]);
		expect(box.bonded()).toEqual(
			kind === "usb-mode"
				? ["eth0", unrelated.ifname]
				: ["eth0", returned.ifname, unrelated.ifname],
		);
		expect(
			genSrtlaBondEntriesForLocalIpAddress("198.51.100.200").map(
				(entry) => entry.iface,
			),
		).toEqual(
			kind === "usb-mode"
				? [unrelated.ifname]
				: [returned.ifname, unrelated.ifname],
		);
	},
);

test("a decommissioned port raises a notice when a replacement link appears", async () => {
	box = await realisticBox();
	const device = MODEMS[0];
	const noticeName = `modem_held_out:${stableKeyOf(device)}`;
	const notice = () =>
		getPersistentNotifications(true).show.find(
			({ name }) => name === noticeName,
		);
	await box.scan([ETHERNET]);
	await box.journal([
		{ ...journalEntry(device, "decommissioned"), deviceVidPid: "2c7c:1234" },
	]);
	expect(notice()).toBeUndefined();
	await box.scan([ETHERNET, device]);
	expect(box.bonded()).toEqual(["eth0"]);
	expect(notice()?.params).toMatchObject({ links: device.ifname });
	await box.scan([ETHERNET]);
	expect(notice()).toBeUndefined();
});

test("a udev serial and its raw sysfs spelling keep the moved unit quarantined", async () => {
	box = await realisticBox();
	const original = { ...MODEMS[0], serial: "fixture  ABC/123" };
	const moved = { ...MODEMS[1], serial: original.serial };
	const replacement = { ...MODEMS[0], serial: "fixture-distinct" };
	const udev = [
		"P: /devices/platform/test/usb1/1-1",
		"E: DEVTYPE=usb_device",
		"E: ID_VENDOR_ID=2c7c",
		"E: ID_MODEL_ID=0801",
		`E: ID_PATH=${stableKeyOf(original)}`,
		"E: ID_SERIAL_SHORT=fixture_ABC_123",
	].join("\n");
	await box.scan([ETHERNET, original]);
	setMutationCaptureDeps(
		createUsbEnumerator({ readUdevDatabase: async () => udev }),
	);
	try {
		const unitLinkId = await captureModemUnitLinkId(stableKeyOf(original));
		if (unitLinkId === undefined)
			throw new Error("fixture unit was not captured");
		await box.journal([{ ...journalEntry(original, "failed"), unitLinkId }]);
		await box.scan([ETHERNET, replacement, moved]);
		expect(box.bonded()).toEqual(["eth0"]);
		expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.200")).toEqual([]);
	} finally {
		resetMutationCaptureDeps();
	}
});

test("the local CLAT sender checks the held parent even when its link identity was evicted", async () => {
	box = await realisticBox();
	const modem = { ...MODEMS[0], ip: "" };
	const tun = { ifname: "clat3", ip: "10.254.0.3", kind: "ethernet" as const };
	const links = [ETHERNET, modem, tun];
	await box.scan(links, {
		ifindices: new Map([
			[modem.ifname, 11],
			[tun.ifname, 30],
		]),
	});
	setClatTranslationsForTest(
		new Map([
			[tun.ifname, { parent: modem.ifname, tun: tun.ifname, ipv4: tun.ip }],
		]),
	);
	try {
		expect(box.bonded()).toContain(tun.ifname);
		expect(genSrtlaBondEntriesForLocalIpAddress("10.254.0.4")).toHaveLength(1);
		await box.scan(links, {
			ifindices: new Map([
				[modem.ifname, 21],
				[tun.ifname, 30],
			]),
			skipPhysical: true,
		});
		expect(genSrtlaBondEntriesForLocalIpAddress("10.254.0.4")).toEqual([]);
		expect(box.bonded()).not.toContain(tun.ifname);
		await box.scan([ETHERNET, tun], { skipPhysical: true });
		expect(genSrtlaBondEntriesForLocalIpAddress("10.254.0.4")).toEqual([]);
		expect(box.bonded()).not.toContain(tun.ifname);
	} finally {
		setClatTranslationsForTest(new Map());
	}
});

test("a local translator requires a current mapped modem parent", async () => {
	box = await realisticBox();
	const modem = { ...MODEMS[0], ip: "" };
	const tun = { ifname: "clat3", ip: "10.254.0.3", kind: "ethernet" as const };
	await box.scan([ETHERNET, modem, tun]);
	setClatTranslationsForTest(
		new Map([
			[tun.ifname, { parent: modem.ifname, tun: tun.ifname, ipv4: tun.ip }],
		]),
	);
	try {
		expect(genSrtlaBondEntriesForLocalIpAddress("10.254.0.4")).toHaveLength(1);
		await box.scan([ETHERNET, tun]);
		expect(genSrtlaBondEntriesForLocalIpAddress("10.254.0.4")).toEqual([]);
	} finally {
		setClatTranslationsForTest(new Map());
	}
});

test("a known ifindex survives disconnection and distinguishes return from replacement", async () => {
	box = await realisticBox();
	const links = [ETHERNET, MODEMS[1], MODEMS[2]];
	const opened = box;
	const scan = (index: number) =>
		opened.scan(links, {
			ifindices: new Map([
				["wwan1", index],
				["wwan2", 12],
			]),
			skipPhysical: true,
		});
	await scan(11);
	await box.scan([ETHERNET, MODEMS[2]], { skipPhysical: true });
	await scan(11);
	// The train retires descriptors on removal, even if the ifindex returns.
	expect(box.bonded()).not.toContain("wwan1");
	await box.scan(links, {
		ifindices: new Map([
			["wwan1", 11],
			["wwan2", 12],
		]),
	});
	expect(box.bonded()).toContain("wwan1");
	await box.scan([ETHERNET, MODEMS[2]], { skipPhysical: true });
	await scan(21);
	expect(box.bonded()).not.toContain("wwan1");
});

test("a replacement cannot publish the old descriptor or age into fallback admission", async () => {
	box = await realisticBox();
	const links = [ETHERNET, MODEMS[1]];
	await box.scan(links, { ifindices: new Map([["wwan1", 11]]) });
	const index = new Map([["wwan1", 21]]);
	const clock = spyOn(time, "getms").mockReturnValue(1);
	try {
		await box.scan(links, { ifindices: index, skipPhysical: true });
		expect(getUsbPhysicalDescriptor("wwan1")).toBeUndefined();
		clock.mockReturnValue(20_000);
		await box.scan(links, {
			ifindices: index,
			skipPhysical: true,
			now: 20_000,
		});
		expect(box.bonded()).toEqual(["eth0"]);
		await box.scan([ETHERNET, { ifname: "wwan1", ip: MODEMS[1].ip }], {
			ifindices: index,
		});
		expect(box.bonded()).toEqual(["eth0"]);
		await box.scan(links, { ifindices: index });
		expect(box.bonded()).toEqual(["eth0", "wwan1"]);
	} finally {
		clock.mockRestore();
	}
});

test("a new unit gets its own link identity while the unresolved port blocks every sender", async () => {
	box = await realisticBox();
	const original = { ...MODEMS[1], serial: "fixture-modem-a981" };
	const replacement = { ...original, serial: "fixture-modem-b43e" };
	await box.scan([ETHERNET, original], { ifindices: new Map([["wwan1", 11]]) });
	const originalId = genSrtlaBondEntries().find(
		(row) => row.iface === "wwan1",
	)?.linkId;
	expect(originalId).toBeDefined();
	await box.journal([journalEntry(original, "device-absent-quarantine")]);
	await box.scan([ETHERNET, replacement], {
		ifindices: new Map([["wwan1", 21]]),
	});
	expect(stableKeyOf(replacement)).toBe(stableKeyOf(original));
	expect(box.bonded()).toEqual(["eth0"]);
	expect(genSrtlaBondEntriesForLocalIpAddress("198.51.100.200")).toEqual([]);
	await box.journal([]);
	const current = genSrtlaBondEntries().find((row) => row.iface === "wwan1");
	expect(current?.idPath).toBe(original.idPath);
	expect(current?.linkId).toBeDefined();
	expect(current?.linkId).not.toBe(originalId);
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

test("a fresh scan republishes an unchanged unblocked device after its name reappears", async () => {
	box = await realisticBox();
	await box.journal([journalEntry(MODEMS[0], "failed")]);
	await box.scan([ETHERNET], { skipPhysical: true });
	const admitted: boolean[] = [];
	const unsubscribe = onNetworkInterfacesChange(() => {
		if (getNetworkInterfaces().wwan1)
			admitted.push(box?.bonded().includes("wwan1") ?? false);
	});
	try {
		// Include the full original scan set so descriptor/coverage sets are unchanged.
		await box.scan([ETHERNET, ...MODEMS]);
		expect(admitted).toEqual([false, true]);
	} finally {
		unsubscribe();
	}
});
