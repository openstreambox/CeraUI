/*
  The device image's first-boot setup Wi-Fi brings up its own AP: connection
  name `ceralive-ap`, SSID `CeraLive-Setup-<4 hex>`, bound to `wlan0` by
  interface name with no MAC pin, autoconnect off, 192.168.42.1/24 shared. The
  image tears it down by connection name, so CeraUI must observe it without
  ever adopting, repairing, remembering, stopping or replacing it. A foreign
  AP with the same shape but another connection name keeps upstream's
  discovery behaviour.
*/
import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as runner from "../helpers/run.ts";
import * as mockWifi from "../mocks/providers/wifi.ts";
import {
	getAllHotspotCredentials,
	getHotspotCredentials,
	hotspotCredentialsStore,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	wifiCancelScanRefresh,
} from "../modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../modules/wifi/wifi-device-list.ts";
import {
	prepareHotspotForInterface,
	startHotspotForInterface,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotStopDeps,
	stopHotspotForInterface,
} from "../modules/wifi/wifi-hotspot-config.ts";
import * as discovery from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { applyHotspotProfilePolicy } from "../modules/wifi/wifi-hotspot-profile-policy.ts";
import {
	type HotspotActivationDeps,
	isApMode,
	type WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import {
	getWifiIdToMacAddress,
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	isProvisioningApConn,
	isProvisioningApProfile,
	PROVISIONING_AP_CONNECTION_ID,
	PROVISIONING_AP_IFNAME,
	provisioningActiveMarkerPath,
	resetProvisioningApForTest,
} from "../modules/wifi/wifi-provisioning-ap.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import { firstApInstances } from "./helpers/wifi-first-ap-instances.ts";
import {
	decodeProfile,
	encodeProfile,
} from "./helpers/wifi-first-ap-keyfile-codec.ts";
import { fakeShadowSysfs } from "./helpers/wifi-radio-equivalence-shadow.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const B = "dc:a6:32:aa:bb:cc";
const SETUP = "setup-ap-profile";
const OPERATOR = "operator-ap-profile";
const SETUP_SSID = "CeraLive-Setup-1a2b";
const SETUP_PSK = "ceralive-setup";
const profiles = new Map<string, Record<string, string>>();
const effects: string[][] = [];
const unexpected: string[] = [];
let devices = "wlan0:wifi:disconnected:";
let inherited: ReturnType<typeof isolateWifiRegistry>;
let restoreShadow: () => Promise<void>;
let resources: ReturnType<typeof firstApInstances>;

/** The setup AP exactly as the image's script creates it, plus NM defaults. */
function setupProfile(id = PROVISIONING_AP_CONNECTION_ID) {
	return {
		"connection.id": id,
		"connection.interface-name": PROVISIONING_AP_IFNAME,
		"connection.autoconnect": "no",
		"connection.autoconnect-priority": "0",
		"802-11-wireless.mode": "ap",
		"802-11-wireless.band": "bg",
		"802-11-wireless.channel": "0",
		"802-11-wireless.hidden": "no",
		"802-11-wireless.ssid": SETUP_SSID,
		"802-11-wireless.mac-address": "",
		"802-11-wireless-security.key-mgmt": "wpa-psk",
		"802-11-wireless-security.psk": SETUP_PSK,
		"802-11-wireless-security.psk-flags": "0",
		"802-11-wireless-security.pairwise": "ccmp",
		"802-11-wireless-security.group": "ccmp",
		"802-11-wireless-security.proto": "rsn",
		"802-11-wireless-security.pmf": "1",
		"ipv4.method": "shared",
		"ipv4.addresses": "192.168.42.1/24",
	};
}

function radio(): WifiInterfaceWithHotspot {
	const iface: WifiInterfaceWithHotspot = {
		id: 0,
		ifname: PROVISIONING_AP_IFNAME,
		conn: null,
		hw: "Fixture onboard radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: { availableChannels: ["auto"], warnings: {} },
	};
	addWifiInterface(B, iface);
	getWifiIdToMacAddress()[0] = B;
	return iface;
}

function activationDeps(): HotspotActivationDeps {
	return {
		credentials: hotspotCredentialsStore,
		findHotspotConn: discovery.findHotspotConnForAdapter,
		nmConnSetFields: async (uuid, fields) => {
			effects.push([uuid, JSON.stringify(fields)]);
			return true;
		},
		nmConnect: async (uuid) => {
			effects.push(["up", uuid]);
			return true;
		},
		nmApConnAdd: async (_ifname, { name }) => {
			effects.push(["create", name]);
			return "ceraui-new-profile";
		},
		nmConnDelete: async (uuid) => {
			effects.push(["delete", uuid]);
			return true;
		},
		nmDisconnect: async (uuid) => {
			effects.push(["down", uuid]);
			return true;
		},
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		pruneHotspotConns: async () => {},
		readProfileInstance: async () => undefined,
		releaseConcurrentInterface: async () => true,
	};
}

function stopDeps(): HotspotStopDeps {
	return {
		nmConnSetFields: async (uuid, fields) => {
			effects.push([uuid, JSON.stringify(fields)]);
			return true;
		},
		nmDisconnect: async (uuid) => {
			effects.push(["down", uuid]);
			return true;
		},
		releaseConcurrentInterface: async () => true,
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		rescan: async () => {},
	};
}

/** Discovery as it runs at boot: the radio reports the setup AP as active. */
async function discoverActive(uuid: string): Promise<WifiInterfaceWithHotspot> {
	const iface = radio();
	devices = `wlan0:wifi:connected:${uuid}`;
	wifiDeviceListStartUpdate();
	wifiDeviceListAdd("wlan0", B);
	wifiDeviceListEndUpdate();
	await wifiUpdateDevices();
	return iface;
}

beforeEach(async () => {
	inherited = isolateWifiRegistry();
	resetHotspotCredentialsForTest();
	resetProvisioningApForTest();
	resetWifiConnectionModeCache();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiCapabilitiesForTest();
	onWifiChange(() => {});
	setWifiState({});
	profiles.clear();
	profiles.set(SETUP, setupProfile());
	resources = firstApInstances(new Set(profiles.keys()), profiles);
	effects.length = 0;
	unexpected.length = 0;
	devices = "wlan0:wifi:disconnected:";
	restoreShadow = await fakeShadowSysfs(() => [
		{
			ifname: "wlan0",
			operational: B,
			permanent: B,
			ifindex: 3,
			phy: 0,
			state: "disconnected",
		},
	]);
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	spyOn(mockWifi, "shouldMockWifi").mockReturnValue(false);
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		resources.sync();
		if (bin === "busctl") return resources.busReply(args);
		if (bin === "iw" && args.join(" ") === "dev wlan0 station dump") return "";
		if (bin === "nmcli") {
			if (args[0] === "connection" && args[1] === "load") {
				const loaded = decodeProfile(readFileSync(args[2] ?? "", "utf8"));
				const uuid = loaded["connection.uuid"];
				if (!uuid) throw new Error("Missing loaded fixture UUID");
				const current = profiles.get(uuid) ?? {};
				const delta = Object.entries(loaded).filter(
					([key, value]) =>
						key !== "connection.uuid" &&
						key !== "connection.type" &&
						key !== "802-11-wireless-security.psk-flags" &&
						current[key] !== value,
				);
				effects.push(["con", "modify", uuid, ...delta.flat()]);
				Object.assign(current, loaded);
				resources.bumpVersion(uuid);
				return "";
			}
			if (args.includes("--fields")) {
				const fields = args[args.indexOf("--fields") + 1];
				if (fields === "uuid,dbus-path" || fields === "uuid,filename")
					return [...profiles.keys()]
						.map(
							(uuid) =>
								`${uuid}:${
									fields === "uuid,filename"
										? resources.files.filename(uuid)
										: resources.paths().find(([id]) => id === uuid)?.[1]
								}`,
						)
						.join("\n");
			}
			const fieldNames = nmcliFieldNames(args);
			if (fieldNames.length > 0) {
				const fields = profiles.get(args.at(-1) ?? "");
				return nmcliFieldOutput(args, (field) => fields?.[field] ?? "");
			}
			if (args[0] === "con" && args[1] === "modify") {
				effects.push([...args]);
				const fields = profiles.get(args[2] ?? "");
				for (let i = 3; i < args.length; i += 2) {
					const key = args[i];
					const value = args[i + 1];
					if (fields && key && value !== undefined) fields[key] = value;
				}
				return "";
			}
			if (args.join(" ") === "--terse --fields uuid,type connection show")
				return [...profiles.keys()]
					.map((id) => `${id}:802-11-wireless`)
					.join("\n");
			if (
				args.join(" ") ===
				"--terse --fields device,type,state,con-uuid device status"
			)
				return devices;
			if (
				args.includes(
					"IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY,DEVICE",
				)
			)
				return "";
		}
		unexpected.push(`${bin} ${args.join(" ")}`);
		throw new Error(`Unexpected setup AP command: ${bin} ${args.join(" ")}`);
	});
	spyOn(runner, "runWithStdin").mockImplementation(async (bin, args, input) => {
		if (
			bin !== "nmcli" ||
			args.slice(0, 3).join(" ") !== "--offline connection modify"
		)
			throw new Error("Unexpected setup AP offline operation");
		const fields = decodeProfile(input);
		for (let i = 3; i < args.length; i += 2) {
			const key = args[i];
			const value = args[i + 1];
			if (!key || value === undefined)
				throw new Error("Invalid offline fields");
			fields[key] = value;
		}
		return encodeProfile(fields);
	});
});

afterEach(async () => {
	stopWifiUpdateLoopForTest();
	wifiCancelScanRefresh();
	wifiRadioObservation.stop();
	await restoreShadow();
	await settlePending("wlan0", false);
	restoreWifiRegistry(inherited);
	resetHotspotCredentialsForTest();
	resetProvisioningApForTest();
	resetWifiConnectionModeCache();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiCapabilitiesForTest();
	setWifiState({});
	jest.useRealTimers();
	mock.restore();
	resources.files.close();
	expect(unexpected).toEqual([]);
});

test("recognition needs AP mode and the setup connection name, never the SSID alone", () => {
	expect(isProvisioningApProfile({ id: "ceralive-ap", mode: "ap" })).toBe(true);
	expect(
		isProvisioningApProfile({ id: "ceralive-ap", mode: "infrastructure" }),
	).toBe(false);
	expect(isProvisioningApProfile({ id: "Hotspot", mode: "ap" })).toBe(false);
	expect(isProvisioningApProfile({ id: "", mode: "ap" })).toBe(false);
	expect(isProvisioningApProfile({ mode: "ap" })).toBe(false);
});

test("the active setup AP on wlan0 stays observable but is not adopted, written or remembered", async () => {
	const before = JSON.stringify([...profiles]);

	const iface = await discoverActive(SETUP);

	expect(iface.activeConn).toBe(SETUP);
	expect(iface.activeMode).toBe("ap");
	expect(isApMode(iface)).toBe(true);
	expect(isProvisioningApConn(SETUP)).toBe(true);
	expect(iface.hotspot.conn).toBeUndefined();
	expect(iface.hotspot.name).toBeUndefined();
	expect(iface.hotspot.password).toBeUndefined();
	expect(getAllHotspotCredentials()).toEqual([]);
	expect(JSON.stringify([...profiles])).toBe(before);
	expect(effects).toEqual([]);

	// The saved-profile sweep's call shape and the ifname route leave it alone too.
	await discovery.handleHotspotConn("", SETUP);
	await discovery.handleHotspotConn(undefined, SETUP, { active: true });
	await discovery.handleHotspotConn(B, SETUP, { active: true });
	expect(iface.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(JSON.stringify([...profiles])).toBe(before);
	expect(effects).toEqual([]);
});

test.each(["explicit active", "ifname"] as const)(
	"%s discovery of a cold setup profile never repins it or raises its priority",
	async (route) => {
		const iface = radio();
		const before = JSON.stringify([...profiles]);

		await discovery.handleHotspotConn(
			route === "explicit active" ? B : undefined,
			SETUP,
			{ active: true },
		);

		expect(iface.hotspot.conn).toBeUndefined();
		expect(getHotspotCredentials(B)).toBeUndefined();
		expect(JSON.stringify([...profiles])).toBe(before);
		expect(effects).toEqual([]);
	},
);

test("Start and Stop refuse to touch the running setup AP", async () => {
	const iface = await discoverActive(SETUP);

	expect(await startHotspotForInterface(B, iface, activationDeps())).toEqual({
		success: false,
		error: "DEVICE_BUSY",
		reason: "setup-ap-active",
	});
	expect(await stopHotspotForInterface(B, iface, stopDeps())).toEqual({
		success: false,
		error: "DEVICE_BUSY",
	});

	expect(effects).toEqual([]);
	expect(iface.activeConn).toBe(SETUP);
	expect(getAllHotspotCredentials()).toEqual([]);
});

test("Prepare while the setup AP runs never resolves its profile or credentials", async () => {
	const iface = await discoverActive(SETUP);

	const prepared = await prepareHotspotForInterface(
		B,
		iface,
		{},
		activationDeps(),
	);

	expect(prepared.success).toBe(true);
	if (prepared.success) {
		expect(prepared.name).not.toBe(SETUP_SSID);
		expect(prepared.password).not.toBe(SETUP_PSK);
	}
	expect(iface.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentials(B)?.conn).toBeUndefined();
	expect(effects).toEqual([]);
});

test("a persisted claim on the setup AP grants no lookup, policy or credential authority", async () => {
	// An older build may already have remembered the setup AP as this radio's.
	rememberHotspotCredentials(B, {
		ssid: SETUP_SSID,
		password: SETUP_PSK,
		conn: SETUP,
	});
	const iface = radio();
	await wifiRadioIdentity.discover([{ ifname: "wlan0", row: iface }]);
	const stored = getHotspotCredentials(B);

	expect(await discovery.findHotspotConnForAdapter(B, stored)).toBeUndefined();
	expect(
		await applyHotspotProfilePolicy(B, {
			identities: wifiRadioIdentity.state.rows,
			active: new Map([["wlan0", SETUP]]),
			station: true,
			write: async (uuid, fields) => {
				effects.push([uuid, JSON.stringify(fields)]);
				return true;
			},
		}),
	).toEqual({ success: true, result: undefined });
	rememberHotspotCredentials(B, {
		ssid: SETUP_SSID,
		password: "replacement-password",
		conn: SETUP,
	});

	expect(getHotspotCredentials(B)).toEqual(stored);
	expect(effects).toEqual([]);
});

test("a foreign unpinned AP with another connection name follows upstream's foreign-AP handling", async () => {
	profiles.set(OPERATOR, setupProfile("Hotspot"));
	resources = firstApInstances(new Set(profiles.keys()), profiles);
	const iface = radio();

	await discovery.handleHotspotConn(undefined, OPERATOR, { active: true });

	// Setup-AP recognition stays narrow: another connection name is not the
	// setup AP and reaches upstream's own decision. Since upstream #677 that
	// decision never adopts an unowned AP: no credential claim, no repin and no
	// priority write. With no MAC pin and no supplied radio it is not observed
	// on the row either.
	expect(isProvisioningApConn(OPERATOR)).toBe(false);
	expect(iface.hotspot.conn).toBeUndefined();
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(effects).toEqual([]);

	// Once boot discovery reports it as the radio's active connection, upstream's
	// observe-only path records it as the radio's foreign AP: visible and
	// stoppable, still unowned and unwritten. The setup-AP early return would
	// leave the row untouched instead.
	const live = await discoverActive(OPERATOR);

	expect(live.hotspot.conn).toBe(OPERATOR);
	expect(discovery.isObservedForeignHotspot(live.hotspot, B)).toBe(true);
	expect(getHotspotCredentials(B)).toBeUndefined();
	expect(effects).toEqual([]);
});

test("under the image's marker its active AP is the setup AP whatever its name, for the marker's lifetime", async () => {
	const renamed = "renamed-setup-ap";
	profiles.set(renamed, setupProfile("CeraLive setup"));
	resources = firstApInstances(new Set(profiles.keys()), profiles);
	const marker = provisioningActiveMarkerPath();
	mkdirSync(dirname(marker), { recursive: true });
	writeFileSync(marker, `iface=${PROVISIONING_AP_IFNAME}\n`);
	try {
		const before = JSON.stringify([...profiles]);

		const iface = await discoverActive(renamed);
		await discovery.handleHotspotConn("", renamed);
		await discovery.handleHotspotConn(undefined, renamed, { active: true });

		expect(isProvisioningApConn(renamed)).toBe(true);
		expect(iface.activeConn).toBe(renamed);
		expect(iface.activeMode).toBe("ap");
		expect(iface.hotspot.conn).toBeUndefined();
		expect(getHotspotCredentials(B)).toBeUndefined();
		expect(getAllHotspotCredentials()).toEqual([]);
		expect(JSON.stringify([...profiles])).toBe(before);
		expect(await startHotspotForInterface(B, iface, activationDeps())).toEqual({
			success: false,
			error: "DEVICE_BUSY",
			reason: "setup-in-progress",
		});
		expect(await stopHotspotForInterface(B, iface, stopDeps())).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		expect(effects).toEqual([]);
	} finally {
		rmSync(marker, { force: true });
	}
	// The witness ends with the marker; its name alone was never evidence.
	expect(isProvisioningApConn(renamed)).toBe(false);
});
