import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	netdevLifetime,
	netdevWitness,
} from "../modules/network/netdev-lifetime.ts";
import {
	getNetworkInterfaceIncarnation,
	handleNetifMonitorEvent,
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import * as scanModule from "../modules/network/router-cellular-scan.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { wifiInterfaceReaders } from "../modules/wifi/wifi-concurrent-interface.ts";
import {
	firstSightIfconfig,
	firstSightPhysicalDevice,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";

type Reply = { ok: true; target: string } | { ok: false; code: string };
type Answer = Reply | Promise<Reply> | (() => Promise<Reply>);
const ok = (bus: string): Reply => ({ ok: true, target: `/sys/bus/${bus}` });
const err = (code: string): Reply => ({ ok: false, code });
const interfacePath = (name: string) =>
	`/sys/class/net/${name}/device/subsystem`;
let unhandled: unknown[] = [];
const recordUnhandled = (error: unknown) => {
	unhandled.push(error);
};

beforeEach(() => {
	scanModule.resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
	jest.useFakeTimers();
	unhandled = [];
	process.on("unhandledRejection", recordUnhandled);
});
afterEach(async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	process.off("unhandledRejection", recordUnhandled);
	expect(unhandled).toEqual([]);
	jest.restoreAllMocks();
	jest.useRealTimers();
	scanModule.resetUsbNetMarkers();
	resetNetifSnapshotForTest();
	resetBondOptOut();
});
function fixture(output: string, blocked: readonly string[]) {
	const scan = firstSightScan(output, { blocked, indexed: true });
	const answers = new Map<string, Answer[]>();
	const calls: string[] = [];
	const respond = async (path: string): Promise<Reply> => {
		calls.push(path);
		const queue = answers.get(path);
		const answer = queue?.length === 1 ? queue[0] : queue?.shift();
		if (answer === undefined)
			return path.endsWith("/device/subsystem")
				? err("ENOENT")
				: { ok: true, target: "/sys/devices/virtual/net/fixture" };
		return typeof answer === "function" ? answer() : await answer;
	};
	spyOn(
		scanModule.defaultRouterCellularScanDeps,
		"readLinkResult",
	).mockImplementation(respond);
	return {
		...scan,
		entered: scan.enteredFor(blocked[0] ?? MODEM),
		calls,
		set: (name: string, ...values: Answer[]) =>
			answers.set(interfacePath(name), values),
		setClass: (name: string, ...values: Answer[]) =>
			answers.set(`/sys/class/net/${name}`, values),
		count: (name: string) =>
			calls.filter((p) => p === interfacePath(name)).length,
	};
}
async function bound(
	f: ReturnType<typeof fixture>,
	publication: ReturnType<typeof updateNetif>,
) {
	await f.entered;
	jest.advanceTimersByTime(2000);
	await publication;
}
function monitor(name: string) {
	handleNetifMonitorEvent({
		type: "device-state",
		device: name,
		state: "disconnected",
	});
	handleNetifMonitorEvent({
		type: "device-state",
		device: name,
		state: "connected",
	});
}

test("C1 bus timer resolves after the bound timer in the same 2000 ms turn", async () => {
	const f = fixture(firstSightIfconfig(MODEM, IP), [MODEM]);
	const answer = Promise.withResolvers<Reply>();
	f.set(MODEM, answer.promise);
	const p = updateNetif();
	try {
		await f.entered;
		setTimeout(() => answer.resolve(ok("usb")), 2000);
		jest.advanceTimersByTime(2000);
		await p;
		expect(genSrtlaBondEntries()).toEqual([]);
		f.release();
		await f.settle();
		expect(genSrtlaBondEntries()[0]?.linkId).toBe(
			firstSightPhysicalDevice().linkId,
		);
	} finally {
		answer.resolve(ok("usb"));
		f.release();
		await p;
		await f.settle();
	}
});

test("C2 hung classification holds only its name without another timer advance", async () => {
	const f = fixture(
		[
			firstSightIfconfig(MODEM, IP),
			firstSightIfconfig("eth9", "192.0.2.2"),
		].join("\n\n"),
		[MODEM, "eth9"],
	);
	const hung = Promise.withResolvers<Reply>();
	f.set(MODEM, hung.promise);
	f.set("eth9", ok("platform"));
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	const timer = spyOn(globalThis, "setTimeout");
	const p = updateNetif();
	try {
		await bound(f, p);
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(false);
		expect(netIfBuildMsg().eth9?.enabled).toBe(true);
		expect(timer.mock.calls.map(([, delay]) => delay)).toEqual([2000]);
		expect(
			warn.mock.calls.filter(([message]) =>
				String(message).startsWith("netdev bus link unreadable"),
			),
		).toHaveLength(1);
	} finally {
		hung.resolve(ok("usb"));
		f.release();
		await p;
		await f.settle();
	}
});

test("C3 EACCES retries once and then uses USB/platform transport", async () => {
	const f = fixture(
		[
			firstSightIfconfig(MODEM, IP),
			firstSightIfconfig("eth9", "192.0.2.2"),
		].join("\n\n"),
		[MODEM, "eth9"],
	);
	f.set(MODEM, err("EACCES"), ok("usb"));
	f.set("eth9", err("EACCES"), ok("platform"));
	const p = updateNetif();
	try {
		await bound(f, p);
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(false);
		expect(netIfBuildMsg().eth9?.enabled).toBe(true);
		expect(f.count(MODEM)).toBe(2);
		expect(f.count("eth9")).toBe(2);
	} finally {
		f.release();
		await p;
		await f.settle();
	}
});

for (const release of ["deadline", "coverage"] as const) {
	test(`${release === "deadline" ? "C4" : "C5"} unreadable Ethernet is released visibly with one new warn`, async () => {
		const output = firstSightIfconfig("eth9", "192.0.2.2");
		const f = fixture(output, ["eth9"]);
		f.set("eth9", err("EACCES"));
		const warnings: unknown[][] = [];
		spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args);
			return logger;
		});
		const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
			() => {},
		);
		let p = updateNetif();
		const observations: boolean[] = [];
		try {
			await bound(f, p);
			observations.push(netIfBuildMsg().eth9?.enabled === true);
			broadcast.mockClear();
			if (release === "deadline")
				for (const now of [5000, 10000, 14999, 15000]) {
					f.clock.now = now;
					p = updateNetif();
					await new Promise<void>((r) => setImmediate(r));
					jest.advanceTimersByTime(2000);
					await p;
					observations.push(netIfBuildMsg().eth9?.enabled === true);
				}
			else {
				f.clock.now = 5000;
				f.release();
				await f.settle();
				observations.push(netIfBuildMsg().eth9?.enabled === true);
			}
			const newWarns = warnings.filter(([message]) =>
				String(message).startsWith("netdev bus link unreadable"),
			);
			const frames = broadcast.mock.calls
				.filter(([kind]) => kind === "netif")
				.map(([, payload]) => payload);
			expect(observations).toEqual(
				release === "deadline"
					? [false, false, false, false, true]
					: [false, true],
			);
			expect(newWarns).toHaveLength(1);
			expect(newWarns[0]?.[1]).toEqual({ ifname: "eth9", code: "EACCES" });
			expect(frames).toContainEqual(
				expect.objectContaining({
					eth9: expect.objectContaining({ enabled: true }),
				}),
			);
		} finally {
			f.release();
			await p;
			await f.settle();
		}
	});
}

test.each(["br-test", "vlan-test", "bond-test", "veth-test"])(
	"C6 %s with no device link stays usable",
	async (name) => {
		const f = fixture(firstSightIfconfig(name, "192.0.2.2"), [name]);
		f.set(name, err("ENOENT"));
		f.setClass(name, { ok: true, target: `/sys/devices/virtual/net/${name}` });
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const p = updateNetif();
		try {
			await bound(f, p);
			expect(netIfBuildMsg()[name]?.enabled).toBe(true);
			expect(
				genSrtlaBondEntriesForLocalIpAddress("192.0.2.9").map((e) => e.iface),
			).toEqual([name]);
			expect(
				warn.mock.calls.filter(([m]) =>
					String(m).startsWith("netdev bus link unreadable"),
				),
			).toHaveLength(0);
		} finally {
			f.release();
			await p;
			await f.settle();
		}
	},
);

test("C7 vanished netdev leaves the snapshot row on main behavior", async () => {
	const f = fixture(firstSightIfconfig("eth9", "192.0.2.2"), ["eth9"]);
	f.set("eth9", err("ENOENT"));
	f.setClass("eth9", err("ENOENT"));
	const warn = spyOn(logger, "warn");
	const p = updateNetif();
	try {
		await bound(f, p);
		expect(netIfBuildMsg().eth9?.enabled).toBe(true);
		expect(genSrtlaBondEntries().map((e) => e.iface)).toEqual(["eth9"]);
		expect(warn).not.toHaveBeenCalled();
	} finally {
		f.release();
		await p;
		await f.settle();
	}
});

for (const kind of ["C8", "C2b", "C8b"] as const) {
	test(`${kind} replacement re-read is fenced and bounded`, async () => {
		const output = firstSightIfconfig("eth9", "192.0.2.2");
		const f = fixture(output, ["eth9"]);
		processIfconfigOutput(output.replace(/\s+inet [^\n]+\n/, "\n"));
		const old = Promise.withResolvers<Reply>();
		const reread = Promise.withResolvers<Reply>();
		const entered = Promise.withResolvers<void>();
		f.set("eth9", old.promise, async () => {
			if (kind === "C8b") monitor("eth9");
			entered.resolve();
			return kind === "C8" ? ok("pci") : reread.promise;
		});
		const warnings: unknown[][] = [];
		spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args);
			return logger;
		});
		const timer = spyOn(globalThis, "setTimeout");
		const p = updateNetif();
		try {
			await f.entered;
			monitor("eth9");
			old.resolve(ok("usb"));
			await new Promise<void>((r) => setImmediate(r));
			jest.advanceTimersByTime(2000);
			if (
				kind !== "C8" &&
				(await Promise.race([
					entered.promise.then(() => true),
					p?.then(() => false),
				]))
			) {
				jest.advanceTimersByTime(250);
				if (kind === "C8b") reread.resolve(ok("pci"));
			}
			await p;
			expect(netIfBuildMsg().eth9?.enabled).toBe(kind === "C8");
			expect(f.count("eth9")).toBe(2);
			if (kind !== "C8") {
				expect(timer.mock.calls.map(([, delay]) => delay)).toEqual([2000, 250]);
				expect(
					warnings
						.filter(([message]) =>
							String(message).startsWith("netdev bus link unreadable"),
						)
						.map(([, meta]) => meta),
				).toContainEqual(
					expect.objectContaining({
						code: kind === "C2b" ? "TIMEOUT" : "STALE",
					}),
				);
			}
			if (kind === "C8")
				expect(genSrtlaBondEntries().map((e) => e.iface)).toEqual(["eth9"]);
			if (kind === "C8")
				expect(
					genSrtlaBondEntriesForLocalIpAddress("192.0.2.9").map((e) => e.iface),
				).toEqual(["eth9"]);
			else {
				expect(genSrtlaBondEntries()).toEqual([]);
				expect(genSrtlaBondEntriesForLocalIpAddress("192.0.2.9")).toEqual([]);
				const covered = Promise.withResolvers<void>();
				const off = scanModule.onUsbNetScanCommitted(() => {
					if (scanModule.usbNetScanCovers("eth9")) covered.resolve();
				});
				try {
					f.release();
					await f.settle();
					await covered.promise;
				} finally {
					off();
				}
				expect(netIfBuildMsg().eth9?.enabled).toBe(true);
			}
		} finally {
			old.resolve(ok("usb"));
			reread.resolve(ok("pci"));
			f.release();
			await p;
			await f.settle();
		}
	});
}

test("an earlier unreadable bus does not hold Ethernet on its first indexed return", async () => {
	const f = fixture(firstSightIfconfig("eth9", "192.0.2.2"), []);
	f.setIpUnavailable();
	f.set("eth9", err("EIO"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	processIfconfigOutput("");
	f.setIndex("eth9", 29);
	await updateNetif();
	await f.settle();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);
});

test("an unrelated USB scan cannot publish an indexed predecessor", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, []);
	f.set(MODEM, ok("usb"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);

	f.setIndex(MODEM, 29);
	f.setOutput(`${output}\n\n${firstSightIfconfig("eth9", "192.0.2.2")}`);
	const seen: string[][] = [];
	const off = scanModule.onUsbNetScanCommitted(() => {
		seen.push(genSrtlaBondEntries().map((entry) => entry.iface));
	});
	try {
		await updateNetif();
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain(MODEM);
		expect(genSrtlaBondEntries().map((entry) => entry.iface)).not.toContain(
			MODEM,
		);
		await f.settle();
		expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);
	} finally {
		off();
	}
});

test("a continuous USB link keeps its token on an index read failure and advances it on a MAC change", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, []);
	f.set(MODEM, ok("usb"));
	await updateNetif();
	const initial = getNetworkInterfaceIncarnation(MODEM);
	expect(initial).toBeDefined();
	// Neither ip nor the sysfs index answers: the sysfs node alone shows the
	// same kernel netdev, so the token stays.
	f.setIpUnavailable();
	f.setSysfsIndexUnavailable();
	await updateNetif();
	expect(getNetworkInterfaceIncarnation(MODEM)).toBe(initial);

	// Same node and index under a new MAC: same netdev, new local ingress token.
	f.setSysfsIndexUnavailable(false);
	f.setOutput(output.replace("02:00:00:00:00:01", "02:00:00:00:00:02"));
	await updateNetif();
	expect(getNetworkInterfaceIncarnation(MODEM)).not.toBe(initial);
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);
});

test("a periodic scan cannot publish the predecessor while ifconfig is pending", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, []);
	f.set(MODEM, ok("usb"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);

	const ifconfig = Promise.withResolvers<void>();
	f.holdIfconfig(ifconfig.promise);
	f.setIndex(MODEM, 29);
	const refresh = updateNetif();
	const seen: string[][] = [];
	const off = scanModule.onUsbNetScanCommitted(() => {
		seen.push(genSrtlaBondEntries().map((entry) => entry.iface));
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		// The first scan sees the replaced witness, retires the predecessor and
		// withholds its stale reading; the next scan commits the successor's.
		await f.settle();
		expect(seen).toEqual([]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await f.settle();
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain(MODEM);
	} finally {
		off();
		ifconfig.resolve();
		await refresh;
	}
});

test("a late USB descriptor is remembered even after a scan drops the disconnected name", async () => {
	const f = fixture(firstSightIfconfig(MODEM, IP), [MODEM]);
	f.setIpUnavailable();
	f.set(MODEM, err("EIO"));
	const first = updateNetif();
	try {
		await bound(f, first);
		f.release();
		await f.settle();
		expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual([MODEM]);
		processIfconfigOutput("");
		await scanModule.refreshUsbNetMarkers([]);
		expect(scanModule.getUsbPhysicalDescriptor(MODEM)).toBeUndefined();

		f.setIndex(MODEM, 29);
		f.block(MODEM);
		const returned = updateNetif();
		try {
			await f.enteredFor(MODEM);
			jest.advanceTimersByTime(2000);
			await returned;
			expect(scanModule.isUsbReplacementPending(MODEM)).toBe(true);
		} finally {
			f.release();
			await returned;
			await f.settle();
		}
	} finally {
		f.release();
		await first;
	}
});

test("an unreadable bus that becomes platform releases on the wire with unchanged raw state", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, ["eth9"]);
	f.set("eth9", err("EIO"));
	const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
		() => {},
	);
	const warn = spyOn(logger, "warn");
	const changes: boolean[] = [];
	const off = onNetworkInterfacesChange(() => {
		changes.push(netIfBuildMsg().eth9?.enabled === true);
	});
	let p = updateNetif();
	try {
		await bound(f, p);
		expect(netIfBuildMsg().eth9?.enabled).toBe(false);
		processIfconfigOutput(output);
		expect(netIfBuildMsg().eth9?.enabled).toBe(false);
		broadcast.mockClear();
		f.set("eth9", ok("platform"));
		p = updateNetif();
		await new Promise<void>((resolve) => setImmediate(resolve));
		jest.advanceTimersByTime(2000);
		await p;
		expect(changes).toEqual([false, true]);
		expect(
			broadcast.mock.calls
				.filter(([kind]) => kind === "netif")
				.map(([, payload]) => payload),
		).toContainEqual(
			expect.objectContaining({
				eth9: expect.objectContaining({ enabled: true }),
			}),
		);
		expect(
			warn.mock.calls.filter(([message]) =>
				String(message).startsWith("netdev bus link unreadable"),
			),
		).toHaveLength(1);
	} finally {
		off();
		f.release();
		await p;
		await f.settle();
	}
});

test("a late old USB completion cannot overwrite a fresh replacement PCI read", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, ["eth9"]);
	processIfconfigOutput(output.replace(/\s+inet [^\n]+\n/, "\n"));
	const old = Promise.withResolvers<Reply>();
	f.set("eth9", old.promise, async () => {
		setImmediate(() => old.resolve(ok("usb")));
		return ok("pci");
	});
	const p = updateNetif();
	try {
		await f.entered;
		monitor("eth9");
		jest.advanceTimersByTime(2000);
		await p;
		expect(f.count("eth9")).toBe(2);
		expect(netIfBuildMsg().eth9?.enabled).toBe(true);
		expect(genSrtlaBondEntries()).toEqual([
			{ iface: "eth9", ip: "192.0.2.2", linkId: "lnk_7b0bd35950ec673f" },
		]);
	} finally {
		old.resolve(ok("usb"));
		f.release();
		await p;
		await f.settle();
	}
});

test("supersession during the awaited I/O turn cannot publish the older OS snapshot", async () => {
	const f = fixture(firstSightIfconfig(MODEM, IP), [MODEM]);
	f.set(MODEM, ok("usb"));
	const p = updateNetif();
	const replacement = Promise.withResolvers<void>();
	await f.entered;
	setImmediate(() => {
		f.setOutput(firstSightIfconfig("eth9", "192.0.2.2"));
		f.release();
		void updateNetif()?.then(replacement.resolve, replacement.reject);
	});
	try {
		jest.advanceTimersByTime(2000);
		await p;
		await replacement.promise;
		expect(Object.keys(netIfBuildMsg())).toEqual(["eth9"]);
	} finally {
		f.release();
		await p;
		await f.settle();
	}
});

test("a MAC change on the same netdev advances the token even when its first poll is superseded", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, []);
	f.set(MODEM, ok("usb"));
	await updateNetif();
	const initial = getNetworkInterfaceIncarnation(MODEM);
	expect(initial).toBeDefined();

	// The first poll records the new MAC, then waits on a sibling's scan and is
	// superseded by a second poll that sees the same new MAC.
	f.block("eth9");
	f.set("eth9", ok("pci"));
	f.setOutput(
		`${output.replace("02:00:00:00:00:01", "02:00:00:00:00:02")}\n\n${firstSightIfconfig("eth9", "192.0.2.2")}`,
	);
	const first = updateNetif();
	await f.enteredFor("eth9");
	const second = updateNetif();
	await new Promise<void>((resolve) => setImmediate(resolve));
	f.release();
	jest.advanceTimersByTime(2000);
	await first;
	await second;
	await f.settle();
	expect(getNetworkInterfaceIncarnation(MODEM)).not.toBe(initial);
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);
});

test("a name first seen through its USB descriptor alone keeps the replacement hold after removal", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, []);
	f.set(MODEM, err("EIO"));
	await updateNetif();
	await f.settle();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);

	f.setOutput("");
	await updateNetif();
	expect(netIfBuildMsg()[MODEM]).toBeUndefined();

	// The successor's scan cannot run and its bus stays unreadable: only the
	// hold keeps it out past the identity deadline.
	f.setIndex(MODEM, 29);
	f.setOutput(output);
	f.block(MODEM);
	const p = updateNetif();
	try {
		await f.enteredFor(MODEM);
		jest.advanceTimersByTime(2000);
		await p;
		f.clock.now += 20_000;
		expect(genSrtlaBondEntries().map((entry) => entry.iface)).not.toContain(
			MODEM,
		);
	} finally {
		f.release();
		await p;
	}
	await f.settle();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toContain(MODEM);
});

test("a USB scan that sees a non-USB name replaced holds the successor like the poll does", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	// The scan, not the poll, is first to see a different netdev under the
	// name, and neither the bus nor a descriptor identifies the successor.
	f.setIndex("eth9", 29);
	f.set("eth9", err("EIO"));
	await f.settle();
	await updateNetif();
	f.clock.now += 20_000;
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).not.toContain(
		"eth9",
	);

	// A current non-USB bus read is positive evidence and lifts the hold.
	f.set("eth9", ok("pci"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);
});

test("a scan that alone saw the netdev change holds the successor when no later read can show it", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	// The poll records only the kernel index: the sysfs node is unreadable.
	f.setSysfsNodeUnavailable();
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	// The scan's own first read sees the node, then a different netdev takes the
	// name while the scan waits. At the end only the new node is readable, so
	// nothing but the scan's comparison shows the replacement.
	f.setSysfsNodeUnavailable(false);
	f.block("eth9");
	const scan = f.settle();
	await f.enteredFor("eth9");
	f.setIndex("eth9", 29);
	f.setSysfsIndexUnavailable();
	f.set("eth9", err("EIO"));
	f.release();
	await scan;
	await f.settle();
	await updateNetif();
	f.clock.now += 20_000;
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).not.toContain(
		"eth9",
	);

	// A current non-USB bus read is positive evidence and lifts the hold.
	f.set("eth9", ok("pci"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);
});

test("a sample without a MAC keeps the published MAC, so the next MAC change still advances the token", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, []);
	f.set(MODEM, ok("usb"));
	await updateNetif();
	const initial = getNetworkInterfaceIncarnation(MODEM);
	expect(initial).toBeDefined();

	f.setOutput(output.replace("        ether 02:00:00:00:00:01\n", ""));
	await updateNetif();
	expect(getNetworkInterfaceIncarnation(MODEM)).toBe(initial);

	f.setOutput(output.replace("02:00:00:00:00:01", "02:00:00:00:00:02"));
	await updateNetif();
	expect(getNetworkInterfaceIncarnation(MODEM)).not.toBe(initial);
});

test("wireless sysfs read while another netdev takes the name cannot lift a held radio's hold", async () => {
	const RADIO = "wlan9";
	const f = fixture(firstSightIfconfig(RADIO, "192.0.2.3"), []);
	f.set(RADIO, ok("usb"));
	await updateNetif();
	scanModule.holdUsbReplacementIdentity(RADIO);

	// The poll validated this netdev; a different one takes the name while the
	// wireless evidence is read, so that evidence is not this row's.
	let swapped = false;
	spyOn(wifiInterfaceReaders, "pathExists").mockImplementation((path) => {
		if (!path.startsWith(`/sys/class/net/${RADIO}/`)) return false;
		if (!swapped) {
			swapped = true;
			f.setIndex(RADIO, 29);
		}
		return true;
	});
	await updateNetif();
	expect(scanModule.isUsbReplacementPending(RADIO)).toBe(true);
});

test("a replacement a poll sample saw is kept until a completed sample, even when no later read can show it", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	// Recorded by index alone: the node is unreadable at first publication.
	f.setSysfsNodeUnavailable();
	await updateNetif();
	const initial = getNetworkInterfaceIncarnation("eth9");
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	// The next sample reads the node before ifconfig; a different netdev takes
	// the name meanwhile and is readable only by its node, so the sample sees
	// the change and retries. By the retry's own reads nothing is readable.
	f.setSysfsNodeUnavailable(false);
	f.setIpUnavailable();
	const first = Promise.withResolvers<void>();
	const retry = Promise.withResolvers<void>();
	const ticks = async () => {
		for (let tick = 0; tick < 3; tick++)
			await new Promise<void>((resolve) => setImmediate(resolve));
	};
	f.holdIfconfig(first.promise);
	const p = updateNetif();
	await ticks();
	f.setIndex("eth9", 29);
	f.setSysfsIndexUnavailable();
	f.set("eth9", err("EIO"));
	first.resolve();
	f.holdIfconfig(retry.promise);
	await ticks();
	f.setSysfsNodeUnavailable();
	retry.resolve();
	await p;
	// The next completed sample still cannot show the change; the observation
	// the first sample made retires the lifetime.
	await updateNetif();
	f.clock.now += 20_000;
	expect(getNetworkInterfaceIncarnation("eth9")).not.toBe(initial);
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).not.toContain(
		"eth9",
	);
});

test("a scan whose first read already differs from the recorded netdev retires it without a corroborating final read", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	// A different netdev holds the name when the scan starts; by its end no
	// sysfs witness is readable, and the poll cannot see the change either.
	f.setIndex("eth9", 29);
	f.setIpUnavailable();
	f.block("eth9");
	const scan = f.settle();
	await f.enteredFor("eth9");
	f.setSysfsIndexUnavailable();
	f.setSysfsNodeUnavailable();
	f.set("eth9", err("EIO"));
	f.release();
	await scan;
	await updateNetif();
	f.clock.now += 20_000;
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).not.toContain(
		"eth9",
	);
});

test("a confirmed replacement holds a Wi-Fi name with no USB history until its successor shows wireless evidence", async () => {
	const RADIO = "wlan9";
	const f = fixture(firstSightIfconfig(RADIO, "192.0.2.3"), []);
	f.set(RADIO, ok("pci"));
	await updateNetif();
	expect(scanModule.isUsbReplacementPending(RADIO)).toBe(false);

	// A different netdev takes the name; it reads as USB and shows no wireless
	// sysfs, so nothing yet says it is a radio with its own lifetime.
	f.setIndex(RADIO, 29);
	f.set(RADIO, ok("usb"));
	await updateNetif();
	expect(scanModule.isUsbReplacementPending(RADIO)).toBe(true);
});

test("a held radio's removal is not judged by a name-only wireless lookup that may describe another radio", async () => {
	const RADIO = "wlan9";
	const f = fixture(firstSightIfconfig(RADIO, "192.0.2.3"), []);
	f.set(RADIO, ok("usb"));
	await updateNetif();

	// Removed; whatever answers for the name's wireless sysfs at that moment is
	// not the radio that was published.
	spyOn(wifiInterfaceReaders, "pathExists").mockReturnValue(true);
	f.setOutput("");
	await updateNetif();
	expect(scanModule.isUsbReplacementPending(RADIO)).toBe(true);
});

test("wireless sysfs read while the name turns into a node-only netdev cannot release a row validated by index alone", async () => {
	const RADIO = "wlan9";
	const f = fixture(firstSightIfconfig(RADIO, "192.0.2.3"), []);
	f.set(RADIO, ok("usb"));
	f.setSysfsNodeUnavailable();
	await updateNetif();
	scanModule.holdUsbReplacementIdentity(RADIO);

	// While the wireless sysfs is read, a later radio takes the name and is
	// readable only by its node: disjoint from the index that validated the row.
	f.setIpUnavailable();
	let swapped = false;
	spyOn(wifiInterfaceReaders, "pathExists").mockImplementation((path) => {
		if (!path.startsWith(`/sys/class/net/${RADIO}/`)) return false;
		if (!swapped) {
			swapped = true;
			f.setIndex(RADIO, 29);
			f.setSysfsNodeUnavailable(false);
			f.setSysfsIndexUnavailable();
		}
		return true;
	});
	await updateNetif();
	expect(swapped).toBe(true);
	expect(scanModule.isUsbReplacementPending(RADIO)).toBe(true);
});

test("a non-USB bus read that reaches a node-only netdev cannot release a row validated by index alone", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", err("EIO"));
	f.setSysfsNodeUnavailable();
	await updateNetif();
	scanModule.holdUsbReplacementIdentity("eth9");

	// The positive bus read happens while a different netdev takes the name,
	// readable only by a node the index-only witness cannot be matched against.
	f.setIpUnavailable();
	let swapped = false;
	f.set("eth9", async () => {
		if (!swapped) {
			swapped = true;
			f.setIndex("eth9", 29);
			f.setSysfsNodeUnavailable(false);
			f.setSysfsIndexUnavailable();
		}
		return ok("pci");
	});
	await updateNetif();
	expect(swapped).toBe(true);
	expect(scanModule.isUsbReplacementPending("eth9")).toBe(true);
});

test("a witness disjoint from the recorded one retires the lifetime instead of merging into it", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	f.setSysfsNodeUnavailable();
	await updateNetif();
	const initial = getNetworkInterfaceIncarnation("eth9");

	// Recorded by index alone; the next poll can read only a node. Nothing
	// shows the two are one netdev, so the old lifetime must not absorb it.
	f.setIndex("eth9", 29);
	f.setSysfsNodeUnavailable(false);
	f.setSysfsIndexUnavailable();
	f.setIpUnavailable();
	await updateNetif();
	expect(getNetworkInterfaceIncarnation("eth9")).not.toBe(initial);
});

test("a non-USB bus read while the netdev becomes unreadable cannot release a held name", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", err("EIO"));
	await updateNetif();
	scanModule.holdUsbReplacementIdentity("eth9");

	// The bus read is positive, but by the time it lands neither the index
	// nor the node is readable: nothing ties the read to the recorded netdev.
	f.setIpUnavailable();
	let unreadable = false;
	f.set("eth9", async () => {
		if (!unreadable) {
			unreadable = true;
			f.setSysfsIndexUnavailable();
			f.setSysfsNodeUnavailable();
		}
		return ok("pci");
	});
	await updateNetif();
	expect(unreadable).toBe(true);
	expect(scanModule.isUsbReplacementPending("eth9")).toBe(true);
});

test("a superseded poll that saw the replacement does not retire the successor a newer poll published", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	// The old poll reads the predecessor and waits on ifconfig.
	const gate = Promise.withResolvers<void>();
	const ticks = async () => {
		for (let tick = 0; tick < 3; tick++)
			await new Promise<void>((resolve) => setImmediate(resolve));
	};
	f.holdIfconfig(gate.promise);
	const old = updateNetif();
	await ticks();
	// A different netdev takes the name; a newer poll retires the predecessor
	// and publishes the successor.
	f.setIndex("eth9", 29);
	f.holdIfconfig(Promise.resolve());
	await updateNetif();
	const successor = getNetworkInterfaceIncarnation("eth9");
	expect(successor).toBeDefined();
	expect(scanModule.isUsbReplacementPending("eth9")).toBe(false);

	// The old poll resumes and sees the change it no longer owns.
	gate.resolve();
	await old;
	await updateNetif();
	expect(getNetworkInterfaceIncarnation("eth9")).toBe(successor);
	expect(scanModule.isUsbReplacementPending("eth9")).toBe(false);
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);
});

test("wireless sysfs cannot release a held radio when the final witness has a different node under the recorded index", async () => {
	const RADIO = "wlan9";
	const f = fixture(firstSightIfconfig(RADIO, "192.0.2.3"), []);
	f.set(RADIO, ok("usb"));
	await updateNetif();
	scanModule.holdUsbReplacementIdentity(RADIO);

	// Recorded (index, A). The read before the wireless lookup sees the index
	// and no node; the read after it sees the same index with node B, a reused
	// index under a different netdev.
	f.setSysfsNodeUnavailable();
	let swapped = false;
	spyOn(wifiInterfaceReaders, "pathExists").mockImplementation((path) => {
		if (!path.startsWith(`/sys/class/net/${RADIO}/`)) return false;
		if (!swapped) {
			swapped = true;
			f.setSysfsNodeUnavailable(false);
			f.setNode(RADIO, 99);
		}
		return true;
	});
	await updateNetif();
	expect(swapped).toBe(true);
	expect(scanModule.isUsbReplacementPending(RADIO)).toBe(true);
});

test("a bus read of a witness-less held row cannot be vouched for by a successor a later scan recorded", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	f.setIpUnavailable();
	f.setSysfsIndexUnavailable();
	f.setSysfsNodeUnavailable();
	await updateNetif();
	expect(genSrtlaBondEntries().map((entry) => entry.iface)).toEqual(["eth9"]);

	// Held and not yet covered by a scan. The PCI read finishes while the name
	// is still witness-less; then an unanchored successor appears and the
	// poll's own scan records its witness in the same presence epoch.
	scanModule.resetUsbNetMarkers();
	scanModule.holdUsbReplacementIdentity("eth9");
	f.block("eth9");
	const p = updateNetif();
	try {
		await f.enteredFor("eth9");
		for (let tick = 0; tick < 3; tick++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		f.setSysfsIndexUnavailable(false);
		f.setSysfsNodeUnavailable(false);
		f.setIndex("eth9", 29);
		f.release();
		await p;
		expect(netdevWitness("eth9")?.node).toBe("1:29");
		expect(scanModule.isUsbReplacementPending("eth9")).toBe(true);
	} finally {
		f.release();
		await p;
	}
});

test("a monitor removal of a witness-less row with USB history keeps the replacement hold", async () => {
	const output = firstSightIfconfig(MODEM, IP);
	const f = fixture(output, [MODEM]);
	f.set(MODEM, ok("usb"));
	f.setIpUnavailable();
	f.setSysfsIndexUnavailable();
	f.setSysfsNodeUnavailable();
	// The bus read records USB history before any scan covers the name.
	const p = updateNetif();
	try {
		await bound(f, p);
		expect(scanModule.usbNetScanCovers(MODEM)).toBe(false);

		// The monitor sees the name gone; nothing fences the poll for a row
		// without a witness, but its USB history still holds the successor.
		f.setOutput("");
		handleNetifMonitorEvent({
			type: "device-state",
			device: MODEM,
			state: "disconnected",
		});
		expect(scanModule.isUsbReplacementPending(MODEM)).toBe(true);
	} finally {
		f.release();
		await p;
	}
});

test("a poll cannot fuse the index ip addr reported with a node read after the name changed", async () => {
	const output = firstSightIfconfig("eth9", "192.0.2.2");
	const f = fixture(output, []);
	f.set("eth9", ok("pci"));
	// A monitor-only row recorded by its index alone.
	f.setIndex("eth9", 10);
	f.setSysfsNodeUnavailable();
	handleNetifMonitorEvent({
		type: "device-state",
		device: "eth9",
		state: "connected",
	});
	expect(netdevWitness("eth9")).toMatchObject({ ifindex: 10, node: undefined });
	const lifetime = netdevLifetime("eth9");

	// `ip addr` lists the predecessor's index; right after it a different
	// netdev takes the name. Sysfs answers only by node from here on.
	f.setSysfsNodeUnavailable(false);
	f.setSysfsIndexUnavailable();
	f.afterIpAddr(() => f.setIndex("eth9", 29));
	await updateNetif();
	expect(netdevWitness("eth9")).not.toMatchObject({
		ifindex: 10,
		node: "1:29",
	});
	expect(netdevLifetime("eth9")).not.toBe(lifetime);
});
