/*
  Regression tests from the third boot-wiring review, rebuilt on the narrowed
  design: every effect carries its radio's expectation from the production
  ports to the executor, an effect is bound to the device incarnation so a
  replaced radio receives nothing, stop is checked at dispatch, roaming clones
  are invisible to CeraUI's own Wi-Fi code, and the boot sweep runs before any
  of it.
*/
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runModule from "../../../helpers/run.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../../tests/helpers/wifi-registry.ts";
import { seedWifiRadios } from "../../../tests/helpers/wifi-verified-radios.ts";
import { handleWifi, wifiUpdateSavedConns } from "../../wifi/wifi.ts";
import * as wifiConnections from "../../wifi/wifi-connections.ts";
import { getWifiIdToMacAddress } from "../../wifi/wifi-interfaces.ts";
import * as diversity from "../../wifi/wifi-network-diversity.ts";
import * as networkManager from "../network-manager.ts";
import * as cloneRegistry from "./clone-registry.ts";
import { beginCloneCreation, memoryCloneRegistry } from "./clone-registry.ts";
import {
	type ActionGate,
	type CoordinatorPorts,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import type { BoundDevice, NmBus } from "./nm-bus.ts";
import { createSearchNm } from "./nm-port.ts";
import * as radioLock from "./radio-lock.ts";
import { productionPorts, sweepRoamingClones } from "./runtime.ts";
import { protectRadiosFromScans, setScanGateModeReader } from "./scan-gate.ts";

afterEach(() => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
});

const probeMac = "02:00:00:00:c0:02";
const target = "02:00:00:00:00:02";
const probeSource = "11111111-1111-4111-8111-111111111111";
const probeClone = "33333333-3333-4333-8333-333333333333";
const originalRadio = { ifname: "wlan2", mac: probeMac, ifindex: 31, phy: 3 };
const replacementRadio = { ...originalRadio, ifindex: 32 };

/** NetworkManager's devices, keyed by incarnation; records every effect. */
function bus(devices: Map<number, string>) {
	const effects: string[] = [];
	const nmBus: NmBus = {
		async withDevice(radio, fn) {
			if (devices.get(radio.ifindex) !== radio.mac) return undefined;
			const path = `/org/freedesktop/NetworkManager/Devices/${radio.ifindex}`;
			const device: BoundDevice = {
				path,
				lastScan: async () => BigInt(effects.length),
				requestScan: async () => {
					effects.push(`scan ${path}`);
					return true;
				},
				accessPoints: async () => [],
				activate: async (uuid) => {
					effects.push(`up ${uuid} ${path}`);
					return "/org/freedesktop/NetworkManager/ActiveConnection/1";
				},
				activeState: async () => 2,
				active: async () => ({
					path: "/org/freedesktop/NetworkManager/ActiveConnection/1",
					uuid: probeClone,
				}),
				deactivate: async (active) => {
					effects.push(`down ${active}`);
					return true;
				},
			};
			return fn(device);
		},
	};
	return { nmBus, effects };
}

test("production scan, join and abandon all hand the radio's expectation to the executor", async () => {
	const confirm = spyOn(radioLock, "confirmRadio").mockResolvedValue(false);
	const run = spyOn(runModule, "run").mockImplementation(async (_bin, args) => {
		const line = args.join(" ");
		if (line === "-t -f NAME,UUID,TYPE connection show")
			return `venue:${probeSource}:802-11-wireless\n`;
		if (line.startsWith("-g 802-11-wireless.ssid"))
			return `venue\n${probeMac.replace(/:/g, "\\:")}\n\n`;
		if (line.startsWith("connection clone"))
			return `venue (${probeSource}) cloned as ceraui-search-wlan2 (${probeClone}).`;
		return "";
	});
	const { ports, sender } = productionPorts(
		() => 0,
		() => [],
		{ clones: memoryCloneRegistry([probeClone]), macOf: async () => probeMac },
	);
	const expected = { id: probeMac, lifetime: "31:3:/fixture" };
	const gate: ActionGate = { expected, live: () => true };
	try {
		await ports.scan("wlan2", gate);
		await ports.join("wlan2", "venue", target, gate);
		await ports.abandon("wlan2", probeClone, gate);
		expect(confirm.mock.calls).toEqual([
			["wlan2", expected],
			["wlan2", expected],
			["wlan2", expected],
		]);
	} finally {
		sender.close();
		confirm.mockRestore();
		run.mockRestore();
	}
});

test("a radio replaced during the profile reads gets no activation and no deactivation", async () => {
	const inherited = isolateWifiRegistry();
	const seed = await seedWifiRadios();
	const devices = new Map([[31, probeMac]]);
	const { nmBus, effects } = bus(devices);
	const replug = () => {
		seed.sysfs([replacementRadio]);
		devices.clear();
		devices.set(32, probeMac);
	};
	const nm = createSearchNm({
		identity: radioLock.confirmRadio,
		macOf: async () => probeMac,
		clones: memoryCloneRegistry([probeClone]),
		bus: nmBus,
		pollMs: 1,
		run: async (_bin, args) => {
			const line = args.join(" ");
			if (line === "-t -f NAME,UUID,TYPE connection show") {
				replug();
				return `venue:${probeSource}:802-11-wireless\n`;
			}
			if (line.startsWith("-g 802-11-wireless.ssid"))
				return `venue\n${probeMac}\n\n`;
			if (line.startsWith("connection clone"))
				return `venue (${probeSource}) cloned as ceraui-search-wlan2 (${probeClone}).`;
			return "";
		},
	});
	try {
		await seed.publish([originalRadio]);
		const admission = radioLock.admitRadio("wlan2");
		if (!admission) throw new Error("fixture admission failed");
		const expected = {
			id: probeMac,
			lifetime: radioLock.lifetimeKey(admission.lifetime),
		};
		const gate: ActionGate = { expected, live: () => true };
		const joined = await radioLock.withRadioLock("wlan2", expected, () =>
			nm.join("wlan2", "venue", target, gate),
		);
		expect(joined.ok).toBe(true);
		if (joined.ok) expect(joined.value).toBe("refused");
		// Back to the original sysfs view, but NetworkManager still only has
		// the replacement: the registry check passes, the bind does not.
		seed.sysfs([originalRadio]);
		const abandoned = await radioLock.withRadioLock("wlan2", expected, () =>
			nm.abandon("wlan2", probeClone, gate),
		);
		expect(abandoned.ok).toBe(true);
		if (abandoned.ok) expect(abandoned.value).toBe(false);
		expect(effects).toEqual([]);
	} finally {
		await seed.restore();
		restoreWifiRegistry(inherited);
	}
});

const radioA = "02:00:00:00:00:0a";
const radioB = "02:00:00:00:00:0b";
const config = { radios: [{ id: radioA }, { id: radioB }] };

function fakeWorld(): CoordinatorPorts {
	const names = new Map([
		[radioA, { ifname: "wlan0", lifetime: "30:2:/a" }],
		[radioB, { ifname: "wlan1", lifetime: "31:3:/b" }],
	]);
	return {
		now: () => 0,
		resolve: (id) => names.get(id),
		observe: async (name): Promise<RadioObservation> => ({
			ifname: name,
			bssid: name === "wlan0" ? "02:00:00:00:00:01" : null,
			ssid: name === "wlan0" ? "venue" : null,
			signalDbm: name === "wlan0" ? -55 : null,
			address: name === "wlan0" ? "192.0.2.2/24" : null,
			gateway: name === "wlan0" ? "192.0.2.1" : null,
			routed: name === "wlan0",
			activation: null,
			activationRead: true,
			bssidLocked: false,
			phy: name,
			apOnPhy: false,
		}),
		scan: async () => [],
		savedSsids: async () => new Set(["venue"]),
		join: async () => undefined,
		abandon: async () => true,
		uplinkOf: async () => ({
			gateway: "192.0.2.1",
			gatewayMac: null,
			subnet: "192.0.2.0/24",
			egress: null,
		}),
		holderHealth: () => ({
			signalDbm: -55,
			attributedBps: null,
			encoderBps: null,
			nakRatio: null,
		}),
		otherUplinks: () => 0,
		radioMode: async (name) => ({ phy: name, apOnPhy: false }),
		withRadioLock: async (_name, _expected, act) => ({
			ok: true,
			value: await act(async () => true),
		}),
		holdOutOfBond: () => undefined,
		releaseBondHold: () => undefined,
	};
}

test("stop while the executor reads the radio's identity: no scan is requested", async () => {
	const checking = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const { nmBus, effects } = bus(new Map([[31, radioB]]));
	const nm = createSearchNm({
		run: async () => "",
		bus: nmBus,
		pollMs: 1,
		identity: async () => {
			checking.resolve();
			await proceed.promise;
			return true;
		},
	});
	const world = fakeWorld();
	const coordinator = new RoamingCoordinator(
		{ ...world, scan: (ifname, gate) => nm.scan(ifname, gate) },
		config,
	);
	const round = coordinator.step();
	await checking.promise;
	const stopping = coordinator.stop();
	proceed.resolve();
	await Promise.all([round, stopping]);
	expect(effects).toEqual([]);
});

test("CeraUI's saved list never shows a roaming clone, and its Connect refuses one", async () => {
	const inherited = isolateWifiRegistry();
	const seed = await seedWifiRadios();
	const ids = getWifiIdToMacAddress();
	const previousId = ids[40];
	const owned = spyOn(cloneRegistry, "isOwnedClone").mockImplementation(
		(uuid) => uuid === probeClone,
	);
	const list = spyOn(networkManager, "nmConnsGet").mockResolvedValue([
		`${probeSource}:802-11-wireless`,
		`${probeClone}:802-11-wireless`,
	]);
	const fields = spyOn(networkManager, "nmConnGetFields").mockResolvedValue([
		"infrastructure",
		"venue",
		probeMac,
	]);
	const connect = spyOn(networkManager, "nmConnect").mockResolvedValue(true);
	const refresh = spyOn(
		wifiConnections,
		"wifiUpdateScanResult",
	).mockResolvedValue(true);
	const choice = spyOn(diversity, "beginWifiOperatorChoice").mockReturnValue({
		record: async () => {},
		release: () => {},
	});
	try {
		const rows = await seed.publish([originalRadio]);
		ids[40] = probeMac;
		await wifiUpdateSavedConns();
		expect(rows[probeMac]?.saved.venue).toBe(probeSource);
		expect(rows[probeMac]?.savedAll.venue).toEqual([probeSource]);
		// Even a Connect that names the clone directly does nothing.
		await handleWifi({ send: () => undefined }, { connect: probeClone });
		expect(connect.mock.calls).toEqual([]);
	} finally {
		owned.mockRestore();
		list.mockRestore();
		fields.mockRestore();
		connect.mockRestore();
		refresh.mockRestore();
		choice.mockRestore();
		if (previousId === undefined) delete ids[40];
		else ids[40] = previousId;
		await seed.restore();
		restoreWifiRegistry(inherited);
	}
});

test("a saved-list refresh taken while a clone is being created is not committed", async () => {
	const inherited = isolateWifiRegistry();
	const seed = await seedWifiRadios();
	const ids = getWifiIdToMacAddress();
	const previousId = ids[40];
	const owned = spyOn(cloneRegistry, "isOwnedClone").mockReturnValue(false);
	const list = spyOn(networkManager, "nmConnsGet").mockResolvedValue([
		`${probeClone}:802-11-wireless`,
	]);
	const fields = spyOn(networkManager, "nmConnGetFields").mockResolvedValue([
		"infrastructure",
		"venue",
		probeMac,
	]);
	try {
		const rows = await seed.publish([originalRadio]);
		ids[40] = probeMac;
		const end = beginCloneCreation();
		try {
			await wifiUpdateSavedConns();
		} finally {
			end();
		}
		expect(rows[probeMac]?.saved).toEqual({});
		// A refresh that starts before the creation and ends after it is not
		// committed either.
		list.mockImplementation(async () => {
			beginCloneCreation()();
			return [`${probeClone}:802-11-wireless`];
		});
		await wifiUpdateSavedConns();
		expect(rows[probeMac]?.saved).toEqual({});
	} finally {
		owned.mockRestore();
		list.mockRestore();
		fields.mockRestore();
		if (previousId === undefined) delete ids[40];
		else ids[40] = previousId;
		await seed.restore();
		restoreWifiRegistry(inherited);
	}
});

test("a clone is hidden from CeraUI once recorded, until deleted; what the boot sweep leaves stays hidden", async () => {
	const dir = await mkdtemp(join(tmpdir(), "roaming-clones-"));
	try {
		const path = join(dir, "clones.json");
		const clones = cloneRegistry.fileCloneRegistry(path);
		await clones.add(probeClone, `${probeMac}|${probeSource}`);
		expect(cloneRegistry.isOwnedClone(probeClone)).toBe(true);
		await clones.remove(probeClone);
		expect(cloneRegistry.isOwnedClone(probeClone)).toBe(false);
		// A record an earlier process left, which this sweep cannot delete
		// (NetworkManager unreachable): it stays recorded and hidden.
		const leftover = "44444444-4444-4444-8444-444444444444";
		await writeFile(path, JSON.stringify([{ uuid: leftover, key: "" }]));
		expect(cloneRegistry.isOwnedClone(leftover)).toBe(false);
		const failing = async (): Promise<string> => {
			throw new Error("NetworkManager unreachable");
		};
		expect(await sweepRoamingClones(failing, clones, 50)).toBe(0);
		expect(await clones.list()).toEqual([leftover]);
		expect(cloneRegistry.isOwnedClone(leftover)).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("boot sweeps roaming clones before the control server and any Wi-Fi code", async () => {
	const main = await Bun.file(
		new URL("../../../main.ts", import.meta.url),
	).text();
	const at = (needle: string) => {
		const i = main.indexOf(needle);
		if (i < 0) throw new Error(`main.ts has no ${needle}`);
		return i;
	};
	const sweep = at("await sweepRoamingClones()");
	for (const later of [
		'await runCritical("ws-control-server", initServer)',
		'await guardNonCritical("hotspot-credentials"',
		'guardNonCritical("wifi-regdomain"',
		"await initWifiRoaming(",
		"wifiStateInit(networkMonitor",
		"startWifiNetworkDiversity()",
	])
		expect(at(later)).toBeGreaterThan(sweep);
});
