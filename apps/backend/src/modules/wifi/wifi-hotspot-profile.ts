import { randomUUID } from "node:crypto";
import {
	nmConnAdd,
	nmConnDelete,
	nmConnGetFields,
	nmConnSetFields,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import { forgetHotspotCredentials } from "./hotspot-credentials.ts";
import { broadcastWifiState } from "./wifi.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
import { isHotspotActive } from "./wifi-hotspot-types.ts";
import { getMacAddressForWifiInterface } from "./wifi-interfaces.ts";

const fields = [
	"connection.id",
	"802-11-wireless.mode",
	"802-11-wireless.mac-address",
	"connection.interface-name",
] as const;
const owner = (mac: string) => `CeraUI hotspot ${mac.toLowerCase()}`;
export type HotspotProfileDeps = {
	list(): Promise<string[] | undefined>;
	active(uuid: string): Promise<boolean | undefined>;
	read(uuid: string): Promise<readonly string[] | undefined>;
	settings(
		uuid: string,
		keys: string[],
	): Promise<Record<string, string> | undefined>;
	add(settings: Record<string, string>): Promise<unknown>;
	update(uuid: string, settings: Record<string, string>): Promise<unknown>;
	delete(uuid: string): Promise<unknown>;
};
export const hotspotProfileDeps: HotspotProfileDeps = {
	list: async () => {
		const rows = await nmConnsGet("UUID,TYPE");
		return rows
			?.map(nmcliParseSep)
			.filter((row) => row[1] === "802-11-wireless")
			.map((row) => row[0] ?? "");
	},
	active: async (uuid) => {
		const rows = await nmConnsGet("UUID,ACTIVE");
		if (!rows) return undefined;
		const row = rows.find((row) => row.startsWith(`${uuid}:`));
		if (!row) return false;
		const value = row.slice(uuid.length + 1);
		return value === "yes" ? true : value === "no" ? false : undefined;
	},
	read: (uuid) => nmConnGetFields(uuid, fields),
	settings: async (uuid, keys) => {
		const values = await nmConnGetFields(uuid, keys);
		return (
			values &&
			Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""]))
		);
	},
	add: (settings) => nmConnAdd(settings),
	update: nmConnSetFields,
	delete: nmConnDelete,
};

/** Positive ownership is an exact marker AND AP mode AND permanent adapter binding. */
export async function ownedHotspotProfile(
	mac: string,
	deps = hotspotProfileDeps,
): Promise<string | undefined> {
	const uuids = await deps.list();
	if (!uuids) throw new Error("Profile enumeration unavailable");
	let found: string | undefined;
	for (const uuid of uuids.filter(Boolean)) {
		const row = await deps.read(uuid);
		if (!row) throw new Error("Profile read unavailable");
		if (
			row[0] !== owner(mac) ||
			row[1] !== "ap" ||
			(row[2]?.toLowerCase() !== mac.toLowerCase() &&
				!row[3]?.startsWith("clap-"))
		)
			continue;
		if (found) throw new Error("Multiple owned hotspot profiles");
		found = uuid;
	}
	return found;
}

/** Setup never activates. The marker permits restart recovery after add but before persistence. */
export async function configureHotspotProfile(
	mac: string,
	settings: Record<string, string>,
	deps = hotspotProfileDeps,
	commit: (uuid: string) => void = () => {
		/* No durable identity supplied by this caller. */
	},
): Promise<string> {
	const existing = await ownedHotspotProfile(mac, deps);
	const uuid = existing ?? randomUUID();
	const complete = {
		...settings,
		"connection.id": owner(mac),
		"connection.autoconnect": "no",
		"802-11-wireless.mode": "ap",
		"802-11-wireless.mac-address": mac,
		"ipv4.method": "shared",
	};
	if (existing) {
		if ((await deps.active(uuid)) !== false)
			throw new Error("Stop hotspot before configuring");
		const previous = await deps.settings(uuid, Object.keys(complete));
		if (!previous) throw new Error("Profile snapshot unavailable");
		try {
			if (!(await deps.update(uuid, complete)))
				throw new Error("Profile update failed");
			commit(uuid);
		} catch (error) {
			await deps.update(uuid, previous);
			throw error;
		}
	} else {
		try {
			if (
				!(await deps.add({
					type: "wifi",
					ifname: "*",
					"connection.uuid": uuid,
					...complete,
				}))
			)
				throw new Error("Profile creation failed");
			const readback = await deps.read(uuid);
			if (
				readback?.[0] !== owner(mac) ||
				readback[1] !== "ap" ||
				readback[2]?.toLowerCase() !== mac.toLowerCase()
			)
				throw new Error("Profile verification failed");

			commit(uuid);
		} catch (error) {
			// Only the UUID allocated by this attempt can be rolled back.
			await deps.delete(uuid);
			throw error;
		}
	}
	return uuid;
}

/** Foreign or merely adopted profiles never qualify for deletion. */
export async function deleteHotspotProfile(
	mac: string,
	deps = hotspotProfileDeps,
): Promise<void> {
	const uuid = await ownedHotspotProfile(mac, deps);
	if (uuid && (await deps.active(uuid)) !== false)
		throw new Error("Stop hotspot before deletion");
	if (uuid && !(await deps.delete(uuid)))
		throw new Error("Profile deletion failed");
	forgetHotspotCredentials(mac);
}

export async function wifiHotspotDelete(device: number) {
	const mac = getMacAddressForWifiInterface(device);
	const iface = mac && getWifiInterfaceByMacAddress(mac);
	if (!mac || !iface || !("hotspot" in iface))
		return { success: false, error: "no-device" };
	const lock = await withWifiAdapterLock(wifiAdapterLockKey(mac), async () => {
		if (isHotspotActive(iface) || iface.hotspot.transition)
			return { success: false, error: "DEVICE_BUSY" };
		try {
			await deleteHotspotProfile(mac);
			delete iface.hotspot.conn;
			delete iface.hotspot.name;
			delete iface.hotspot.password;
			delete iface.hotspot.channel;
			broadcastWifiState();
			return { success: true };
		} catch {
			return { success: false, error: "deletion-failed" };
		}
	});
	return lock.success ? lock.result : { success: false, error: "DEVICE_BUSY" };
}
