import { expect, test } from "bun:test";
import {
	type DbusTransport,
	type MethodCall,
	type SignalListener,
	variant,
} from "@ceralive/modem-control/transport";
import {
	acquireCellularNmControl,
	type CellularNmControlDeps,
	parseCellularNmDevice,
} from "./cellular-nm-control.ts";

const link = {
	ifname: "wwan0",
	ifindex: "17",
	netDevice: "synthetic-interface",
	usbDevice: "synthetic-usb",
	generation: "one",
};
const path = "/org/freedesktop/NetworkManager/Devices/4",
	modem = "/org/freedesktop/ModemManager1/Modem/2";
function fixture() {
	let connected = false,
		managed = true,
		ipIface = "wwan0",
		udi = modem,
		iface = "ttyUSB7",
		present = true,
		revoked = 0;
	let signal: SignalListener = () => {};
	const calls: MethodCall[] = [];
	const transport: DbusTransport = {
		connect: async () => {
			connected = true;
		},
		disconnect: async () => {
			connected = false;
		},
		isConnected: () => connected,
		on: () => {},
		off: () => {},
		subscriptionCount: () => 1,
		subscribeSignal: async (_, listener) => {
			signal = listener;
			return { unsubscribe: async () => {} };
		},
		callMethod: async (call) => {
			calls.push(call);
			if (call.member === "GetNameOwner")
				return { signature: "s", body: [":1.17"] };
			if (call.member === "GetDeviceByIpIface") {
				expect(call.args).toEqual(["wwan0"]);
				return { signature: "o", body: [path] };
			}
			if (call.member === "GetAll")
				return {
					signature: "a{sv}",
					body: [
						[
							["Udi", variant("s", udi)],
							["Interface", variant("s", iface)],
							["IpInterface", variant("s", ipIface)],
							["Managed", variant("b", managed)],
						],
					],
				};
			if (call.member === "Set") {
				const value = call.args?.[2];
				if (value && typeof value === "object" && "value" in value)
					managed = value.value === true;
				return { signature: "", body: [] };
			}
			throw new Error("Unexpected NM call");
		},
	};
	const deps: CellularNmControlDeps = {
		transport: (options) => {
			expect(options?.reconnect?.enabled).toBe(false);
			return transport;
		},
		present: async () => present,
		revoked: () => {
			revoked++;
		},
	};
	return {
		deps,
		calls,
		managed: () => managed,
		revoked: () => revoked,
		replace: () => {
			signal({
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				sender: "org.freedesktop.DBus",
				signature: "sss",
				body: ["org.freedesktop.NetworkManager", ":1.17", ":1.18"],
			});
		},
		set: (value: {
			iface?: string;
			ipIface?: string;
			udi?: string;
			present?: boolean;
		}) => {
			if (value.iface !== undefined) iface = value.iface;
			if (value.ipIface !== undefined) ipIface = value.ipIface;
			if (value.udi !== undefined) udi = value.udi;
			if (value.present !== undefined) present = value.present;
		},
	};
}
test("NM handoff targets its captured unique owner and verifies the exact device after each write", async () => {
	const f = fixture(),
		control = await acquireCellularNmControl(link, modem, f.deps);
	const device = control.devices[0];
	if (!device) throw new Error("Missing fixture device");
	expect(await control.setManaged(device, true, false)).toBe(true);
	expect(f.managed()).toBe(false);
	expect(await control.setManaged(device, false, true)).toBe(true);
	expect(
		f.calls
			.filter((call) => call.member !== "GetNameOwner")
			.every((call) => call.destination === ":1.17"),
	).toBe(true);
	await control.close();
	expect(control.valid()).toBe(false);
});
test("replacement services, changed USB identity and renamed/reused objects grant no setter", async () => {
	const f = fixture(),
		control = await acquireCellularNmControl(link, modem, f.deps),
		device = control.devices[0];
	if (!device) throw new Error("Missing fixture device");
	f.set({ ipIface: "wwan1", udi: "/different" });
	expect(await control.setManaged(device, true, false)).toBe(false);
	f.set({ ipIface: "wwan0", udi: modem });
	f.replace();
	expect(f.revoked()).toBe(1);
	expect(await control.setManaged(device, true, false)).toBe(false);
	expect(f.calls.filter((call) => call.member === "Set")).toHaveLength(0);
	await control.close();
	const g = fixture();
	g.set({ present: false });
	await expect(acquireCellularNmControl(link, modem, g.deps)).rejects.toThrow(
		"identity unresolved",
	);
	expect(g.calls).toEqual([]);
});

test("a wrong variant type cannot authorize a managed-state write", () => {
	expect(() =>
		parseCellularNmDevice(path, [
			["Udi", variant("s", modem)],
			["Interface", variant("s", "ttyUSB7")],
			["IpInterface", variant("s", "wwan0")],
			["Managed", variant("s", true)],
		]),
	).toThrow("property type");
});

test("disconnected physical Ethernet retains identity across an empty transient IP interface", async () => {
	const f = fixture();
	f.set({ iface: "wwan0", ipIface: "", udi: "synthetic-physical-net" });
	const control = await acquireCellularNmControl(link, modem, f.deps),
		device = control.devices[0];
	if (!device) throw new Error("Missing physical fixture");
	expect(await control.setManaged(device, true, false)).toBe(true);
	f.set({ ipIface: "wwan0" });
	expect((await control.read(device))?.ipIface).toBe("wwan0");
	expect(await control.setManaged(device, false, true)).toBe(true);
	f.set({ ipIface: "wwan1" });
	expect(await control.read(device)).toBeUndefined();
	expect(await control.setManaged(device, true, false)).toBe(false);
	await control.close();
});

test("inverse lookup without a modem path accepts only a physical NM object", async () => {
	const f = fixture();
	await expect(
		acquireCellularNmControl(link, undefined, f.deps),
	).rejects.toThrow("another device");
	expect(f.calls.filter((call) => call.member === "Set")).toHaveLength(0);
	const g = fixture();
	g.set({ iface: link.ifname, ipIface: "", udi: "synthetic-physical-net" });
	const control = await acquireCellularNmControl(link, undefined, g.deps);
	expect(control.devices[0]?.udi).toBe("synthetic-physical-net");
	await control.close();
});
