import { expect, test } from "bun:test";
import {
	type CellularPhysicalIO,
	type CellularSysctlIO,
	cellularPhysicalState,
	compareAndSetCellularSysctl,
	readCellularSysctl,
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
