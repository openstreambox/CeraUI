import { expect, test } from "bun:test";
import {
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_HOTSPOT,
	onNetworkInterfacesChange,
	refreshWifiApClientZones,
} from "../modules/network/network-interfaces.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	planUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";
import { verifySteeringState } from "../modules/network/uplink-steering/verify.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { stopHotspotForInterface } from "../modules/wifi/wifi-hotspot-config.ts";
import {
	registerPendingConfirmation,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

async function run(command: string, args: string[]): Promise<string> {
	const result = await runTestCommand([command, ...args]);
	if (result.code !== 0)
		throw Object.assign(new Error(result.stderr), { stderr: result.stderr });
	return result.stdout;
}

// The outer test always isolates link mutations, including CI invocations.
const child = process.env.CERALIVE_HOTSPOT_NETNS_CHILD === "1";
test.skipIf(process.env.CERALIVE_NETNS_ISOLATED !== "1" || child)(
	"isolates the hotspot lifecycle kernel regression",
	async () => {
		const result = await runTestCommand(
			["unshare", "-rn", "bun", "test", import.meta.path],
			{ env: { CERALIVE_HOTSPOT_NETNS_CHILD: "1" } },
		);
		if (result.code !== 0) throw new Error(result.stdout + result.stderr);
		expect(result.code).toBe(0);
	},
);

// No access to host links or routes.
test.skipIf(!child)(
	"first activation readback steers the first lookup; Stop and Delete leave no owned support",
	async () => {
		const peers = [];
		let off: (() => void) | undefined;
		const netif = getNetworkInterfaces();
		const mac = "02:00:00:00:00:93";
		try {
			for (const [host, peer, address] of [
				["wlan93", "client93", "10.42.0.2/24"],
				["eth93", "wan93", "192.0.2.1/24"],
			]) {
				const child = Bun.spawn(
					["unshare", "-n", "sh", "-c", "echo ready; exec sleep 60"],
					{ stdout: "pipe", stderr: "pipe" },
				);
				await child.stdout.getReader().read();
				peers.push(child);
				await run("ip", [
					"link",
					"add",
					host,
					"type",
					"veth",
					"peer",
					"name",
					peer,
				]);
				await run("ip", ["link", "set", peer, "netns", String(child.pid)]);
				await run("ip", ["link", "set", host, "up"]);
				const ns = ["-n", "-t", String(child.pid), "--"];
				await run("nsenter", [...ns, "ip", "link", "set", peer, "up"]);
				await run("nsenter", [
					...ns,
					"ip",
					"addr",
					"add",
					address,
					"dev",
					peer,
				]);
				if (peer === "client93")
					await run("nsenter", [
						...ns,
						"ip",
						"route",
						"add",
						"default",
						"via",
						"10.42.0.1",
					]);
			}
			await run("sysctl", ["-w", "net.ipv4.ip_forward=1"]);

			await run("ip", ["addr", "add", "192.0.2.2/24", "dev", "eth93"]);
			await run("ip", ["addr", "add", "10.42.0.1/24", "dev", "wlan93"]);
			await run("ip", [
				"route",
				"add",
				"default",
				"via",
				"192.0.2.1",
				"dev",
				"eth93",
			]);
			await run("ip", [
				"rule",
				"add",
				"priority",
				"101",
				"from",
				"198.51.100.2",
				"lookup",
				"29999",
			]);
			const candidate = {
				identity: "test-wired",
				ifname: "eth93",
				sourceAddress: "192.0.2.2",
				sourceAddressUnique: true,
				mark: 0xca000100,
			};
			const route = await planUplinkRoute(candidate);
			const active: PreparedSteeringState = {
				clientZones: [{ ifname: "wlan93", ipv4Cidr: "10.42.0.0/24" }],
				uplinks: [
					{
						identity: candidate.identity,
						ifname: candidate.ifname,
						mark: candidate.mark,
						selectable: true,
						weight: 100,
					},
				],
				routes: [route],
			};
			const inactive: PreparedSteeringState = {
				clientZones: [],
				uplinks: [],
				routes: [],
			};
			const applier = new UplinkSteeringApplier({
				discoverRoutes: discoverOwnedUplinkRoutes,
				ensureRoute: ensureUplinkRoute,
				rollbackRoute: rollbackUplinkRoute,
				removeRoute: removeUplinkRoute,
				applyRuleset: async (text) => {
					const p = Bun.spawn(["nft", "-f", "-"], {
						stdin: new Blob([text]),
						stdout: "pipe",
						stderr: "pipe",
					});
					const error = await new Response(p.stderr).text();
					if (await p.exited) throw new Error(error);
				},
				deactivateSharing: async () => {
					try {
						await run("nft", ["delete", "table", "inet", "ceralive_share"]);
					} catch (error) {
						if (
							!(
								error instanceof Error &&
								"stderr" in error &&
								String(error.stderr).includes("No such file")
							)
						)
							throw error;
					}
				},
				flushConntrack: async () => {},
				setIpForwarding: async () => {},
				publishFlowsReset: () => {},
			});
			const coordinator = new UplinkSteeringCoordinator({
				readDesiredState: () =>
					readDesiredSteeringState({
						interfaces: getNetworkInterfaces,
						health: () => [],
						wifiIdentity: () => undefined,
						physicalIdentity: () => candidate.identity,
						markForIdentity: () => candidate.mark,
						isBondCandidate,
						isClientZone: (_name, entry) =>
							(entry.error & NETIF_ERR_HOTSPOT) !== 0,
						planRoute: planUplinkRoute,
					}),
				apply: async (before, next) => {
					await applier.apply(before, next);
				},
				verifyApplied: verifySteeringState,
				publishAvailability: () => {},
			});
			netif.wlan93 = {
				ip: "10.42.0.1",
				netmask: "255.255.255.0",
				error: 0,
				enabled: true,
				tp: 0,
				txb: 0,
				rxb: 0,
			};
			netif.eth93 = {
				ip: "192.0.2.2",
				netmask: "255.255.255.0",
				error: 0,
				enabled: true,
				tp: 0,
				txb: 0,
				rxb: 0,
			};
			const iface: WifiInterfaceWithHotspot = {
				id: 93,
				ifname: "wlan93",
				conn: null,
				hw: "Test",
				available: new Map(),
				saved: {},
				savedAll: {},
				hotspot: {
					conn: "ap93",
					name: "Test AP",
					availableChannels: ["auto"],
					warnings: {},
				},
			};
			addWifiInterface(mac, iface);
			off = onNetworkInterfacesChange(() => {
				void coordinator.requestReconcile();
			});
			registerPendingConfirmation(mac, iface, {
				nmConnect: async () => true,
				nmConnSetFields: async () => true,
				nmHotspot: async () => null,
				wifiUpdateSavedConns: async () => {},
				broadcastState: refreshWifiApClientZones,
				setDupIpSuppression: () => {},
				credentials: { get: () => undefined, remember: () => {} },
				findHotspotConn: async () => undefined,
				confirmSteering: async () => {
					await coordinator.requestReconcile();
					return (coordinator.appliedState()?.clientZones.length ?? 0) > 0;
				},
			});
			settlePending("wlan93", true);
			await coordinator.requestReconcile();
			await verifySteeringState(active);
			const first = await run("ip", [
				"route",
				"get",
				"203.0.113.1",
				"from",
				"10.42.0.2",
				"iif",
				"wlan93",
				"mark",
				"0xca000100",
			]);
			expect(first).toContain("dev eth93");
			expect(first).toContain("table 30001");
			await run("nft", ["add", "table", "inet", "first_flow"]);
			await run("nft", [
				"add",
				"chain",
				"inet",
				"first_flow",
				"forward",
				"{ type filter hook forward priority 10; }",
			]);
			await run("nft", [
				"add",
				"rule",
				"inet",
				"first_flow",
				"forward",
				"meta",
				"mark",
				"0xca000100",
				"counter",
			]);
			const client = peers[0];
			if (!client) throw new Error("missing client namespace");
			const packet = await run("nsenter", [
				"-n",
				"-t",
				String(client.pid),
				"--",
				"ping",
				"-c",
				"1",
				"-W",
				"2",
				"192.0.2.1",
			]);
			expect(packet).toContain("1 received");
			const counter = await run("nft", [
				"list",
				"chain",
				"inet",
				"first_flow",
				"forward",
			]);
			expect(counter).toContain("packets 1");

			// Simulate NM withdrawing the managed default before reconciliation.
			await run("ip", ["route", "flush", "table", "30001"]);
			await coordinator.requestReconcile();
			await verifySteeringState(active);
			iface.activeConn = "ap93";
			iface.activeMode = "ap";
			await stopHotspotForInterface(mac, iface, {
				nmConnSetFields: async () => true,
				nmDisconnect: async () => true,
				releaseConcurrentInterface: async () => true,
				broadcastState: refreshWifiApClientZones,
				setDupIpSuppression: () => {},
				rescan: async () => {},
			});
			await coordinator.requestReconcile();
			await applier.apply(inactive, inactive); // Delete, idempotent

			const rules = await run("ip", ["rule", "show"]);
			expect(rules).not.toContain("lookup 30001");
			expect(rules).toContain("lookup 29999");
			const tables = await run("ip", ["route", "show", "table", "all"]);
			expect(tables).not.toContain("table 30001");
			expect(await run("nft", ["list", "tables"])).not.toContain(
				"ceralive_share",
			);
		} finally {
			off?.();
			removeWifiInterface(mac);
			delete netif.wlan93;
			delete netif.eth93;
			for (const peer of peers) {
				peer.kill();
				await peer.exited;
			}
		}
	},
);
