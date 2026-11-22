import { expect, test } from "bun:test";
import {
	detectEthernetPort,
	type EthernetDiscovery,
} from "./ethernet-auto-detection.ts";
import { NETWORK_CHANGE_SAFETY_ENV } from "./ethernet-role-safety.ts";

const enabled = { [NETWORK_CHANGE_SAFETY_ENV]: "1" };
const listening: EthernetDiscovery = {
	attachment: 1,
	carrier: true,
	window: "listening",
	upstreamDhcpSeen: false,
	ipv6RouterSeen: false,
	peerDhcpRequestSeen: false,
};
const otherClient = { ...listening, peerDhcpRequestSeen: true };
const dish = {
	attachment: 1,
	kind: "dish",
	host: "192.168.100.1",
	port: 9200,
} as const;

test("only the existing safety flag enables detection", () => {
	expect(detectEthernetPort("auto", listening, {})).toBeUndefined();
	expect(
		detectEthernetPort("auto", listening, {
			[NETWORK_CHANGE_SAFETY_ENV]: "true",
		}),
	).toBeUndefined();
	expect(detectEthernetPort("auto", listening, enabled)?.direction.kind).toBe(
		"detecting",
	);
});

test("positive peer DHCP is required after a completed discovery window", () => {
	expect(detectEthernetPort("auto", otherClient, enabled)?.direction.kind).toBe(
		"detecting",
	);
	for (const window of ["unavailable", "complete"] as const) {
		expect(
			detectEthernetPort("auto", { ...listening, window }, enabled)?.direction
				.kind,
		).toBe("unresolved");
	}
	expect(
		detectEthernetPort(
			"auto",
			{ ...otherClient, window: "unavailable" },
			enabled,
		)?.direction.kind,
	).toBe("unresolved");
	expect(
		detectEthernetPort("auto", { ...otherClient, window: "complete" }, enabled)
			?.direction.kind,
	).toBe("share-candidate");
});

test("a late upstream or IPv6 default router takes precedence over a peer request", () => {
	const mixed = { ...otherClient, window: "complete" } as const;
	for (const evidence of [
		{ ...mixed, upstreamDhcpSeen: true },
		{ ...mixed, ipv6RouterSeen: true },
		{ ...mixed, lease: { address: "192.0.2.12" } },
	]) {
		expect(detectEthernetPort("auto", evidence, enabled)?.direction.kind).toBe(
			"uplink",
		);
	}
});

test("manual roles are authoritative with or without carrier", () => {
	for (const carrier of [false, true]) {
		expect(
			detectEthernetPort(
				"uplink",
				{ ...otherClient, carrier, window: "complete" },
				enabled,
			)?.direction,
		).toEqual({ kind: "manual", role: "uplink" });
		expect(
			detectEthernetPort(
				"shared-lan",
				{ ...listening, carrier, ipv6RouterSeen: true, starlinkStatus: dish },
				enabled,
			),
		).toEqual({
			direction: { kind: "manual", role: "shared-lan" },
			starlink: "unknown",
		});
	}
});

test("a retained upstream observation survives loss of the current lease", () => {
	const evidence = {
		...otherClient,
		window: "complete",
		upstreamDhcpSeen: true,
	} as const;
	expect(detectEthernetPort("auto", evidence, enabled)?.direction.kind).toBe(
		"uplink",
	);
	expect(
		detectEthernetPort(
			"auto",
			{ ...evidence, carrier: false, starlinkStatus: dish },
			enabled,
		),
	).toEqual({ direction: { kind: "disconnected" }, starlink: "unknown" });
});

test("a dish address, generic router address and CGNAT are weak evidence", () => {
	const evaluate = (address: string, gateway: string) =>
		detectEthernetPort(
			"auto",
			{ ...listening, lease: { address, gateway } },
			enabled,
		)?.starlink;
	expect(evaluate("192.168.100.10", "192.168.100.1")).toBe("possible");
	expect(evaluate("192.168.1.10", "192.168.1.1")).toBe("unknown");
	expect(evaluate("100.64.0.10", "100.64.0.1")).toBe("unknown");
});

test("only matching decoded status identifies the vendor on the current attachment", () => {
	const evidence = { ...listening, ipv6RouterSeen: true };
	expect(
		detectEthernetPort("auto", { ...evidence, starlinkStatus: dish }, enabled)
			?.starlink,
	).toBe("identified");
	for (const status of [
		{ ...dish, attachment: 0 },
		{ ...dish, host: "192.0.2.1" },
		{ ...dish, port: 443 },
	]) {
		expect(
			detectEthernetPort(
				"auto",
				{ ...evidence, starlinkStatus: status },
				enabled,
			)?.starlink,
		).toBe("unknown");
	}
	const router = {
		attachment: 1,
		kind: "router",
		host: "192.168.1.1",
		port: 9000,
	} as const;
	expect(
		detectEthernetPort("auto", { ...evidence, starlinkStatus: router }, enabled)
			?.starlink,
	).toBe("unknown");
	expect(
		detectEthernetPort(
			"auto",
			{
				...evidence,
				lease: { address: "192.168.1.10", gateway: "192.168.1.1" },
				starlinkStatus: router,
			},
			enabled,
		)?.starlink,
	).toBe("identified");
});
