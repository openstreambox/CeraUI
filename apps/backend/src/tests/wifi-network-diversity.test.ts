/*
  Two radios on two networks must stay on two networks.

  Board-observed with two USB radios bonded over two access points: each radio
  held a saved profile for both networks. When network 1 went away,
  NetworkManager autoconnected that radio to its saved profile for network 2,
  where the other radio already was, and never moved it back after network 1
  returned. Losing network 2's uplink then took the whole stream down.

  These tests drive the planner and the runtime with fake NetworkManager
  operations, then check the join/connect hooks against a spied nmcli layer.
*/

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as nm from "../modules/network/network-manager.ts";
import type { MessageSocket } from "../modules/ui/message-socket.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { handleWifi, setWifiJoinNmcliRunner } from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	getWifiIdToMacAddress,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	type DiversityRadio,
	diversityRadioOf,
	planWifiNetworkDiversity,
	WIFI_CHOSEN_NETWORK_PRIORITY,
	WIFI_DIVERSITY_FIRST_RETRY_MS,
	WifiNetworkDiversity,
	type WifiNetworkDiversityDeps,
} from "../modules/wifi/wifi-network-diversity.ts";

const A = "02:00:00:00:a0:01";
const B = "02:00:00:00:b0:02";
const NET1 = "Lab-Net-1";
const NET2 = "Lab-Net-2";
// Each radio holds its own profile for each network (MAC-bound).
const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";

type Air = { a: string | null; b: string | null; visible: Set<string> };

function radio(
	key: string,
	device: number,
	ssid: string | null,
	profiles: Record<string, string>,
	visible: Set<string>,
): DiversityRadio {
	const savedAll: Record<string, string[]> = {};
	for (const [net, uuid] of Object.entries(profiles)) savedAll[net] = [uuid];
	return { key, device, ssid, saved: profiles, savedAll, visible };
}

function pair(air: Air): DiversityRadio[] {
	return [
		radio(A, 0, air.a, { [NET1]: A1, [NET2]: A2 }, air.visible),
		radio(B, 1, air.b, { [NET1]: B1, [NET2]: B2 }, air.visible),
	];
}

function harness(
	air: Air,
	priorities: Record<string, number> = {},
	onRescan: () => void = () => {},
) {
	let clock = 0;
	const calls: string[] = [];
	let connectResult = true;
	let busy = false;
	const deps: WifiNetworkDiversityDeps = {
		radios: () => pair(air),
		readPriority: async (uuid) => priorities[uuid] ?? 0,
		setPriority: async (uuid, priority) => {
			calls.push(`priority ${uuid} ${priority}`);
			priorities[uuid] = priority;
			return true;
		},
		connect: async (uuid) => {
			calls.push(`connect ${uuid}`);
			if (connectResult && uuid === A1) air.a = NET1;
			return connectResult;
		},
		rescan: async (device) => {
			calls.push(`rescan ${device}`);
			onRescan();
		},
		withLock: async (_key, fn) => {
			if (busy) return false;
			await fn();
			return true;
		},
		now: () => clock,
	};
	return {
		diversity: new WifiNetworkDiversity(deps),
		calls,
		advance: (ms: number) => {
			clock += ms;
		},
		failConnects: () => {
			connectResult = false;
		},
		setBusy: (value: boolean) => {
			busy = value;
		},
	};
}

describe("planWifiNetworkDiversity", () => {
	const visible = new Set([NET1, NET2]);

	test("moves the radio that left its own network, not its sibling", () => {
		const radios = pair({ a: NET2, b: NET2, visible });
		const prefs: Record<string, string> = { [A]: NET1, [B]: NET2 };
		expect(planWifiNetworkDiversity(radios, (key) => prefs[key])).toEqual([
			{ key: A, device: 0, ssid: NET1, uuid: A1, visible: true },
		]);
	});

	test("leaves radios alone when they are on distinct networks", () => {
		const radios = pair({ a: NET1, b: NET2, visible });
		expect(planWifiNetworkDiversity(radios, () => NET1)).toEqual([]);
	});

	test("respects both radios being chosen for one network", () => {
		const radios = pair({ a: NET2, b: NET2, visible });
		expect(planWifiNetworkDiversity(radios, () => NET2)).toEqual([]);
	});

	test("does nothing for a single radio", () => {
		const [only] = pair({ a: NET2, b: null, visible });
		expect(
			planWifiNetworkDiversity([only as DiversityRadio], () => NET1),
		).toEqual([]);
	});

	test("never moves onto a network another radio holds", () => {
		const third = radio(
			"02:00:00:00:c0:03",
			2,
			NET1,
			{ [NET1]: "c1" },
			visible,
		);
		const radios = [...pair({ a: NET2, b: NET2, visible }), third];
		const prefs: Record<string, string> = { [A]: NET1, [B]: NET2 };
		expect(planWifiNetworkDiversity(radios, (key) => prefs[key])).toEqual([]);
	});

	test("hands a free network to only one of two radios that want it", () => {
		const radios = pair({ a: NET2, b: NET2, visible });
		const actions = planWifiNetworkDiversity(radios, () => NET1);
		expect(actions.map((action) => action.key)).toEqual([A]);
	});

	test("needs a saved profile on the moving radio", () => {
		const radios = [
			radio(A, 0, NET2, { [NET2]: A2 }, visible),
			radio(B, 1, NET2, { [NET2]: B2 }, visible),
		];
		expect(planWifiNetworkDiversity(radios, () => NET1)).toEqual([]);
	});
});

describe("WifiNetworkDiversity", () => {
	test("brings a radio back after NetworkManager parked it on its sibling's network", async () => {
		const air: Air = { a: NET1, b: NET2, visible: new Set([NET1, NET2]) };
		const { diversity, calls, advance } = harness(air);

		// Both radios on their own networks: remembered, nothing to do.
		await diversity.tick();
		expect(calls).toEqual([]);

		// Network 1 goes away; NetworkManager falls back to radio A's NET2 profile.
		air.a = NET2;
		air.visible = new Set([NET2]);
		await diversity.tick();
		// Only the duplicating radio is rescanned; it stays as a last resort.
		expect(calls).toEqual(["rescan 0"]);

		// Within the back-off nothing happens.
		advance(WIFI_DIVERSITY_FIRST_RETRY_MS - 1);
		await diversity.tick();
		expect(calls).toEqual(["rescan 0"]);

		// Network 1 is back.
		air.visible = new Set([NET1, NET2]);
		advance(1);
		await diversity.tick();
		expect(calls).toEqual(["rescan 0", `connect ${A1}`]);
		expect(air).toMatchObject({ a: NET1, b: NET2 });

		// Settled: no more actions.
		await diversity.tick();
		expect(calls).toHaveLength(2);
	});

	test("connects right after the rescan finds the network", async () => {
		const air: Air = { a: NET1, b: NET2, visible: new Set([NET1, NET2]) };
		const { diversity, calls } = harness(air, {}, () => {
			air.visible = new Set([NET1, NET2]);
		});
		await diversity.tick();
		air.a = NET2;
		air.visible = new Set([NET2]);
		await diversity.tick();
		expect(calls).toEqual(["rescan 0", `connect ${A1}`]);
	});

	test("the operator's recorded choice wins over what the radio last held", async () => {
		// Marks in NetworkManager: A was chosen for NET2, B for NET2.
		const air: Air = { a: NET1, b: NET2, visible: new Set([NET1, NET2]) };
		const priorities = {
			[A2]: WIFI_CHOSEN_NETWORK_PRIORITY,
			[B2]: WIFI_CHOSEN_NETWORK_PRIORITY,
		};
		const { diversity, calls } = harness(air, priorities);
		await diversity.tick();
		air.a = NET2;
		await diversity.tick();
		expect(calls).toEqual([]);
	});

	test("a choice read from NetworkManager after a restart moves the radio", async () => {
		// No memory of this run: A starts out sharing NET2.
		const air: Air = { a: NET2, b: NET2, visible: new Set([NET1, NET2]) };
		const { diversity, calls } = harness(air, {
			[A1]: WIFI_CHOSEN_NETWORK_PRIORITY,
		});
		await diversity.tick();
		expect(calls).toEqual([`connect ${A1}`]);
	});

	test("without a choice or memory nothing moves", async () => {
		const air: Air = { a: NET2, b: NET2, visible: new Set([NET1, NET2]) };
		const { diversity, calls } = harness(air);
		await diversity.tick();
		expect(calls).toEqual([]);
	});

	test("backs off after a failed move", async () => {
		const air: Air = { a: NET1, b: NET2, visible: new Set([NET1, NET2]) };
		const { diversity, calls, advance, failConnects } = harness(air);
		await diversity.tick();
		air.a = NET2;
		failConnects();
		await diversity.tick();
		advance(WIFI_DIVERSITY_FIRST_RETRY_MS);
		await diversity.tick();
		advance(WIFI_DIVERSITY_FIRST_RETRY_MS);
		await diversity.tick();
		advance(WIFI_DIVERSITY_FIRST_RETRY_MS);
		await diversity.tick();
		// 0 s, 15 s, then the doubled 30 s wait ends at 45 s.
		expect(calls).toEqual([`connect ${A1}`, `connect ${A1}`, `connect ${A1}`]);
	});

	test("a busy adapter is skipped without starting a back-off", async () => {
		const air: Air = { a: NET1, b: NET2, visible: new Set([NET1, NET2]) };
		const { diversity, calls, setBusy } = harness(air);
		await diversity.tick();
		air.a = NET2;
		setBusy(true);
		await diversity.tick();
		setBusy(false);
		await diversity.tick();
		expect(calls).toEqual([`connect ${A1}`]);
	});

	test("recording a choice marks that profile and clears the old mark", async () => {
		const air: Air = { a: NET1, b: NET2, visible: new Set([NET1, NET2]) };
		const priorities = { [A1]: WIFI_CHOSEN_NETWORK_PRIORITY, [B1]: 5 };
		const { diversity, calls } = harness(air, priorities);
		await diversity.recordChoice(A, A2);
		expect(calls.sort()).toEqual([`priority ${A1} 0`, `priority ${A2} 10`]);
		// The radio's sibling and unrelated priorities are untouched.
		expect(priorities[B1]).toBe(5);

		// The operator put A on NET2 next to B: it stays there.
		air.a = NET2;
		await diversity.tick();
		expect(calls).toHaveLength(2);
	});
});

describe("diversityRadioOf", () => {
	function iface(overrides: Partial<WifiInterface> = {}): WifiInterface {
		return {
			id: 3,
			ifname: "wlx0",
			conn: A2,
			hw: "Fixture",
			available: new Map(),
			saved: { [NET1]: A1, [NET2]: A2 },
			savedAll: { [NET1]: [A1], [NET2]: [A2] },
			...overrides,
		};
	}

	test("names the network of the active profile", () => {
		expect(diversityRadioOf(A, iface())).toMatchObject({
			key: A,
			device: 3,
			ssid: NET2,
		});
	});

	test("leaves out a radio running a hotspot", () => {
		expect(
			diversityRadioOf(
				A,
				iface({
					activeMode: "ap",
					hotspot: { conn: "hs" },
				} as unknown as Partial<WifiInterface>),
			),
		).toBeUndefined();
	});
});

describe("join and connect record the operator's choice", () => {
	const spies: Array<{ mockRestore(): void }> = [];
	const writes: Array<[string, Record<string, string>]> = [];
	let replied: Promise<void> = Promise.resolve();
	let socket: MessageSocket;
	// recordChoice runs detached; let its reads and writes settle.
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	beforeEach(() => {
		writes.length = 0;
		const reply = Promise.withResolvers<void>();
		replied = reply.promise;
		socket = { send: () => reply.resolve() } as unknown as MessageSocket;
		const priorities: Record<string, string> = {
			[A1]: String(WIFI_CHOSEN_NETWORK_PRIORITY),
			[A2]: "0",
		};
		addWifiInterface(A, {
			id: 7,
			ifname: "wlx7",
			conn: A1,
			hw: "Fixture",
			available: new Map(),
			saved: { [NET1]: A1, [NET2]: A2 },
			savedAll: { [NET1]: [A1], [NET2]: [A2] },
		});
		getWifiIdToMacAddress()[7] = A;
		spies.push(
			spyOn(nm, "nmConnect").mockResolvedValue(true),
			spyOn(nm, "nmScanResults").mockResolvedValue([""]),
			spyOn(nm, "nmConnGetFields").mockImplementation((async (
				uuid: string,
				fields: readonly string[],
			) =>
				fields.includes("802-11-wireless.ssid")
					? ["infrastructure", uuid === A1 ? NET1 : NET2, A]
					: [priorities[uuid] ?? "0"]) as unknown as typeof nm.nmConnGetFields),
			spyOn(nm, "nmConnsGet").mockResolvedValue([
				`${A1}:802-11-wireless`,
				`${A2}:802-11-wireless`,
			]),
			spyOn(nm, "nmConnSetWifiMacAddress").mockResolvedValue(true),
			spyOn(websocket, "broadcastMsg").mockImplementation(() => {}),
			spyOn(nm, "nmConnSetFields").mockImplementation(async (uuid, fields) => {
				writes.push([uuid, fields]);
				return true;
			}),
		);
	});

	afterEach(() => {
		setWifiJoinNmcliRunner(null);
		for (const spy of spies.splice(0)) spy.mockRestore();
		removeWifiInterface(A);
		delete getWifiIdToMacAddress()[7];
	});

	test("a connect from the UI moves the mark to that network", async () => {
		handleWifi(socket, { connect: A2 });
		await replied;
		await settle();
		expect(writes).toContainEqual([
			A2,
			{ "connection.autoconnect-priority": "10" },
		]);
		expect(writes).toContainEqual([
			A1,
			{ "connection.autoconnect-priority": "0" },
		]);
	});

	test("a join from the UI moves the mark to the joined network", async () => {
		setWifiJoinNmcliRunner(async () => ({
			stdout: `Device 'wlx7' successfully activated with '${A2}'.`,
			stderr: "",
			exitCode: 0,
		}));
		handleWifi(socket, {
			new: { device: 7, ssid: NET2, password: "fixture-pass", security: "" },
		});
		await replied;
		await settle();
		expect(writes).toContainEqual([
			A2,
			{ "connection.autoconnect-priority": "10" },
		]);
		expect(writes).toContainEqual([
			A1,
			{ "connection.autoconnect-priority": "0" },
		]);
	});

	test("a failed connect records nothing", async () => {
		(
			nm.nmConnect as unknown as { mockResolvedValue(v: boolean): void }
		).mockResolvedValue(false);
		handleWifi(socket, { connect: A2 });
		await replied;
		await settle();
		expect(writes).toEqual([]);
	});
});
