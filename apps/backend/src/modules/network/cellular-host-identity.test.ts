import { expect, test } from "bun:test";
import {
	type CellularPhysicalIO,
	type CellularSysctlIO,
	cellularPhysicalState,
	compareAndSetCellularSysctl,
	compareAndSetScopedCellularSysctl,
	readCellularSysctl,
	readScopedCellularSysctl,
} from "./cellular-host-identity.ts";

const link = {
	ifname: "wwan0",
	ifindex: "17",
	usbDevice: "/synthetic/usb/one",
	netDevice: "/synthetic/usb/one/interface",
	generation: "usb-one",
};
const present: CellularPhysicalIO = {
	usbEpoch: async () => "usb-one",
	device: async () => link.netDevice,
	index: async () => "17",
};
test("USB loss, missing data link, replacement and unreadable identity stay distinct", async () => {
	const absent = Object.assign(new Error("absent"), { code: "ENOENT" });
	expect(await cellularPhysicalState(link, present)).toBe("present");
	expect(
		await cellularPhysicalState(link, {
			...present,
			usbEpoch: async () => {
				throw absent;
			},
		}),
	).toBe("usb-absent");
	expect(
		await cellularPhysicalState(link, {
			...present,
			device: async () => {
				throw absent;
			},
		}),
	).toBe("link-absent");
	expect(
		await cellularPhysicalState(link, { ...present, index: async () => "18" }),
	).toBe("replaced");
	expect(
		await cellularPhysicalState(link, {
			...present,
			usbEpoch: async () => {
				throw new Error("unknown");
			},
		}),
	).toBe("unknown");
});
test("a virtual link uses its own instance predicate for scoped IPv6 settings, never a fabricated USB identity", async () => {
	let value = "1",
		current = true,
		replaceOnOpen = false,
		writes = 0;
	const scoped = { ifname: "cclat1", current: async () => current },
		io: Pick<CellularSysctlIO, "open"> = {
			open: async (path) => {
				expect(path).toStartWith("/proc/sys/net/ipv6/conf/cclat1/");
				if (replaceOnOpen) current = false;
				return {
					readValue: async () => value,
					writeValue: async (next) => {
						value = next;
						writes++;
					},
					close: async () => undefined,
				};
			},
		};
	for (const key of ["autoconf", "accept_dad", "disable_ipv6"] as const) {
		value = "1";
		expect(
			await compareAndSetScopedCellularSysctl(scoped, key, "1", "0", io),
		).toBe(true);
		expect(value).toBe("0");
	}
	value = "3";
	expect(await readScopedCellularSysctl(scoped, "addr_gen_mode", io)).toBe("3");
	expect(
		await compareAndSetScopedCellularSysctl(
			scoped,
			"addr_gen_mode",
			"3",
			"1",
			io,
		),
	).toBe(true);
	expect(await readScopedCellularSysctl(scoped, "addr_gen_mode", io)).toBe("1");
	value = "2";
	expect(await readScopedCellularSysctl(scoped, "accept_dad", io)).toBe("2");
	expect(
		await readScopedCellularSysctl(scoped, "autoconf", io),
	).toBeUndefined();
	value = "-1";
	expect(await readScopedCellularSysctl(scoped, "accept_dad", io)).toBe("-1");
	expect(
		await compareAndSetScopedCellularSysctl(
			scoped,
			"accept_dad",
			"-1",
			"0",
			io,
		),
	).toBe(true);
	await expect(
		compareAndSetScopedCellularSysctl(scoped, "forwarding", "-1", "0", io),
	).rejects.toThrow("value");
	replaceOnOpen = true;
	value = "1";
	const before = writes;
	expect(
		await compareAndSetScopedCellularSysctl(scoped, "forwarding", "1", "0", io),
	).toBe(false);
	expect(writes).toBe(before);
});
test("per-link sysctls restore only an understood baseline and never touch a reused name", async () => {
	let value = "1",
		calls = 0,
		replaced = false;
	const events: string[] = [];
	const io: CellularSysctlIO = {
		state: async () => {
			calls++;
			return replaced && calls > 1 ? "replaced" : "present";
		},
		open: async (path) => {
			events.push(path);
			return {
				readValue: async () => value,
				writeValue: async (next) => {
					events.push("write");
					value = next;
				},
				close: async () => {
					events.push("close");
				},
			};
		},
	};
	expect(
		await compareAndSetCellularSysctl(link, "accept_ra_defrtr", "1", "0", io),
	).toBe(true);
	expect(value).toBe("0");
	expect(
		await compareAndSetCellularSysctl(link, "accept_ra_defrtr", "0", "1", io),
	).toBe(true);
	expect(value).toBe("1");
	calls = 0;
	replaced = true;
	events.length = 0;
	expect(
		await compareAndSetCellularSysctl(link, "accept_ra_defrtr", "1", "0", io),
	).toBe(false);
	expect(events).not.toContain("write");
	expect(events.at(-1)).toBe("close");
	replaced = false;
	value = "2";
	events.length = 0;
	expect(
		await compareAndSetCellularSysctl(link, "accept_ra_defrtr", "1", "0", io),
	).toBe(false);
	expect(events).not.toContain("write");
	expect(
		await readCellularSysctl(link, "accept_ra_defrtr", io),
	).toBeUndefined();
});

test("global and default sysctl names are refused even with a purported physical identity", async () => {
	let opened = false;
	const io: CellularSysctlIO = {
		state: async () => "present",
		open: async () => {
			opened = true;
			throw new Error("Unexpected open");
		},
	};
	for (const ifname of ["all", "default", "lo", ".", ".."])
		await expect(
			compareAndSetCellularSysctl(
				{ ...link, ifname },
				"forwarding",
				"0",
				"1",
				io,
			),
		).rejects.toThrow("identity");
	expect(opened).toBe(false);
});

test("a synchronous observation revocation vetoes a sysctl write after an awaited current read", async () => {
	let permitted = true,
		reads = 0,
		wrote = false,
		closed = false;
	expect(
		await compareAndSetScopedCellularSysctl(
			{
				ifname: "cclat1",
				writable: () => permitted,
				current: async () => {
					if (++reads === 2)
						queueMicrotask(() => {
							permitted = false;
						});
					return true;
				},
			},
			"forwarding",
			"0",
			"1",
			{
				open: async () => ({
					readValue: async () => "0",
					writeValue: async () => {
						wrote = true;
					},
					close: async () => {
						closed = true;
					},
				}),
			},
		),
	).toBe(false);
	expect(wrote).toBe(false);
	expect(closed).toBe(true);
});
