import { expect, test } from "bun:test";
import {
	cellularClatIsolatesPhysical,
	cellularClatPhysicalSettings,
	parseCellularClatHostPlan,
} from "./cellular-clat-host-plan.ts";
import { cellularTunAlias } from "./cellular-tun.ts";

const owner = "a".repeat(64),
	tunEpoch = "b".repeat(64),
	raw = {
		input: {
			owner,
			epoch: "grant-one",
			slot: 1,
			iface: "wwan0",
			mtu: 1280,
			ipv6: "2001:db8:1::2",
			ipv6PrefixLength: 64,
			ipv6Gateway: "fe80::1",
			nat64: "2001:db8:64::/96",
		},
		physical: {
			ifname: "wwan0",
			ifindex: "7",
			usbDevice: "/sys/devices/example-usb",
			netDevice: "/sys/devices/example-net",
			generation: "usb-one",
		},
		tun: {
			name: "cclat1",
			index: 8,
			alias: cellularTunAlias(owner, tunEpoch),
			persistent: true,
		},
		tunEpoch,
		birth: "c".repeat(32),
		bootId: "11111111-2222-3333-4444-555555555555",
		globalForwarding: "0",
		physicalBefore: {
			accept_ra: "1",
			accept_ra_defrtr: "1",
			forwarding: "0",
			proxy_ndp: "0",
			force_forwarding: "0",
		},
		dns: ["2001:db8::53"],
	};
test("CLAT authority binds the observed physical and born TUN independently and preserves prior router policy", () => {
	const plan = parseCellularClatHostPlan(raw);
	expect(Reflect.set(plan.input, "mtu", 1500)).toBe(false);
	expect(Object.isFrozen(plan.dns)).toBe(true);
	expect(cellularClatIsolatesPhysical(plan)).toBe(true);
	expect(cellularClatPhysicalSettings(plan).map((row) => row.key)).toEqual([
		"accept_ra",
		"forwarding",
		"proxy_ndp",
		"force_forwarding",
	]);
	expect(cellularClatPhysicalSettings(plan)[0]).toEqual({
		key: "accept_ra",
		before: "1",
		desired: "2",
	});
	expect(
		cellularClatIsolatesPhysical(
			parseCellularClatHostPlan({ ...raw, globalForwarding: "1" }),
		),
	).toBe(false);
	const existing = parseCellularClatHostPlan({
		...raw,
		physicalBefore: { ...raw.physicalBefore, force_forwarding: "1" },
	});
	expect(cellularClatIsolatesPhysical(existing)).toBe(false);
	expect(
		cellularClatPhysicalSettings(existing).some(
			(row) => row.key === "force_forwarding",
		),
	).toBe(false);
});
test("foreign TUNs, contradictory devices, zones and unknown authority fields refuse host composition", () => {
	for (const patch of [
		{ tun: { ...raw.tun, alias: cellularTunAlias("d".repeat(64), tunEpoch) } },
		{ physical: { ...raw.physical, ifname: "other0" } },
		{ physical: { ...raw.physical, ifindex: "8" } },
		{ input: { ...raw.input, ipv6Gateway: "fe80::1%other0" } },
		{ unexpected: true },
	])
		expect(() => parseCellularClatHostPlan({ ...raw, ...patch })).toThrow();
});
