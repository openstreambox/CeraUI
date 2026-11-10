import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { ID_RE } from "../../helpers/run.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

export function isWirelessInterface(
	ifname: string,
	root = "/sys/class/net",
): boolean {
	return (
		ID_RE.test(ifname) &&
		(existsSync(`${root}/${ifname}/wireless`) ||
			existsSync(`${root}/${ifname}/phy80211`))
	);
}

/** NM enumerates disconnected radios too; sysfs supplies their address even
 * when net-tools omits a down interface entirely. */
export async function readWirelessAddress(
	ifname: string,
): Promise<string | undefined> {
	if (!ID_RE.test(ifname)) return undefined;
	try {
		return normalizeMacAddress(
			await readFile(`/sys/class/net/${ifname}/address`, "utf8"),
		);
	} catch {
		return undefined;
	}
}

export type WifiRadioIdentity = {
	id: string;
	permanent_mac: string;
	phy?: string;
	device_path?: string;
};

export async function readWifiRadioIdentity(
	ifname: string,
	permanentMac: string,
	resolvePath: (path: string) => Promise<string> = realpath,
): Promise<WifiRadioIdentity> {
	const identity: WifiRadioIdentity = {
		id: permanentMac,
		permanent_mac: permanentMac,
	};
	if (!ID_RE.test(ifname)) return identity;
	try {
		identity.phy = basename(
			await resolvePath(`/sys/class/net/${ifname}/phy80211`),
		);
	} catch {
		/* A legacy wireless driver need not expose cfg80211. */
	}
	try {
		identity.device_path = (
			await resolvePath(`/sys/class/net/${ifname}/device`)
		).replace(/^\/sys\/devices\//, "");
	} catch {
		/* Physical path is unknown, never inferred from the name. */
	}
	return identity;
}

export async function resolveWirelessAddress(
	ifname: string,
	cached: string | undefined,
	readSysfs = readWirelessAddress,
	readNm: (ifname: string) => Promise<string | undefined> = async () =>
		undefined,
): Promise<string | undefined> {
	return (
		normalizeMacAddress(cached) ??
		normalizeMacAddress(await readSysfs(ifname)) ??
		normalizeMacAddress(await readNm(ifname))
	);
}
