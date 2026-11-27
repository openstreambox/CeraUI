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

export type Runner = (
	bin: string,
	args: string[],
	opts?: { timeout?: number; quiet?: boolean },
) => Promise<string>;

const READ_TIMEOUT_MS = 2_000;
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
	let phys:
		| { at: number; devs: ReturnType<typeof parseIwDev> | undefined }
		| undefined;
	const readPhys = async () => {
		const now = deps.now();
		if (phys === undefined || now - phys.at >= PHY_READ_MS) {
			const out = await quiet(["dev"]);
			phys = { at: now, devs: out === undefined ? undefined : parseIwDev(out) };
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

			const devs = admitted.length > 0 ? await readPhys() : undefined;
			const links: (string | undefined)[] = [];
			for (const [, admission] of admitted)
				links.push(
					await quiet(["dev", argMatch(ID_RE, admission.row.ifname), "link"]),
				);
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
				const ap = devs === undefined ? null : apOnPhyOf(devs, ifname).apOnPhy;
				const linkOut = links[i];
				radios.push({
					id: physicalWifiAdapterId(admission),
					permanentMac: admission.permanentMac,
					ifname,
					station: row.conn !== null && row.activeMode === "infrastructure",
					reserved: rowServesHotspot(row) ? true : ap,
					link: linkOut === undefined ? undefined : parseIwLink(linkOut),
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
	};
}
