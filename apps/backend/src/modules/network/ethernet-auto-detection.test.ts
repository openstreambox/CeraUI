import { expect, test } from "bun:test";
import {
	detectEthernetPort,
	type EthernetDiscovery,
} from "./ethernet-auto-detection.ts";
import { NETWORK_CHANGE_SAFETY_ENV } from "./ethernet-role-safety.ts";

const enabled = { [NETWORK_CHANGE_SAFETY_ENV]: "1" };
const listening: EthernetDiscovery = {
	ifindex: 11,
	attachment: 1,
	routeGeneration: 1,
	carrier: true,
	window: "listening",
	upstreamSeen: false,
	peerDhcpRequestSeen: false,
};
const otherClient = { ...listening, peerDhcpRequestSeen: true };
const dish = {
	ifindex: 11,
	attachment: 1,
	routeGeneration: 1,
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

test("late upstream evidence takes precedence over a peer request", () => {
	const mixed = { ...otherClient, window: "complete" } as const;
	expect(
		detectEthernetPort("auto", { ...mixed, upstreamSeen: true }, enabled)
			?.direction.kind,
	).toBe("uplink");
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
				{ ...listening, carrier, upstreamSeen: true, starlinkStatus: dish },
				enabled,
			),
		).toEqual({
			direction: { kind: "manual", role: "shared-lan" },
			starlink: "unknown",
		});
	}
});

test("carrier loss suppresses retained evidence and status", () => {
	const evidence = {
		...otherClient,
		window: "complete",
		upstreamSeen: true,
	} as const;
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
			{ ...listening, upstreamSeen: true, lease: { address, gateway } },
			enabled,
		)?.starlink;
	expect(evaluate("192.168.100.10", "192.168.100.1")).toBe("possible");
	expect(evaluate("192.168.1.10", "192.168.1.1")).toBe("unknown");
	expect(evaluate("100.64.0.10", "100.64.0.1")).toBe("unknown");
});

test("only matching decoded status identifies the vendor on the current attachment", () => {
	const evidence = { ...listening, upstreamSeen: true };
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
		ifindex: 11,
		attachment: 1,
		routeGeneration: 1,
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

test("equal attachment counters on different ports cannot share status replies", () => {
	const ports = [11, 12].map((ifindex) => ({
		...listening,
		ifindex,
		upstreamSeen: true,
		starlinkStatus: dish,
	}));
	expect(
		ports.map((port) => detectEthernetPort("auto", port, enabled)?.starlink),
	).toEqual(["identified", "unknown"]);
});

test("an expired lease and router lifetime never turn the attachment into a Share candidate", () => {
	const attached = {
		...listening,
		window: "complete",
		upstreamSeen: true,
	} as const;
	const lease = { address: "192.0.2.12" };
	expect(
		detectEthernetPort("auto", { ...attached, lease }, enabled)?.direction.kind,
	).toBe("uplink");
	expect(detectEthernetPort("auto", attached, enabled)?.direction.kind).toBe(
		"uplink",
	);
	expect(
		detectEthernetPort(
			"auto",
			{ ...attached, peerDhcpRequestSeen: true },
			enabled,
		)?.direction.kind,
	).toBe("uplink");
});

test("a reply in flight across a gateway change is rejected with carrier still up", () => {
	const before = {
		...listening,
		routeGeneration: 3,
		upstreamSeen: true,
		lease: { address: "192.0.2.12", gateway: "192.0.2.1" },
		starlinkStatus: { ...dish, ifindex: 11, routeGeneration: 3 },
	};
	const after = {
		...before,
		routeGeneration: 4,
		lease: { ...before.lease, gateway: "192.0.2.2" },
	};
	expect(detectEthernetPort("auto", before, enabled)?.starlink).toBe(
		"identified",
	);
	expect(detectEthernetPort("auto", after, enabled)?.starlink).toBe("unknown");
	expect(
		detectEthernetPort(
			"auto",
			{ ...after, starlinkStatus: { ...dish, routeGeneration: 4 } },
			enabled,
		)?.starlink,
	).toBe("identified");
});
