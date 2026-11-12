import { expect, test } from "bun:test";
import { captureCellularDataGrant } from "./cellular-grant.ts";
import type { CellularNmIpSnapshot } from "./cellular-nm-ip.ts";
import type { CellularNetworkTarget } from "./modems.ts";
import type { NativeBearerSnapshot } from "./native-bearer.ts";

const target: CellularNetworkTarget = {
	id: 3,
	key: "synthetic-key",
	deviceId: "synthetic-modem",
	simId: "synthetic-sim",
	subscriber: "synthetic-subscription",
	equipment: "synthetic-unit",
	ifname: "wwan0",
	ifindex: "17",
	usbDevice: "synthetic-usb",
	netDevice: "synthetic-net",
	generation: "one",
	identity: { model: "Unlisted", firmware: "unlisted", mode: "mbim" },
	sim: {} as never,
};
const nm: CellularNmIpSnapshot = {
	service: ":1.17",
	device: "/org/freedesktop/NetworkManager/Devices/1",
	active: "/org/freedesktop/NetworkManager/ActiveConnection/1",
	ipv4Path: "/org/freedesktop/NetworkManager/IP4Config/1",
	ipv6Path: "/",
	ipv4: {
		addresses: [{ address: "192.0.2.2", prefix: 32 }],
		gateway: "192.0.2.1",
		dns: ["192.0.2.53"],
	},
};
const bearer: NativeBearerSnapshot = {
	path: "/org/freedesktop/ModemManager1/Bearer/1",
	iface: "wwan0",
	ipv4: {
		family: 4,
		method: "static",
		address: "192.0.2.2",
		gateway: "192.0.2.1",
		prefix: 32,
		mtu: 1428,
		dns: ["192.0.2.53"],
	},
};
const address4 = {
		family: "inet",
		local: "192.0.2.2",
		prefixlen: 32,
		scope: "global",
		preferred_life_time: "forever",
	},
	address6 = {
		family: "inet6",
		local: "2001:db8:1::2",
		prefixlen: 64,
		scope: "global",
		preferred_life_time: 3600,
	};
function kernel(addresses = [address4]) {
	return [
		{
			ifname: "wwan0",
			ifindex: 17,
			mtu: 1500,
			flags: ["UP", "LOWER_UP"],
			addr_info: addresses,
		},
	];
}
function v6() {
	const b: NativeBearerSnapshot = {
			path: bearer.path,
			iface: "wwan0",
			ipv6: {
				family: 6,
				method: "static",
				address: address6.local,
				prefix: 64,
				gateway: "fe80::1",
				dns: ["2001:db8::53"],
				mtu: 1428,
			},
		},
		n: CellularNmIpSnapshot = {
			...nm,
			ipv4Path: "/",
			ipv6Path: "/org/freedesktop/NetworkManager/IP6Config/1",
			ipv4: { addresses: [], dns: [] },
			ipv6: {
				addresses: [{ address: address6.local, prefix: 64 }],
				gateway: "fe80::1",
				dns: ["2001:db8::53"],
			},
		};
	return {
		b,
		n,
		k: [
			{
				ifname: "wwan0",
				ifindex: 17,
				mtu: 1500,
				flags: ["UP"],
				addr_info: [address6],
			},
		],
	};
}
test("native IPv4 requires the modem family, active profile lease and exact healthy indexed kernel address", () => {
	const value = captureCellularDataGrant(target, bearer, nm, kernel());
	expect(value).toMatchObject({
		family: "ipv4",
		source: "192.0.2.2",
		gateway: "192.0.2.1",
		mtu: 1428,
		dns: ["192.0.2.53"],
		physical: { ifindex: "17" },
	});
	expect(Object.isFrozen(value?.dns)).toBe(true);
	expect(
		captureCellularDataGrant(target, bearer, nm, [
			{ ...kernel()[0], ifindex: 18 },
		]),
	).toBeUndefined();
	expect(
		captureCellularDataGrant(target, bearer, nm, [
			{ ...kernel()[0], flags: [] },
		]),
	).toBeUndefined();
	expect(
		captureCellularDataGrant(
			target,
			bearer,
			nm,
			kernel([{ ...address4, local: "192.0.2.3" }]),
		),
	).toBeUndefined();
	expect(
		captureCellularDataGrant(target, bearer, nm, [
			{ ...kernel()[0], addr_info: [{ ...address4, deprecated: true }] },
		]),
	).toBeUndefined();
});
test("DHCP uses positive NM lease evidence and refuses ambiguous addresses or missing grant DNS", () => {
	const dhcp: NativeBearerSnapshot = {
		...bearer,
		ipv4: { family: 4, method: "dhcp", dns: [] },
	};
	expect(captureCellularDataGrant(target, dhcp, nm, kernel())?.source).toBe(
		"192.0.2.2",
	);
	const second = { ...address4, local: "192.0.2.3" };
	expect(
		captureCellularDataGrant(
			target,
			dhcp,
			{
				...nm,
				ipv4: {
					addresses: [
						{ address: address4.local, prefix: 32 },
						{ address: second.local, prefix: 32 },
					],
					dns: ["192.0.2.53"],
				},
			},
			kernel([address4, second]),
		),
	).toBeUndefined();
	expect(
		captureCellularDataGrant(
			target,
			dhcp,
			{
				...nm,
				ipv4: { addresses: [{ address: address4.local, prefix: 32 }], dns: [] },
			},
			kernel(),
		),
	).toBeUndefined();
});
test("dual stack contributes native IPv4 only; a missing native lease cannot be misclassified as IPv6-only", () => {
	const v = v6(),
		dual: NativeBearerSnapshot = { ...bearer, ipv6: v.b.ipv6 },
		n: CellularNmIpSnapshot = { ...nm, ipv6: v.n.ipv6 };
	expect(
		captureCellularDataGrant(target, dual, n, [
			{ ...kernel()[0], addr_info: [address4, address6] },
		])?.family,
	).toBe("ipv4");
	expect(captureCellularDataGrant(target, dual, v.n, v.k)).toBeUndefined();
	expect(captureCellularDataGrant(target, v.b, n, v.k)).toBeUndefined();
});
test("IPv6 source, delegated prefix, gateway and DNS are grant-local; deprecated or unsupported sources remain unavailable", () => {
	const v = v6();
	expect(captureCellularDataGrant(target, v.b, v.n, v.k)).toMatchObject({
		family: "ipv6",
		source: address6.local,
		prefixLength: 64,
		gateway: "fe80::1",
		dns: ["2001:db8::53"],
	});
	const host128 = [{ ...v.k[0], addr_info: [{ ...address6, prefixlen: 128 }] }],
		n128: CellularNmIpSnapshot = {
			...v.n,
			ipv6: {
				addresses: [{ address: address6.local, prefix: 128 }],
				gateway: "fe80::1",
				dns: ["2001:db8::53"],
			},
		};
	expect(captureCellularDataGrant(target, v.b, n128, host128)?.family).toBe(
		"ipv6",
	);
	const noDelegation: NativeBearerSnapshot = {
		...v.b,
		ipv6: {
			family: 6,
			method: "static",
			address: address6.local,
			prefix: 128,
			gateway: "fe80::1",
			dns: ["2001:db8::53"],
		},
	};
	expect(
		captureCellularDataGrant(target, noDelegation, n128, host128),
	).toBeUndefined();
	expect(
		captureCellularDataGrant(target, v.b, v.n, [
			{ ...v.k[0], addr_info: [{ ...address6, tentative: true }] },
		]),
	).toBeUndefined();
	expect(
		captureCellularDataGrant(target, v.b, v.n, [{ ...v.k[0], mtu: 1279 }]),
	).toBeUndefined();
});
test("MM or NM object renumbering does not change a data generation; a SIM, source or USB change does", () => {
	const first = captureCellularDataGrant(target, bearer, nm, kernel());
	expect(first).toBeDefined();
	expect(
		captureCellularDataGrant(
			{ ...target, id: 9 },
			{ ...bearer, path: "/org/freedesktop/ModemManager1/Bearer/9" },
			{
				...nm,
				service: ":1.99",
				active: "/org/freedesktop/NetworkManager/ActiveConnection/9",
			},
			kernel(),
		)?.generation,
	).toBe(first?.generation);
	for (const changed of [{ simId: "other-sim" }, { generation: "two" }])
		expect(
			captureCellularDataGrant({ ...target, ...changed }, bearer, nm, kernel())
				?.generation,
		).not.toBe(first?.generation);
});
