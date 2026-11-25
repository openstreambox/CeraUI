import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
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
