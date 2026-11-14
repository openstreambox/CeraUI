import { afterEach, beforeEach, expect, test } from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import type WebSocket from "ws";
import {
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";
import { getNetworkInterfaces } from "../modules/network/network-interfaces.ts";
import {
	getLinkPaths,
	setLinkPaths,
} from "../modules/streaming/link-path-status.ts";
import {
	resetPublishedBond,
	resetSrtlaSelectionForTest,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";
import { sendStatus } from "../modules/ui/status.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

const cacheName = "receiver-path.test.invalid";
let savedInventory: ReturnType<typeof getNetworkInterfaces>;
beforeEach(() => {
	savedInventory = structuredClone(getNetworkInterfaces());
});
afterEach(() => {
	const inventory = getNetworkInterfaces();
	for (const key of Object.keys(inventory)) delete inventory[key];
	Object.assign(inventory, savedInventory);
	resetSrtlaSelectionForTest();
	resetPublishedBond();
	setBondIdentityResolverForTest(null);
	setDnsResolverFactoryForTest(null);
	setDnsCacheEntryForTest(cacheName, null);
	setLinkPaths({});
});
test("both authentication snapshots and live status retain the selected path map", () => {
	setLinkPaths({ cell0: "clat", cell1: "receiver-ipv4-only" });
	const expected = getLinkPaths();
	expect(buildInitialStatus().status.link_paths).toEqual(expected);
	let frame: { status?: unknown } = {};
	sendStatus({
		send(value: string) {
			frame = JSON.parse(value);
		},
	} as unknown as WebSocket);
	expect(statusResponseSchema.parse(frame.status).link_paths).toEqual(expected);
	setLinkPaths({});
	expect(buildInitialStatus().status.link_paths).toEqual({});
});

test("an idle health inventory read cannot republish a cleared session selection", async () => {
	const { processIfconfigOutput, parseIpAddrShow } = await import(
		"../modules/network/network-interfaces.ts"
	);
	const { resolveSrtla, genSrtlaIpList, genSrtlaBondEntries } = await import(
		"../modules/streaming/srtla.ts"
	);
	processIfconfigOutput(
		"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow("2: wan0: <UP>\n    inet 192.0.2.3/24 scope global\n"),
	);
	await resolveSrtla("192.0.2.2");
	genSrtlaBondEntries(true);
	expect(getLinkPaths()).toEqual({ wan0: "ipv4" });
	setLinkPaths({});
	expect(genSrtlaIpList()).toEqual(["192.0.2.3"]);
	expect(getLinkPaths()).toEqual({});
});

test("the translator stays internal to its physical link in the operator inventory", async () => {
	const {
		processIfconfigOutput,
		parseIpAddrShow,
		netIfBuildMsg,
		getNetworkInterfaces,
	} = await import("../modules/network/network-interfaces.ts");
	processIfconfigOutput(
		"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n\nclat3: flags=4305<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wan0: <UP>\n    inet6 2001:db8::3/64 scope global\n3: clat3: <UP>\n    inet 10.254.0.3/32 scope global\n",
		),
	);
	expect(getNetworkInterfaces().clat3?.ip).toBe("10.254.0.3");
	expect(netIfBuildMsg().wan0?.ipv6).toBe("2001:db8::3");
	expect(netIfBuildMsg().clat3).toBeUndefined();
});

test("stopping retracts the published path map", async () => {
	const { updateStatus } = await import("../modules/streaming/streaming.ts");
	updateStatus(true);
	setLinkPaths({ wan0: "ipv4" });
	expect(updateStatus(false)).toBe(true);
	expect(getLinkPaths()).toEqual({});
	expect(buildInitialStatus().status.link_paths).toEqual({});
});

test("cached dual-stack receiver selects IPv4 without claiming IPv6 is absent", async () => {
	const { processIfconfigOutput, parseIpAddrShow } = await import(
		"../modules/network/network-interfaces.ts"
	);
	const { resolveSrtla, genSrtlaBondEntries } = await import(
		"../modules/streaming/srtla.ts"
	);
	processIfconfigOutput(
		"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n\nwan1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wan0: <UP>\n    inet 192.0.2.3/24 scope global\n3: wan1: <UP>\n    inet6 2001:db8::3/64 scope global\n",
		),
	);
	setDnsCacheEntryForTest(cacheName, ["192.0.2.2", "2001:db8::2"]);
	setDnsResolverFactoryForTest(() => ({
		cancel() {},
		resolve4(_host, cb) {
			queueMicrotask(() => cb(new Error("unavailable"), []));
		},
		resolve6(_host, cb) {
			queueMicrotask(() => cb(new Error("unavailable"), []));
		},
	}));
	expect(await resolveSrtla(cacheName)).toBe("192.0.2.2");
	genSrtlaBondEntries(true);
	expect(getLinkPaths()).toEqual({ wan0: "ipv4", wan1: "receiver-ipv4-only" });
});

for (const address of ["10.0.0.2", "198.51.100.2"])
	test(`IP preparation publishes selected paths for ${address}`, async () => {
		const { processIfconfigOutput, parseIpAddrShow } = await import(
			"../modules/network/network-interfaces.ts"
		);
		const { resolveSrtla } = await import("../modules/streaming/srtla.ts");
		const { prepareSrtlaIpAddresses } = await import(
			"../modules/streaming/streamloop/srtla-ip-preparation.ts"
		);
		const { setup } = await import("../modules/setup.ts");
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const dir = await mkdtemp(`${tmpdir()}/paths-`);
		const previous = {
			ips_file: setup.ips_file,
			bind_map_file: setup.bind_map_file,
		};
		try {
			setup.ips_file = `${dir}/ips`;
			setup.bind_map_file = `${dir}/map`;
			processIfconfigOutput(
				"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
				parseIpAddrShow("2: wan0: <UP>\n    inet 10.0.0.3/24 scope global\n"),
			);
			await resolveSrtla(address);
			expect(getLinkPaths()).toEqual({});
			await prepareSrtlaIpAddresses(address);
			expect(getLinkPaths()).toEqual({ wan0: "ipv4" });
		} finally {
			Object.assign(setup, previous);
			await rm(dir, { recursive: true, force: true });
		}
	});

test("an unadmitted duplicate source is unknown rather than a selected IPv4 path", async () => {
	const { genSrtlaBondEntriesForLocalIpAddress, resolveSrtla } = await import(
		"../modules/streaming/srtla.ts"
	);
	const inventory = getNetworkInterfaces();
	for (const key of Object.keys(inventory)) delete inventory[key];
	inventory.wan0 = {
		ip: "192.0.2.3",
		netmask: "255.255.255.0",
		enabled: false,
		error: 1,
		tp: 0,
	};
	setBondIdentityResolverForTest(() => {
		throw new Error("unavailable identity");
	});
	await resolveSrtla("192.0.2.2");
	expect(genSrtlaBondEntriesForLocalIpAddress("192.0.2.2", true)).toEqual([]);
	expect(getLinkPaths()).toEqual({ wan0: "unknown" });
});
