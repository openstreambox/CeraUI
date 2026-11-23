/*
  Regression tests from the third and fourth boot-wiring reviews, on the
  design that answered them: every effect carries its radio's expectation
  from the production ports to the executor, is bound to the device
  incarnation so a replaced radio receives nothing, and reads stop as the
  last thing before each dispatch. A join is one volatile NetworkManager
  profile that NetworkManager removes by itself, so nothing deletes a
  profile, at runtime or at boot.
*/
import { afterEach, expect, spyOn, test } from "bun:test";
import * as runModule from "../../../helpers/run.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "../../../tests/helpers/wifi-registry.ts";
import { seedWifiRadios } from "../../../tests/helpers/wifi-verified-radios.ts";
import {
	type ActionGate,
	type CoordinatorPorts,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import { type BoundDevice, type NmBus, systemNmBus } from "./nm-bus.ts";
import { createSearchNm } from "./nm-port.ts";
import * as radioLock from "./radio-lock.ts";
import { productionPorts } from "./runtime.ts";
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
		async withDevice(radio, _live, fn) {
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
				addAndActivate: async (source) => {
					effects.push(`up ${source} ${path}`);
					return {
						active: "/org/freedesktop/NetworkManager/ActiveConnection/1",
						uuid: probeClone,
					};
				},
				activeState: async () => 2,
				active: async () => ({
					path: "/org/freedesktop/NetworkManager/ActiveConnection/1",
					uuid: probeClone,
					id: "ceraui-search-wlan2",
					volatile: true,
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
		{ macOf: async () => probeMac },
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

const root = "/org/freedesktop/NetworkManager";

test("a join stopped during the source profile lookup never sends AddAndActivateConnection2", async () => {
	const lookupStarted = Promise.withResolvers<void>();
	const finishLookup = Promise.withResolvers<void>();
	const dispatches: string[] = [];
	let live = true;
	const nmBus = systemNmBus(
		async () => 31,
		async () => ({
			connect: async () => {},
			disconnect: async () => {},
			callMethod: async ({ member }) => {
				switch (member) {
					case "GetNameOwner":
						return { signature: "s", body: [":1.3"] };
					case "GetDevices":
						return { signature: "ao", body: [[`${root}/Devices/1`]] };
					case "GetAll":
						return {
							signature: "a{sv}",
							body: [
								[
									["Interface", { signature: "s", value: "wlan2" }],
									["DeviceType", { signature: "u", value: 2 }],
								],
							],
						};
					case "Get":
						return {
							signature: "v",
							body: [{ signature: "s", value: probeMac }],
						};
					case "GetConnectionByUuid":
						lookupStarted.resolve();
						await finishLookup.promise;
						return { signature: "o", body: [`${root}/Settings/2`] };
					case "GetSettings":
						return { signature: "a{sa{sv}}", body: [[]] };
					default:
						dispatches.push(member);
						return { signature: "", body: [] };
				}
			},
		}),
	);
	const nm = createSearchNm({
		bus: nmBus,
		macOf: async () => probeMac,
		run: async (_bin, args) => {
			if (args.includes("NAME,UUID,TYPE"))
				return `venue:${probeSource}:802-11-wireless\n`;
			if (args[0] === "-g") return `venue\n${probeMac}\n\n`;
			return "";
		},
	});
	const joining = nm.join("wlan2", "venue", target, {
		expected: { id: probeMac, lifetime: "31:3:/fixture" },
		live: () => live,
	});
	await lookupStarted.promise;
	live = false;
	finishLookup.resolve();
	expect(await joining).toBe("refused");
	expect(dispatches).toEqual([]);
});

test("nothing in roaming deletes, clones or edits a NetworkManager profile, and boot runs no sweep", async () => {
	const read = (path: string) =>
		Bun.file(new URL(path, import.meta.url)).text();
	for (const file of [
		"nm-port.ts",
		"nm-bus.ts",
		"runtime.ts",
		"coordinator.ts",
	]) {
		const source = await read(`./${file}`);
		expect(source, file).not.toMatch(/"(delete|clone|modify)"/);
		expect(source, file).not.toMatch(
			/"(Delete|Update|Update2|AddConnection2?)"/,
		);
	}
	const main = await read("../../../main.ts");
	expect(main).not.toMatch(/sweep[A-Za-z]*Clones/);
});
