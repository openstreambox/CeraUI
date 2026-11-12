import { expect, test } from "bun:test";
import {
	type DbusTransport,
	type DbusValue,
	type MethodCall,
	type SignalListener,
	variant,
} from "@ceralive/modem-control/transport";
import { parseIpv6 } from "../network/nat64.ts";
import { parseCellularNmIpFamily, readCellularNmIp } from "./cellular-nm-ip.ts";

const device = "/org/freedesktop/NetworkManager/Devices/7",
	active = "/org/freedesktop/NetworkManager/ActiveConnection/4",
	ip4 = "/org/freedesktop/NetworkManager/IP4Config/1",
	ip6 = "/org/freedesktop/NetworkManager/IP6Config/1",
	target = { id: 2, ifname: "wwan0" };
function family(
	address: string,
	gateway: string,
	dns: string,
	prefix: number,
): DbusValue {
	return [
		[
			"AddressData",
			variant("aa{sv}", [
				[
					["address", variant("s", address)],
					["prefix", variant("u", prefix)],
				],
			]),
		],
		["Gateway", variant("s", gateway)],
		...(address.includes(":")
			? [
					[
						"Nameservers",
						variant("aay", [parseIpv6(dns) ?? new Uint8Array()]),
					] as DbusValue,
				]
			: [
					[
						"NameserverData",
						variant("aa{sv}", [[["address", variant("s", dns)]]]),
					] as DbusValue,
				]),
	];
}
function fixture() {
	let connected = false,
		current = true,
		uuid = "synthetic-profile",
		iface = "wwan0",
		state = 100,
		ipReads = 0;
	let changed = false,
		replaced = false;
	let listener: SignalListener = () => {};
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
		subscribeSignal: async (_match, callback) => {
			listener = callback;
			return { unsubscribe: async () => {} };
		},
		callMethod: async (call) => {
			calls.push(call);
			if (call.member === "GetNameOwner")
				return { signature: "s", body: [":1.17"] };
			if (call.member === "GetDeviceByIpIface")
				return { signature: "o", body: [device] };
			if (call.member !== "GetAll") throw new Error("Unexpected mutation");
			if (call.path === device)
				return {
					signature: "a{sv}",
					body: [
						[
							["Udi", variant("s", "/org/freedesktop/ModemManager1/Modem/2")],
							["Interface", variant("s", "cdc-wdm0")],
							["IpInterface", variant("s", iface)],
							["Managed", variant("b", true)],
							["State", variant("u", state)],
							["ActiveConnection", variant("o", active)],
							["Ip4Config", variant("o", ip4)],
							["Ip6Config", variant("o", ip6)],
						],
					],
				};
			if (call.path === active)
				return {
					signature: "a{sv}",
					body: [
						[
							["Uuid", variant("s", uuid)],
							["State", variant("u", 2)],
							["Devices", variant("ao", [device])],
						],
					],
				};
			if (call.path === ip4) {
				ipReads++;
				if (replaced)
					listener({
						path: "/org/freedesktop/DBus",
						interface: "org.freedesktop.DBus",
						member: "NameOwnerChanged",
						sender: "org.freedesktop.DBus",
						signature: "sss",
						body: ["org.freedesktop.NetworkManager", ":1.17", ":1.18"],
					});
				return {
					signature: "a{sv}",
					body: [
						family(
							changed && ipReads > 1 ? "192.0.2.3" : "192.0.2.2",
							"192.0.2.1",
							"192.0.2.53",
							32,
						),
					],
				};
			}
			if (call.path === ip6)
				return {
					signature: "a{sv}",
					body: [family("2001:db8:1::2", "fe80::1", "2001:db8::53", 64)],
				};
			throw new Error("Unknown object");
		},
	};
	return {
		calls,
		read: () =>
			readCellularNmIp(
				target,
				"synthetic-profile",
				async () => current,
				() => transport,
			),
		connected: () => connected,
		set: (values: {
			current?: boolean;
			uuid?: string;
			iface?: string;
			state?: number;
			changed?: boolean;
			replaced?: boolean;
		}) => {
			if (values.current !== undefined) current = values.current;
			if (values.uuid !== undefined) uuid = values.uuid;
			if (values.iface !== undefined) iface = values.iface;
			if (values.state !== undefined) state = values.state;
			if (values.changed !== undefined) changed = values.changed;
			if (values.replaced !== undefined) replaced = values.replaced;
		},
	};
}
test("NM lease/DNS evidence belongs to an activated exact profile and its captured unique service", async () => {
	const f = fixture();
	const value = await f.read();
	expect(value?.ipv4).toEqual({
		addresses: [{ address: "192.0.2.2", prefix: 32 }],
		gateway: "192.0.2.1",
		dns: ["192.0.2.53"],
	});
	expect(value?.ipv6?.dns).toEqual(["2001:db8::53"]);
	expect(
		f.calls
			.filter((call) => call.member !== "GetNameOwner")
			.every((call) => call.destination === ":1.17"),
	).toBe(true);
	expect(
		f.calls.every((call) =>
			["GetAll", "GetDeviceByIpIface", "GetNameOwner"].includes(call.member),
		),
	).toBe(true);
	expect(f.connected()).toBe(false);
});
test("another profile, wrong carried interface and nonactivated device cannot produce grant authority", async () => {
	for (const values of [
		{ uuid: "other-profile" },
		{ iface: "wwan1" },
		{ state: 30 },
	]) {
		const f = fixture();
		f.set(values);
		await expect(f.read()).rejects.toThrow("profile");
		expect(f.connected()).toBe(false);
	}
	const f = fixture();
	f.set({ current: false });
	expect(await f.read()).toBeUndefined();
	expect(f.calls).toEqual([]);
});
test("same-path IP renumbering and service replacement invalidate the complete observation", async () => {
	const changed = fixture();
	changed.set({ changed: true });
	expect(await changed.read()).toBeUndefined();
	expect(changed.connected()).toBe(false);
	const replaced = fixture();
	replaced.set({ replaced: true });
	await expect(replaced.read()).rejects.toThrow("retired");
	expect(replaced.connected()).toBe(false);
});
test("malformed and ambiguous IP dictionaries refuse instead of using global DNS or guessing family", () => {
	const valid = family("192.0.2.2", "192.0.2.1", "192.0.2.53", 32);
	expect(parseCellularNmIpFamily(valid, 4).addresses).toHaveLength(1);
	expect(() => parseCellularNmIpFamily(valid, 6)).toThrow();
	expect(() => parseCellularNmIpFamily([], 4)).toThrow();
	expect(() =>
		parseCellularNmIpFamily(
			[...(valid as DbusValue[]), ["Gateway", variant("s", "192.0.2.1")]],
			4,
		),
	).toThrow("Ambiguous");
	expect(() =>
		parseCellularNmIpFamily(
			family("192.0.2.2", "192.0.2.1", "resolver.invalid", 32),
			4,
		),
	).toThrow();
	expect(() =>
		parseCellularNmIpFamily(
			family("192.0.2.2", "192.0.2.1", "192.0.2.53", 129),
			4,
		),
	).toThrow();
});

test("IPv6 DNS decodes exact wire bytes and refuses truncated or string-shaped resolvers", () => {
	const raw = family(
		"2001:db8::2",
		"fe80::1",
		"2001:db8::53",
		64,
	) as DbusValue[];
	expect(parseCellularNmIpFamily(raw, 6).dns).toEqual(["2001:db8::53"]);
	const replace = (value: DbusValue, signature = "aay") =>
		[
			...raw.slice(0, -1),
			["Nameservers", variant(signature, value)],
		] as DbusValue[];
	expect(
		parseCellularNmIpFamily(
			replace([Array.from(parseIpv6("2001:db8::53") ?? new Uint8Array())]),
			6,
		).dns,
	).toEqual(["2001:db8::53"]);
	for (const value of [
		[new Uint8Array(15)],
		["2001:db8::53"],
		[[...Array(15).fill(0), 256]],
		[[...Array(15).fill(0), -1]],
	])
		expect(() => parseCellularNmIpFamily(replace(value), 6)).toThrow("bytes");
	expect(() => parseCellularNmIpFamily(replace([], "aa{sv}"), 6)).toThrow(
		"type",
	);
});
