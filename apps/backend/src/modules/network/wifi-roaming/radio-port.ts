/**
 * What the roaming observer knows about the box's Wi-Fi radios: read-only.
 *
 * A radio is considered only the way every Wi-Fi mutation admits one
 * (`admitWifiAdapter`): a verified identity row bound to the exact registry
 * object, currently published, with a sampled lifetime. Limited, Unverified,
 * unpublished, removed or replaced rows, `clap-*` AP legs and excluded radios
 * are listed as skipped. NetworkManager's state comes from the registry row
 * CeraUI already keeps; the link itself from `iw dev <if> link` and the
 * radio's phy from `iw dev`. Neither starts a scan, and nothing here writes.
 *
 * The reads await, so every radio's admission is taken again after all of
 * them and must name the same physical radio and publication; a radio
 * replugged or republished during the round's reads is skipped.
 *
 * Verified twins (two radios sharing a permanent MAC, registered as
 * `MAC@port`) are not admitted by the shared admission and are skipped as
 * `twin`, as the diversity check and the two-radio adapter skip them.
 *
 * `iw dev` (which interfaces are in AP mode on which phy) is read at most
 * every 5 s; the link of each radio once a round. Both are routine reads and
 * leave no debug trace per call.
 *
 * For each station's active profile, the number of access points it has
 * connected to (`802-11-wireless.seen-bssids`), whether the profile fixes a
 * BSSID and its key management, in one read-only `nmcli -g` of those three
 * properties, at most once a minute per profile, and reported only while the
 * same profile is still active when the round is assembled. Under two seen
 * access points, a profile without a fixed BSSID and without 802.1X gets
 * NetworkManager's long background-scan interval above -70 dBm (once a day),
 * so the radio will not look for another access point by itself. Only the
 * count and those two facts are kept, not the access points.
 */

import { argMatch, ID_RE } from "../../../helpers/run.ts";
import {
	admitWifiAdapter,
	physicalWifiAdapterId,
	samePhysicalWifiAdapter,
	type WifiAdapterAdmission,
} from "../../wifi/wifi-adapter-admission.ts";
import { getWifiInterfacesByMacAddress } from "../../wifi/wifi-connections.ts";
import type { WifiInterface } from "../../wifi/wifi-interfaces.ts";
import { getNetworkInterfaces } from "../network-interfaces.ts";

export type Runner = (
	bin: string,
	args: string[],
	opts?: { timeout?: number; quiet?: boolean },
) => Promise<string>;

const READ_TIMEOUT_MS = 2_000;
/** How long one `seen-bssids` read stands for a profile. */
export const SEEN_BSSIDS_READ_MS = 60_000;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long one `iw dev` read stands for the phy's AP state. */
export const PHY_READ_MS = 5_000;

/** The link of an associated radio, from `iw dev <if> link`. */
export type RadioLink = Readonly<{
	bssid: string;
	ssid: string | null;
	signalDbm: number | null;
}>;

export type RadioView = Readonly<{
	/** Upstream's physical radio id: permanent MAC plus ifindex, wiphy, phy path. */
	id: string;
	permanentMac: string;
	ifname: string;
	/**
	 * NetworkManager has the radio activated in infrastructure (station) mode
	 * and it holds an address (the registry's `conn` is gated on the address).
	 */
	station: boolean;
	/**
	 * Serving a hotspot now: NetworkManager has an AP active on the radio, its
	 * concurrent AP leg has an active connection, or the radio or another
	 * interface on its phy is in AP mode. `null` when the phy could not be read
	 * and nothing else says so. A hybrid radio is reserved whole. (A row's
	 * `hotspot` object alone says only that the radio could serve one.)
	 */
	reserved: boolean | null;
	/** `null`: not associated; `undefined`: the link could not be read. */
	link: RadioLink | null | undefined;
	/**
	 * Access points the active profile has connected to (`seen-bssids`), `null`
	 * without an active station profile or when it could not be read.
	 */
	seenBssids: number | null;
	/**
	 * The profile's scan rule: `rare` is the once-a-day interval above -70 dBm
	 * (under two seen access points, no fixed BSSID, no 802.1X), `normal` the
	 * shorter one, `other` a profile with a fixed BSSID or 802.1X, whose
	 * scanning follows other rules. `null` unknown.
	 */
	scanRule: "rare" | "normal" | "other" | null;
	/** Its source addresses as the IP list writes them (IPv4, IPv6). */
	addresses: readonly string[];
}>;

export type SkippedRadio = Readonly<{ ifname: string; reason: string }>;

export type RadioRead = Readonly<{
	radios: readonly RadioView[];
	skipped: readonly SkippedRadio[];
}>;

export type RadioPortDeps = Readonly<{
	run: Runner;
	now(): number;
	rows(): Readonly<Record<string, WifiInterface>>;
	admit(registryKey: string): WifiAdapterAdmission | undefined;
	/** Permanent MACs the operator excluded, normalized. */
	exclude: ReadonlySet<string>;
	/** A radio's current source addresses (the network registry). */
	addressesOf(ifname: string): readonly string[];
}>;

/** Parse `iw dev <if> link`. */
export function parseIwLink(stdout: string): RadioLink | null {
	const bssid = /^Connected to ([0-9a-fA-F:]{17})/m.exec(stdout)?.[1];
	if (!bssid) return null;
	const ssid = /^\s*SSID: (.*)$/m.exec(stdout)?.[1] ?? null;
	const signal = /^\s*signal: (-?\d+) dBm/m.exec(stdout)?.[1];
	return {
		bssid: bssid.toLowerCase(),
		ssid,
		signalDbm: signal === undefined ? null : Number(signal),
	};
}

/**
 * Parse `iw dev`: each interface's phy and type. The AP leg CeraUI adds for a
 * hotspot next to a station (`clap-<parent>`) shows up as its own interface
 * on the parent's phy.
 */
export function parseIwDev(
	stdout: string,
): Map<string, { phy: string; type: string | null }> {
	const out = new Map<string, { phy: string; type: string | null }>();
	let phy: string | null = null;
	let current: string | null = null;
	for (const line of stdout.split("\n")) {
		const p = /^phy#(\d+)/.exec(line);
		if (p) {
			phy = `phy${p[1]}`;
			current = null;
			continue;
		}
		const i = /^\s+Interface (\S+)/.exec(line);
		if (i?.[1] && phy) {
			current = i[1];
			out.set(current, { phy, type: null });
			continue;
		}
		const t = /^\s+type (.+)$/.exec(line);
		if (t?.[1] && current) {
			const entry = out.get(current);
			if (entry) entry.type = t[1].trim();
		}
	}
	return out;
}

/** How many access points `nmcli -g 802-11-wireless.seen-bssids` lists. */
export function countSeenBssids(stdout: string): number {
	return stdout
		.trim()
		.split(",")
		.map((b) => b.trim())
		.filter((b) => b !== "").length;
}

export type ProfileScan = Readonly<{
	seenBssids: number;
	scanRule: "rare" | "normal" | "other";
}>;

/** Key management values that make a profile 802.1X. */
const EAP_KEY_MGMT = new Set(["wpa-eap", "wpa-eap-suite-b-192", "ieee8021x"]);

/**
 * Parse `nmcli -g 802-11-wireless.seen-bssids,802-11-wireless.bssid,
 * 802-11-wireless-security.key-mgmt`: one line per property, in that order.
 */
export function parseProfileScan(stdout: string): ProfileScan | null {
	const lines = stdout.replace(/\n$/, "").split("\n");
	// An open profile has no security setting, and nmcli omits its line.
	if (lines.length < 2) return null;
	const [seen = "", bssid = "", keyMgmt = ""] = lines;
	const seenBssids = countSeenBssids(seen);
	const other = bssid.trim() !== "" || EAP_KEY_MGMT.has(keyMgmt.trim());
	return {
		seenBssids,
		scanRule: other ? "other" : seenBssids < 2 ? "rare" : "normal",
	};
}

/** Whether `ifname` or another interface on its phy is in AP mode. */
export function apOnPhyOf(
	devs: ReadonlyMap<string, { phy: string; type: string | null }>,
	ifname: string,
): { phy: string | null; apOnPhy: boolean | null } {
	const own = devs.get(ifname);
	if (!own) return { phy: null, apOnPhy: null };
	for (const d of devs.values())
		if (d.phy === own.phy && d.type === "AP")
			return { phy: own.phy, apOnPhy: true };
	return { phy: own.phy, apOnPhy: false };
}

/** The station profile NetworkManager has active on the row, if any. */
function activeProfileOf(row: WifiInterface): string | null {
	return row.activeMode === "infrastructure"
		? (row.activeConn ?? row.conn ?? null)
		: null;
}

function rowServesHotspot(row: WifiInterface): boolean {
	if (row.activeMode === "ap") return true;
	const leg = "concurrentHotspot" in row ? row.concurrentHotspot : undefined;
	return leg !== undefined && leg.activeConn !== null;
}

export function createRadioPort(deps: RadioPortDeps) {
	const quiet = async (args: string[]) => {
		try {
			return await deps.run("iw", args, {
				timeout: READ_TIMEOUT_MS,
				quiet: true,
			});
		} catch {
			return undefined;
		}
	};
	const seen = new Map<string, { at: number; scan: ProfileScan | null }>();
	const readSeen = async (uuid: string): Promise<ProfileScan | null> => {
		const now = deps.now();
		const kept = seen.get(uuid);
		if (kept && now - kept.at < SEEN_BSSIDS_READ_MS) return kept.scan;
		let scan: ProfileScan | null = null;
		try {
			scan = parseProfileScan(
				await deps.run(
					"nmcli",
					[
						"-g",
						"802-11-wireless.seen-bssids,802-11-wireless.bssid,802-11-wireless-security.key-mgmt",
						"connection",
						"show",
						"uuid",
						argMatch(UUID_RE, uuid),
					],
					{ timeout: READ_TIMEOUT_MS, quiet: true },
				),
			);
		} catch {
			scan = null;
		}
		seen.set(uuid, { at: now, scan });
		return scan;
	};
	let phys:
		| {
				at: number;
				/** The admitted radios (name and physical id) the read was for. */
				radios: string;
				devs: ReturnType<typeof parseIwDev> | undefined;
		  }
		| undefined;
	// A cached read stands only for the same physical radios under the same
	// names: a radio replaced under its name gets a fresh read.
	const readPhys = async (radios: string) => {
		const now = deps.now();
		if (
			phys === undefined ||
			phys.radios !== radios ||
			now - phys.at >= PHY_READ_MS
		) {
			const out = await quiet(["dev"]);
			phys = {
				at: now,
				radios,
				devs: out === undefined ? undefined : parseIwDev(out),
			};
		}
		return phys.devs;
	};

	return {
		async read(): Promise<RadioRead> {
			const skipped: SkippedRadio[] = [];
			const admitted: [string, WifiAdapterAdmission][] = [];
			for (const [key, row] of Object.entries(deps.rows())) {
				if (row.ifname.startsWith("clap-")) continue;
				const admission = deps.admit(key);
				if (!admission) {
					skipped.push({
						ifname: row.ifname,
						reason: key.includes("@") ? "twin" : "not-admitted",
					});
					continue;
				}
				if (deps.exclude.has(admission.permanentMac)) {
					skipped.push({ ifname: row.ifname, reason: "excluded" });
					continue;
				}
				admitted.push([key, admission]);
			}

			const devs =
				admitted.length > 0
					? await readPhys(
							admitted
								.map(([, a]) => `${a.row.ifname}=${physicalWifiAdapterId(a)}`)
								.sort()
								.join(","),
						)
					: undefined;
			const links: (string | undefined)[] = [];
			const seens: { profile: string | null; scan: ProfileScan | null }[] = [];
			for (const [, admission] of admitted) {
				links.push(
					await quiet(["dev", argMatch(ID_RE, admission.row.ifname), "link"]),
				);
				const profile = activeProfileOf(admission.row);
				seens.push({
					profile,
					scan:
						profile !== null && UUID_RE.test(profile)
							? await readSeen(profile)
							: null,
				});
			}
			// Every read awaited: each radio must still be the admitted one,
			// checked after all of them, not just after its own.
			const radios: RadioView[] = [];
			admitted.forEach(([key, admission], i) => {
				const ifname = admission.row.ifname;
				const now = deps.admit(key);
				if (
					!now ||
					now.row !== admission.row ||
					now.incarnation !== admission.incarnation ||
					!samePhysicalWifiAdapter(now, admission)
				) {
					skipped.push({ ifname, reason: "changed-during-read" });
					return;
				}
				const row = admission.row;
				// Every read awaited: a profile reading stands only for the
				// profile still active now, at assembly.
				const seenNow = seens[i];
				const scan =
					seenNow && seenNow.profile === activeProfileOf(row)
						? seenNow.scan
						: null;
				const ap = devs === undefined ? null : apOnPhyOf(devs, ifname).apOnPhy;
				const linkOut = links[i];
				radios.push({
					id: physicalWifiAdapterId(admission),
					permanentMac: admission.permanentMac,
					ifname,
					station: row.conn !== null && row.activeMode === "infrastructure",
					reserved: rowServesHotspot(row) ? true : ap,
					link: linkOut === undefined ? undefined : parseIwLink(linkOut),
					seenBssids: scan?.seenBssids ?? null,
					scanRule: scan?.scanRule ?? null,
					addresses: deps.addressesOf(ifname),
				});
			});
			return { radios, skipped };
		},
	};
}

/** The production dependencies: CeraUI's registry and upstream's admission. */
export function defaultRadioPortDeps(
	run: Runner,
	now: () => number,
	exclude: ReadonlySet<string>,
): RadioPortDeps {
	return {
		run,
		now,
		rows: getWifiInterfacesByMacAddress,
		admit: (key) => admitWifiAdapter(key),
		exclude,
		addressesOf: (ifname) => {
			const int = getNetworkInterfaces()[ifname];
			return [int?.ip, int?.ipv6].filter((a): a is string => !!a);
		},
	};
}
