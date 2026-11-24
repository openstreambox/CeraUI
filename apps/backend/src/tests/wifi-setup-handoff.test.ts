/*
  The device image's first-boot setup Wi-Fi holds the setup radio (`wlan0`)
  while its marker exists, and hands the radio back as a station on its own
  station profile. CeraUI's Start, mode switch, restore and arming leave the
  radio alone under the marker, re-checking it right before NetworkManager is
  asked to activate. After a handoff the setup join wins over a saved hotspot
  intent for that radio; a setup that ended without a join keeps the intent.
*/
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, getConfigFilePath, saveConfig } from "../modules/config.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import { wifiAdapterModeRestoreSource } from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	type AdapterModeTransitionDeps,
	defaultAdapterModeDeps,
	setWifiAdapterMode,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as adapterOwner from "../modules/wifi/wifi-adapter-owner.ts";
import * as reconciler from "../modules/wifi/wifi-adapter-reconciler.ts";
import { hotspotAutoconnectPolicy } from "../modules/wifi/wifi-autoconnect-policy.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	startHotspotForInterface,
	startHotspotLocked,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import * as hotspotActivity from "../modules/wifi/wifi-hotspot-activity.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	isProvisioningSetupActive,
	PROVISIONING_AP_IFNAME,
	PROVISIONING_STATION_CONNECTION_ID,
	resetProvisioningApForTest,
} from "../modules/wifi/wifi-provisioning-ap.ts";
import {
	provisioningHandoffDeps,
	resetProvisioningHandoffForTest,
	startProvisioningMarkerWatch,
} from "../modules/wifi/wifi-provisioning-handoff.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture(PROVISIONING_AP_IFNAME);
const OTHER = "dc:a6:32:aa:bb:cc";
const OLD_STATION = "0b6c3a52-1d6e-4c55-9d1a-0c3f6a2b7e01";
const NEW_STATION = "6f1e2d3c-4b5a-4968-8776-655443322110";
const SETUP_FAILURE = { success: false, error: "DEVICE_BUSY" } as const;

let markerDir: string;
let previousMarker: string | undefined;
let previousStations: ReturnType<typeof getConfig>["wifi_setup_stations"];
let inventory: string[];

const marker = () => join(markerDir, "provision", "portal-active");
function beginSetup(): void {
	writeFileSync(marker(), "ssid=CeraLive-Setup-1a2b\niface=wlan0\n");
}
function endSetup(): void {
	rmSync(marker(), { force: true });
}
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};
/** NetworkManager's inventory as the handoff reads it. */
function listProfiles(...rows: Array<[string, string]>): void {
	inventory = rows.map(([uuid, name]) => `${uuid}:${name}`);
}
/** The radio joined as a station on `uuid`, as discovery reports it. */
function joinStation(uuid: string, id = PROVISIONING_STATION_CONNECTION_ID) {
	f.profiles.set(uuid, {
		"connection.id": id,
		"connection.interface-name": PROVISIONING_AP_IFNAME,
		"802-11-wireless.mode": "infrastructure",
		"802-11-wireless.ssid": "Venue",
	});
	f.list([`${PROVISIONING_AP_IFNAME}:wifi:connected:${uuid}`]);
}
function savedConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(getConfigFilePath(), "utf8"));
}
function restoreDeps(): AdapterModeTransitionDeps {
	return {
		...defaultAdapterModeDeps,
		resolveInterfaces: getWifiInterfacesByMacAddress,
		readCapabilities: () => ({ staApCombo: { supported: false } }),
		startHotspot: async () => {
			const result = await startHotspotLocked(MAC, f.row(), f.deps);
			settlePending(f.row().ifname, true);
			return result;
		},
	};
}

beforeEach(() => {
	markerDir = mkdtempSync(join(tmpdir(), "wifi-setup-marker-"));
	// The marker's directory exists as on the image; only the file comes and goes.
	mkdirSync(join(markerDir, "provision"));
	previousMarker = process.env.CERALIVE_PROVISION_ACTIVE_FLAG;
	process.env.CERALIVE_PROVISION_ACTIVE_FLAG = marker();
	previousStations = getConfig().wifi_setup_stations;
	delete getConfig().wifi_setup_stations;
	resetProvisioningApForTest();
	resetProvisioningHandoffForTest();
	listProfiles([PROFILE, "Hotspot"]);
	spyOn(provisioningHandoffDeps, "listConnections").mockImplementation(
		async () => [...inventory],
	);
	profile()["match.path"] = PORT;
});

afterEach(() => {
	if (previousMarker === undefined)
		delete process.env.CERALIVE_PROVISION_ACTIVE_FLAG;
	else process.env.CERALIVE_PROVISION_ACTIVE_FLAG = previousMarker;
	rmSync(markerDir, { recursive: true, force: true });
	if (previousStations === undefined) delete getConfig().wifi_setup_stations;
	else getConfig().wifi_setup_stations = previousStations;
	resetProvisioningApForTest();
	resetProvisioningHandoffForTest();
});

test("the marker mirrors the setup script and only its absence ends the setup", () => {
	expect(isProvisioningSetupActive()).toBe(false);
	beginSetup();
	expect(isProvisioningSetupActive()).toBe(true);
	endSetup();
	expect(isProvisioningSetupActive()).toBe(false);
	// A marker that cannot be checked is not proof that the setup ended.
	symlinkSync(marker(), marker());
	expect(isProvisioningSetupActive()).toBe(true);
});

test("under the marker a user Start on the setup radio refuses with its reason and dispatches nothing", async () => {
	f.persistMode(MAC, "station");
	beginSetup();

	expect(await f.start()).toEqual({
		...SETUP_FAILURE,
		reason: "setup-in-progress",
	});
	expect(f.activations).toEqual([]);
	expect(f.effects).toEqual([]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
});

test.each(["hotspot", "hybrid"] as const)(
	"under the marker a mode switch to %s on the setup radio refuses before recording intent",
	async (target) => {
		f.persistMode(MAC, "station");
		await f.sample();
		beginSetup();

		expect(
			await setWifiAdapterMode(0, target, {
				...restoreDeps(),
				publishOutcome: () => undefined,
			}),
		).toEqual({ ...SETUP_FAILURE, reason: "setup-in-progress" });
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
		expect(f.activations).toEqual([]);
		expect(f.effects).toEqual([]);
	},
);

test("the marker appearing after Start entry stops the activation before NetworkManager is asked", async () => {
	f.persistMode(MAC, "station");
	await f.sample();
	const deps = {
		...f.deps,
		// The last step before the activation: the setup starts meanwhile.
		wifiUpdateSavedConns: async () => {
			beginSetup();
		},
	};

	expect(await startHotspotForInterface(MAC, f.row(), deps)).toEqual({
		...SETUP_FAILURE,
		reason: "setup-in-progress",
	});
	expect(f.activations).toEqual([]);
	expect(f.row().hotspot.transition).toBeUndefined();
	expect(observedWifiAdapterMode(f.row())).toBe("station");
	// Start's own intent write is undone with the refused transaction.
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
});

test("under the marker nothing arms the setup radio's profile and discovery leaves it disarmed", async () => {
	f.persistMode(MAC, "hotspot");
	beginSetup();

	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(
		(
			await hotspotAutoconnectPolicy(
				MAC,
				{ "802-11-wireless.mac-address": MAC, "match.path": PORT },
				PROVISIONING_AP_IFNAME,
			)
		)?.fields["connection.autoconnect"],
	).toBe("no");
	expect(await f.start()).toEqual({
		...SETUP_FAILURE,
		reason: "setup-in-progress",
	});
	expect(
		f.effects.some((e) => e.fields["connection.autoconnect"] === "yes"),
	).toBe(false);
	expect(f.activations).toEqual([]);
});

test("restore defers on the marker and resumes on the edge its removal publishes", async () => {
	f.persistMode(MAC, "hotspot");
	await f.discover();
	beginSetup();
	const listeners = new Set<() => Promise<void>>();
	const stop = startWifiAdapterModeRestore(restoreDeps(), {
		hasDiscovery: () => true,
		subscribe: (listener) => {
			listeners.add(listener);
			const unsubscribe = wifiAdapterModeRestoreSource.subscribe(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
	});
	const stopWatch = startProvisioningMarkerWatch(5);
	try {
		for (const listener of listeners) await listener();
		for (const listener of listeners) await listener();
		expect(f.activations).toEqual([]);
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });

		endSetup();
		for (let i = 0; i < 200 && f.activations.length === 0; i++)
			await Bun.sleep(5);

		expect(f.activations).toEqual([PROFILE]);
		expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
		expect(profile()["connection.autoconnect"]).toBe("no");
	} finally {
		stopWatch();
		stop();
	}
});

test("a handoff to a setup-created station clears only the setup radio's saved intent, durably, and restores no AP", async () => {
	getConfig().wifi_setup_stations = [OLD_STATION];
	f.persistMode(MAC, "hotspot");
	f.persistMode(`${MAC}@legacy`, "hybrid");
	f.persistMode(OTHER, "hotspot");
	f.persistMode(`${OTHER}@legacy`, "hybrid");
	listProfiles(
		[OLD_STATION, PROVISIONING_STATION_CONNECTION_ID],
		[NEW_STATION, PROVISIONING_STATION_CONNECTION_ID],
		[PROFILE, "Hotspot"],
	);
	joinStation(NEW_STATION);

	await f.discover();
	await f.restore();

	expect(f.activations).toEqual([]);
	expect(observedWifiAdapterMode(f.row())).toBe("station");
	expect(f.row().activeConn).toBe(NEW_STATION);
	const expected = {
		[MAC]: "station",
		[`${MAC}@legacy`]: "station",
		[OTHER]: "hotspot",
		[`${OTHER}@legacy`]: "hybrid",
	};
	expect(getConfig().wifi_modes).toEqual(expected);
	expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION, NEW_STATION]);
	expect(savedConfig()).toMatchObject({
		wifi_modes: expected,
		wifi_setup_stations: [OLD_STATION, NEW_STATION],
	});

	// The station stays accounted: later passes and boots keep the radio alone.
	resetProvisioningHandoffForTest();
	await f.restore();
	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_modes).toEqual(expected);
});

test("the handoff wins over an armed owned profile on the setup radio, which ends disarmed", async () => {
	getConfig().wifi_setup_stations = [];
	listProfiles([NEW_STATION, PROVISIONING_STATION_CONNECTION_ID]);
	joinStation(NEW_STATION);

	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");
	await f.restore();

	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	expect(profile()["connection.autoconnect"]).toBe("no");
});

test.each([
	["the radio is disconnected", undefined],
	["the radio joined another network", "operator-station"],
] as const)(
	"a setup that ended without a join keeps the saved intent when %s",
	async (_case, station) => {
		getConfig().wifi_setup_stations = [OLD_STATION];
		f.persistMode(MAC, "hotspot");
		// A failed join leaves no new setup station; a stale one is not the radio's.
		listProfiles(
			[OLD_STATION, PROVISIONING_STATION_CONNECTION_ID],
			[NEW_STATION, PROVISIONING_STATION_CONNECTION_ID],
		);
		if (station) joinStation(station, "Venue");

		await f.discover();
		await f.restore();

		// Upstream restore (#681) also seeds the proven radio's port intent.
		expect(getConfig().wifi_modes).toEqual({
			[MAC]: "hotspot",
			[`${MAC}@${PORT}`]: "hotspot",
		});
		expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION]);
		expect(f.activations).toEqual([PROFILE]);
		expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
	},
);

test("the first run with no live setup station records existing ones as a baseline and clears nothing", async () => {
	f.persistMode(MAC, "hotspot");
	listProfiles([OLD_STATION, PROVISIONING_STATION_CONNECTION_ID]);

	await f.discover();
	await f.restore();

	expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION]);
	// Upstream restore (#681) also seeds the proven radio's port intent.
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "hotspot",
		[`${MAC}@${PORT}`]: "hotspot",
	});
	expect(f.activations).toEqual([PROFILE]);
});

test("the first run counts a live setup station on the setup radio as a fresh handoff", async () => {
	// A first run cannot tell a join that just completed from an older one.
	f.persistMode(MAC, "hotspot");
	listProfiles(
		[OLD_STATION, PROVISIONING_STATION_CONNECTION_ID],
		[NEW_STATION, PROVISIONING_STATION_CONNECTION_ID],
	);
	joinStation(NEW_STATION);

	await f.discover();
	await f.restore();

	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION, NEW_STATION]);
	expect(savedConfig()).toMatchObject({
		wifi_modes: { [MAC]: "station" },
		wifi_setup_stations: [OLD_STATION, NEW_STATION],
	});
});

test("an ordinary later boot on the accounted setup station restores the intent chosen after the handoff", async () => {
	getConfig().wifi_setup_stations = [OLD_STATION];
	// Chosen after the handoff, which had already recorded OLD_STATION.
	f.persistMode(MAC, "hotspot");
	listProfiles([OLD_STATION, PROVISIONING_STATION_CONNECTION_ID]);
	joinStation(OLD_STATION);

	await f.discover();
	await f.restore();

	// Upstream restore (#681) also seeds the proven radio's port intent.
	expect(getConfig().wifi_modes).toEqual({
		[MAC]: "hotspot",
		[`${MAC}@${PORT}`]: "hotspot",
	});
	expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION]);
	expect(f.activations).toEqual([PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test("a handoff that cannot be saved clears nothing and restore waits", async () => {
	getConfig().wifi_setup_stations = [];
	f.persistMode(MAC, "hotspot");
	listProfiles([NEW_STATION, PROVISIONING_STATION_CONNECTION_ID]);
	joinStation(NEW_STATION);
	await f.discover();
	f.failIntent();

	await f.restore();

	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	expect(getConfig().wifi_setup_stations).toEqual([]);
});

test("an owned profile armed before its radio became the setup interface is disarmed before restore", async () => {
	// Armed by an older build while the radio had another name; pinned by MAC and port only.
	expect(profile()["connection.interface-name"]).toBe("");
	expect(profile()["connection.autoconnect"]).toBe("yes");

	await f.discover();
	const disarmed = f.effects.findIndex(
		(e) => e.fields["connection.autoconnect"] === "no",
	);
	expect(disarmed).toBeGreaterThanOrEqual(0);
	expect(f.effects[disarmed]?.intent).toBe("hotspot");
	expect(f.activations).toEqual([]);

	await f.restore();
	expect(f.activations).toEqual([PROFILE]);
	expect(profile()["connection.autoconnect"]).toBe("no");
});

test("an owned profile pinned to the port where the setup radio now sits is disarmed", async () => {
	// A different adapter took the port; its old profile still matches by path.
	const SWAPPED = "swapped-port-ap";
	f.profiles.set(SWAPPED, {
		"802-11-wireless.mode": "ap",
		"802-11-wireless.ssid": "Old dongle AP",
		"802-11-wireless-security.psk": "fixture-password",
		"connection.interface-name": "",
		"802-11-wireless.mac-address": "",
		"match.path": PORT,
		"connection.autoconnect": "yes",
		"connection.autoconnect-priority": "999",
	});
	rememberHotspotCredentials(OTHER, {
		ssid: "Old dongle AP",
		password: "fixture-password",
		conn: SWAPPED,
	});
	saveConfig();

	await f.discover();

	expect(f.profiles.get(SWAPPED)?.["connection.autoconnect"]).toBe("no");
	expect(getConfig().wifi_modes?.[OTHER]).toBe("hotspot");
});

for (const intent of ["station", "hotspot"] as const) {
	test(`a port-only owned profile on a limited setup radio is only disarmed under ${intent} intent`, async () => {
		// No permanent MAC on the setup radio: it stays a candidate, so the port
		// match may disarm the profile but never bind an owner or bring it down.
		const witness = f.witnesses.get(PROVISIONING_AP_IFNAME);
		if (!witness) throw new Error("Missing setup radio witness");
		witness.mac = undefined;
		const SWAPPED = "swapped-port-ap";
		f.profiles.set(SWAPPED, {
			"802-11-wireless.mode": "ap",
			"802-11-wireless.ssid": "Old dongle AP",
			"802-11-wireless-security.psk": "fixture-password",
			"connection.interface-name": "",
			"802-11-wireless.mac-address": "",
			"match.path": PORT,
			"connection.autoconnect": "yes",
			"connection.autoconnect-priority": "999",
		});
		rememberHotspotCredentials(OTHER, {
			ssid: "Old dongle AP",
			password: "fixture-password",
			conn: SWAPPED,
		});
		if (intent === "station") {
			f.persistMode(OTHER, "station");
			f.list([`${PROVISIONING_AP_IFNAME}:wifi:connected:${SWAPPED}`]);
		}
		saveConfig();
		const bind = spyOn(adapterOwner, "bindWifiAdapterOwner");
		const down = spyOn(hotspotActivity, "nmDisconnectActivation");
		try {
			await f.discover();

			expect(f.profiles.get(SWAPPED)?.["connection.autoconnect"]).toBe("no");
			expect(bind.mock.calls.filter(([, owner]) => owner === OTHER)).toEqual(
				[],
			);
			expect(down).not.toHaveBeenCalled();
			expect(getConfig().wifi_modes?.[OTHER]).toBe(
				intent === "station" ? "station" : undefined,
			);
		} finally {
			bind.mockRestore();
			down.mockRestore();
		}
	});
}

test("the first start after a completed setup join, with no accounting yet, restores no AP over the live station", async () => {
	f.persistMode(MAC, "hotspot");
	listProfiles([NEW_STATION, PROVISIONING_STATION_CONNECTION_ID]);
	joinStation(NEW_STATION);
	await f.discover();

	await f.restore();

	expect(f.activations).toEqual([]);
});

test("a completed setup join with an unavailable profile inventory restores no AP over the live station", async () => {
	getConfig().wifi_setup_stations = [OLD_STATION];
	f.persistMode(MAC, "hotspot");
	joinStation(NEW_STATION);
	await f.discover();
	spyOn(provisioningHandoffDeps, "listConnections").mockResolvedValue(
		undefined,
	);
	const retry = spyOn(reconciler, "retryWifiAdapterReconcile");

	await f.restore();

	expect(f.activations).toEqual([]);
	// Restore waits on the bounded discovery retry rather than an edge alone.
	expect(retry).toHaveBeenCalledWith(MAC, undefined, "restore");
	// Unknown clears nothing either; a later successful read decides.
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION]);

	listProfiles(
		[OLD_STATION, PROVISIONING_STATION_CONNECTION_ID],
		[NEW_STATION, PROVISIONING_STATION_CONNECTION_ID],
	);
	spyOn(provisioningHandoffDeps, "listConnections").mockImplementation(
		async () => [...inventory],
	);
	await f.restore();

	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	expect(getConfig().wifi_setup_stations).toEqual([OLD_STATION, NEW_STATION]);
});

test("an unavailable inventory on the first run also holds restore over a live station", async () => {
	f.persistMode(MAC, "hotspot");
	joinStation(NEW_STATION);
	await f.discover();
	spyOn(provisioningHandoffDeps, "listConnections").mockResolvedValue(
		undefined,
	);

	await f.restore();

	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_setup_stations).toBeUndefined();
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});

test.each([
	["is disconnected", false],
	["is on its accounted setup station", true],
] as const)(
	"an unavailable inventory never holds restore when the setup radio %s",
	async (_case, onAccountedStation) => {
		getConfig().wifi_setup_stations = [OLD_STATION];
		f.persistMode(MAC, "hotspot");
		if (onAccountedStation) joinStation(OLD_STATION);
		await f.discover();
		spyOn(provisioningHandoffDeps, "listConnections").mockResolvedValue(
			undefined,
		);

		await f.restore();

		expect(f.activations).toEqual([PROFILE]);
	},
);

test("a station that changes during the inventory read holds restore", async () => {
	getConfig().wifi_setup_stations = [OLD_STATION];
	f.persistMode(MAC, "hotspot");
	listProfiles([NEW_STATION, PROVISIONING_STATION_CONNECTION_ID]);
	joinStation(NEW_STATION);
	await f.discover();
	spyOn(provisioningHandoffDeps, "listConnections").mockImplementation(
		async () => {
			f.row().activeConn = OLD_STATION;
			return [...inventory];
		},
	);

	await f.restore();

	expect(f.activations).toEqual([]);
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});
