import { expect, test } from "bun:test";
import {
	type DbusTransport,
	type DbusValue,
	type MethodCall,
	type SignalListener,
	variant,
} from "@ceralive/modem-control/transport";
import {
	type CellularNmHandoffObservationDeps,
	cellularNmHandoffRestored,
} from "./cellular-nm-handoff-observation.ts";

const old = {
	path: "/org/freedesktop/NetworkManager/Devices/1",
	udi: "synthetic-old-udi",
	iface: "wwan0",
	ipIface: "wwan0",
	managed: true,
};
const path = "/org/freedesktop/NetworkManager/Devices/4";
function fixture() {
	let connected = false,
		now = 0,
		passes = 0,
		ownerReads = 0,
		managed = true,
		udi = old.udi,
		paths: DbusValue = [path],
		mode:
			| "normal"
			| "throw"
			| "shape"
			| "replace"
			| "change"
			| "expire"
			| "duplicate-udi"
			| "loopback"
			| "fake-loopback"
			| "owner-tail"
			| "roster" = "normal";
	let signal: SignalListener = () => {},
		roster: SignalListener = () => {};
	const calls: MethodCall[] = [];
	let disconnects = 0;
	const transport: DbusTransport = {
		connect: async () => {
			connected = true;
		},
		disconnect: async () => {
			connected = false;
			disconnects++;
		},
		isConnected: () => connected,
		on: () => {},
		off: () => {},
		subscriptionCount: () => 1,
		subscribeSignal: async (spec, callback) => {
			if (spec.member === "NameOwnerChanged") signal = callback;
			if (spec.member === "DeviceAdded") roster = callback;
			return { unsubscribe: async () => {} };
		},
		callMethod: async (call) => {
			calls.push(call);
			expect(["GetNameOwner", "GetDevices", "GetAll"]).toContain(call.member);
			expect(call.timeoutMs).toBeGreaterThan(0);
			expect(call.timeoutMs).toBeLessThanOrEqual(1500);
			if (call.member === "GetNameOwner")
				return {
					signature: "s",
					body: [
						++ownerReads > 1 && mode === "owner-tail" ? ":1.100" : ":1.99",
					],
				};
			expect(call.destination).toBe(":1.99");
			if (call.member === "GetDevices") {
				passes++;
				if (passes === 2 && mode === "replace")
					signal({
						path: "/org/freedesktop/DBus",
						interface: "org.freedesktop.DBus",
						member: "NameOwnerChanged",
						sender: "org.freedesktop.DBus",
						signature: "sss",
						body: ["org.freedesktop.NetworkManager", ":1.99", ":1.100"],
					});
				if (passes === 2 && mode === "roster")
					roster({
						path: "/org/freedesktop/NetworkManager",
						interface: "org.freedesktop.NetworkManager",
						member: "DeviceAdded",
						sender: ":1.99",
						signature: "o",
						body: [path],
					});
				if (passes === 2 && mode === "change") managed = false;
				if (mode === "expire") now = 8000;
				return {
					signature: "ao",
					body: [mode === "duplicate-udi" ? [path, `${path}2`] : paths],
				};
			}
			if (mode === "throw") throw new Error("Inventory unavailable");
			return {
				signature: "a{sv}",
				body: [
					[
						["Udi", variant("s", mode.includes("loopback") ? "" : udi)],
						["DeviceType", variant("u", mode === "loopback" ? 32 : 1)],
						[
							"Interface",
							variant("s", mode.includes("loopback") ? "lo" : "wwan0"),
						],
						["IpInterface", variant("s", "wwan0")],
						["Managed", variant(mode === "shape" ? "s" : "b", managed)],
					],
				],
			};
		},
	};
	const deps: CellularNmHandoffObservationDeps = {
		transport: (options) => {
			expect(options?.reconnect?.enabled).toBe(false);
			return transport;
		},
		now: () => now,
	};
	return {
		deps,
		calls,
		disconnects: () => disconnects,
		passes: () => passes,
		set: (next: {
			paths?: DbusValue;
			udi?: string;
			managed?: boolean;
			mode?: typeof mode;
		}) => {
			if (next.paths !== undefined) paths = next.paths;
			if (next.udi !== undefined) udi = next.udi;
			if (next.managed !== undefined) managed = next.managed;
			if (next.mode !== undefined) mode = next.mode;
		},
	};
}

test("a replacement service can prove the old UDI absent or its baseline restored without any setter", async () => {
	for (const state of [{}, { paths: [] }, { udi: "synthetic-reused-name" }]) {
		const f = fixture();
		f.set(state);
		expect(await cellularNmHandoffRestored(old, f.deps)).toBe(true);
		expect(f.passes()).toBe(2);
		expect(f.disconnects()).toBe(1);
	}
});

test("unknown, incomplete, ambiguous and changed censuses cannot certify restoration", async () => {
	for (const mode of [
		"throw",
		"shape",
		"replace",
		"change",
		"expire",
		"duplicate-udi",
		"fake-loopback",
		"owner-tail",
		"roster",
	] as const) {
		const f = fixture();
		f.set({ mode });
		expect(await cellularNmHandoffRestored(old, f.deps)).toBe(false);
		expect(f.disconnects()).toBe(1);
	}
	for (const paths of [
		"",
		[path, path],
		["/unrelated"],
		Array.from({ length: 33 }, (_v, i) => `${path}${i}`),
	]) {
		const f = fixture();
		f.set({ paths });
		expect(await cellularNmHandoffRestored(old, f.deps)).toBe(false);
		expect(f.calls.some((call) => call.member === "GetAll")).toBe(false);
		expect(f.disconnects()).toBe(1);
	}
});

test("a retained unmanaged flag is not inherited by the replacement service", async () => {
	const f = fixture();
	f.set({ managed: false });
	expect(await cellularNmHandoffRestored(old, f.deps)).toBe(false);
	expect(f.disconnects()).toBe(1);
	const unknown = fixture();
	unknown.set({ udi: "" });
	expect(await cellularNmHandoffRestored(old, unknown.deps)).toBe(false);
});

test("a positively typed unrelated loopback does not donate an unknown physical identity", async () => {
	const f = fixture();
	f.set({ mode: "loopback" });
	expect(await cellularNmHandoffRestored(old, f.deps)).toBe(true);
	expect(f.passes()).toBe(2);
});
