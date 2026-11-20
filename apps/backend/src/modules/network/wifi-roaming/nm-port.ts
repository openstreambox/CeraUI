/**
 * NetworkManager, iw and ip behind the roaming coordinator's ports.
 *
 * Every write names the searcher's interface explicitly. Holders are only
 * ever read: `iw dev <if> link`, `ip -j`, and `nmcli` listings without a
 * rescan.
 *
 * The searcher joins through an owned in-memory clone of its own saved,
 * interface-bound profile, locked to the chosen BSSID with autoconnect off.
 * The operator's profile is never modified. A profile with a BSSID set gets
 * no background scan from NetworkManager and the supplicant does not roam
 * away from that BSSID.
 */
import { readFile } from "node:fs/promises";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import {
	JOIN_REFUSED,
	type JoinResult,
	type RadioObservation,
} from "./coordinator.ts";
import type { ScanRow, UplinkIdentity } from "./policy.ts";

export type Runner = (
	bin: string,
	args: string[],
	opts?: { timeout?: number },
) => Promise<string>;

const BSSID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOIN_WAIT_S = 12;
/** Below the coordinator's 15 s scan budget, so a slow scan fails rather than overruns. */
const SCAN_TIMEOUT_MS = 14_000;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Network address of an IPv4 CIDR, e.g. 192.0.2.17/24 -> 192.0.2.0/24. */
export function subnetOf(cidr: string): string | null {
	const [ip, prefixRaw] = cidr.split("/");
	const prefix = Number(prefixRaw);
	if (
		!ip ||
		!IPV4_RE.test(ip) ||
		!Number.isInteger(prefix) ||
		prefix < 0 ||
		prefix > 32
	)
		return null;
	const n = ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const net = (n & mask) >>> 0;
	return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join(".")}/${prefix}`;
}

/** Name of the owned clone for one radio. */
export const searchProfileName = (ifname: string): string =>
	`ceraui-search-${argMatch(ID_RE, ifname)}`;

/** Parse `iw dev <if> link`. */
export function parseIwLink(
	stdout: string,
): { bssid: string; ssid: string | null; signalDbm: number | null } | null {
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

/** Undo nmcli's `-g` escaping of `:` and `\\`. */
export const unescapeNmcli = (value: string): string =>
	value.replace(/\\(.)/g, "$1");

/**
 * Split one line of nmcli terse output (`-t`) into fields. nmcli escapes both
 * `:` and `\\` in terse values, so a backslash always escapes the next
 * character and only an unescaped colon separates fields. The same rule as
 * {@link unescapeNmcli}, so an SSID reads the same from a scan and from a
 * saved profile.
 */
export function splitTerse(line: string): string[] {
	const fields: string[] = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			cur += line[i + 1];
			i++;
		} else if (ch === ":") {
			fields.push(cur);
			cur = "";
		} else cur += ch;
	}
	fields.push(cur);
	return fields;
}

/** Parse `nmcli -t -f BSSID,SSID,SIGNAL,CHAN device wifi list …`. */
export function parseScanRows(stdout: string): ScanRow[] {
	const rows: ScanRow[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [bssid, ssid, signal, chan] = splitTerse(line);
		const b = bssid?.toLowerCase() ?? "";
		const quality = Number.parseInt(signal ?? "", 10);
		if (!BSSID_RE.test(b) || Number.isNaN(quality)) continue;
		const channel = Number.parseInt(chan ?? "", 10);
		rows.push({
			bssid: b,
			ssid: ssid ?? "",
			quality,
			channel: Number.isNaN(channel) ? null : channel,
		});
	}
	return rows;
}

/** UUID of the new profile in `nmcli connection clone` output. */
export function parseCloneUuid(stdout: string): string | undefined {
	const all = [...stdout.matchAll(/\(([0-9a-f-]{36})\)/g)];
	const uuid = all[all.length - 1]?.[1];
	return uuid && UUID_RE.test(uuid) ? uuid : undefined;
}

export type SearchNmDeps = Readonly<{
	run: Runner;
	/** MAC address the radio's saved profiles are bound to. */
	macOf?: (ifname: string) => Promise<string | undefined>;
}>;

async function sysfsMac(ifname: string): Promise<string | undefined> {
	try {
		const mac = (
			await readFile(
				`/sys/class/net/${argMatch(ID_RE, ifname)}/address`,
				"utf8",
			)
		)
			.trim()
			.toLowerCase();
		return BSSID_RE.test(mac) ? mac : undefined;
	} catch {
		return undefined;
	}
}

export function createSearchNm(deps: SearchNmDeps) {
	const run = deps.run;
	const macOf = deps.macOf ?? sysfsMac;
	const quiet = async (bin: string, args: string[], timeout = 10_000) => {
		try {
			return await run(bin, args, { timeout });
		} catch {
			return undefined;
		}
	};

	/**
	 * UUID of the profile active on `ifname`, `null` when the listing shows
	 * none, `undefined` when the listing could not be read. Callers must not
	 * treat an unreadable listing as "nothing active".
	 */
	async function activeProfile(
		ifname: string,
	): Promise<string | null | undefined> {
		const out = await quiet("nmcli", [
			"-t",
			"-f",
			"DEVICE,UUID",
			"connection",
			"show",
			"--active",
		]);
		if (out === undefined) return undefined;
		for (const line of out.split("\n")) {
			const [device, uuid] = splitTerse(line);
			if (device === ifname && uuid && UUID_RE.test(uuid)) return uuid;
		}
		return null;
	}

	async function profileFields(
		uuid: string,
	): Promise<{ ssid: string; mac: string; bssid: string } | undefined> {
		const out = await quiet("nmcli", [
			"-g",
			"802-11-wireless.ssid,802-11-wireless.mac-address,802-11-wireless.bssid",
			"connection",
			"show",
			argMatch(UUID_RE, uuid),
		]);
		if (out === undefined) return undefined;
		const [ssid = "", mac = "", bssid = ""] = out.split("\n");
		return {
			ssid: unescapeNmcli(ssid),
			mac: unescapeNmcli(mac).toLowerCase(),
			bssid: unescapeNmcli(bssid).toLowerCase(),
		};
	}

	/** Saved Wi-Fi profiles bound to this radio, by SSID. */
	async function boundProfiles(ifname: string): Promise<Map<string, string>> {
		const mac = await macOf(ifname);
		const bySsid = new Map<string, string>();
		if (!mac) return bySsid;
		const out = await quiet("nmcli", [
			"-t",
			"-f",
			"NAME,UUID,TYPE",
			"connection",
			"show",
		]);
		const owned = searchProfileName(ifname);
		for (const line of out?.split("\n") ?? []) {
			const [name, uuid, type] = splitTerse(line);
			if (type !== "802-11-wireless" || !uuid || !UUID_RE.test(uuid)) continue;
			if (name === owned) continue;
			const f = await profileFields(uuid);
			if (f?.ssid && f.mac === mac && !bySsid.has(f.ssid))
				bySsid.set(f.ssid, uuid);
		}
		return bySsid;
	}

	/**
	 * Remove this radio's earlier owned clones, keeping `keep`. Runs only after
	 * the last check before activation, so it shares that check.
	 */
	async function deleteStaleOwned(ifname: string, keep: string): Promise<void> {
		const out = await quiet("nmcli", [
			"-t",
			"-f",
			"NAME,UUID",
			"connection",
			"show",
		]);
		const owned = searchProfileName(ifname);
		for (const line of out?.split("\n") ?? []) {
			const [name, uuid] = splitTerse(line);
			if (name === owned && uuid && uuid !== keep && UUID_RE.test(uuid))
				await quiet("nmcli", ["connection", "delete", uuid]);
		}
	}

	return {
		async observe(ifname: string): Promise<RadioObservation | undefined> {
			const dev = argMatch(ID_RE, ifname);
			const link = await quiet("iw", ["dev", dev, "link"]);
			if (link === undefined) return undefined;
			const parsed = parseIwLink(link);
			// A radio in AP mode reads "Not connected" here, like an idle one.
			const devs = await quiet("iw", ["dev"]);
			const mode =
				devs === undefined
					? { phy: null, apOnPhy: null }
					: apOnPhyOf(parseIwDev(devs), dev);
			const active = await activeProfile(dev);
			const activation = active ?? null;
			const locked = activation
				? ((await profileFields(activation))?.bssid ?? "") !== ""
				: false;
			let address: string | null = null;
			let gateway: string | null = null;
			try {
				const addrs = JSON.parse(
					(await run("ip", ["-j", "-4", "addr", "show", "dev", dev])) || "[]",
				) as Array<{
					addr_info?: Array<{ local?: string; prefixlen?: number }>;
				}>;
				const a = addrs[0]?.addr_info?.[0];
				if (a?.local) address = `${a.local}/${a.prefixlen ?? 32}`;
				const routes = JSON.parse(
					(await run("ip", [
						"-j",
						"-4",
						"route",
						"show",
						"default",
						"dev",
						dev,
					])) || "[]",
				) as Array<{ gateway?: string }>;
				gateway = routes.find((r) => r.gateway)?.gateway ?? null;
			} catch {
				// Unreadable lease or route is the same as none for verification.
			}
			return {
				ifname: dev,
				ssid: parsed?.ssid ?? null,
				bssid: parsed?.bssid ?? null,
				signalDbm: parsed?.signalDbm ?? null,
				address,
				gateway,
				routed: gateway !== null,
				activation,
				activationRead: active !== undefined,
				bssidLocked: locked,
				phy: mode.phy,
				apOnPhy: mode.apOnPhy,
			};
		},

		/** Phy and AP state from `iw dev` alone: cheap enough to read late. */
		async radioMode(
			ifname: string,
		): Promise<{ phy: string | null; apOnPhy: boolean | null } | undefined> {
			const dev = argMatch(ID_RE, ifname);
			const devs = await quiet("iw", ["dev"]);
			return devs === undefined ? undefined : apOnPhyOf(parseIwDev(devs), dev);
		},

		async scan(ifname: string): Promise<readonly ScanRow[] | undefined> {
			const out = await quiet(
				"nmcli",
				[
					"-t",
					"-f",
					"BSSID,SSID,SIGNAL,CHAN",
					"device",
					"wifi",
					"list",
					"ifname",
					argMatch(ID_RE, ifname),
					"--rescan",
					"yes",
				],
				SCAN_TIMEOUT_MS,
			);
			return out === undefined ? undefined : parseScanRows(out);
		},

		async savedSsids(ifname: string): Promise<ReadonlySet<string>> {
			return new Set((await boundProfiles(ifname)).keys());
		},

		async join(
			ifname: string,
			ssid: string,
			bssid: string,
			mayActivate: () => Promise<boolean> = async () => true,
		): Promise<JoinResult | typeof JOIN_REFUSED | undefined> {
			const dev = argMatch(ID_RE, ifname);
			const target = argMatch(BSSID_RE, bssid.toLowerCase());
			const source = (await boundProfiles(dev)).get(ssid);
			if (!source) return undefined;
			const name = searchProfileName(dev);
			const cloned = await quiet("nmcli", [
				"connection",
				"clone",
				"--temporary",
				argMatch(UUID_RE, source),
				name,
			]);
			const uuid = cloned && parseCloneUuid(cloned);
			if (!uuid) return undefined;
			const modified = await quiet("nmcli", [
				"connection",
				"modify",
				"--temporary",
				uuid,
				"802-11-wireless.bssid",
				target,
				"connection.autoconnect",
				"no",
			]);
			if (modified !== undefined && !(await mayActivate())) {
				await quiet("nmcli", ["connection", "delete", uuid]);
				return JOIN_REFUSED;
			}
			if (modified !== undefined) await deleteStaleOwned(dev, uuid);
			const up =
				modified !== undefined &&
				(await quiet(
					"nmcli",
					["-w", String(JOIN_WAIT_S), "connection", "up", uuid, "ifname", dev],
					(JOIN_WAIT_S + 3) * 1000,
				)) !== undefined;
			if (!up) {
				await quiet("nmcli", ["connection", "delete", uuid]);
				return undefined;
			}
			return { activation: uuid };
		},

		/**
		 * Gateway, its link-layer address and the connected subnet. Two SSIDs
		 * behind one router share the gateway MAC; one SSID on two routers does
		 * not. The egress address needs an outside observer and stays `null`
		 * until one is wired in.
		 */
		async uplinkOf(
			ifname: string,
			observation: RadioObservation,
		): Promise<UplinkIdentity> {
			const dev = argMatch(ID_RE, ifname);
			const gateway = observation.gateway;
			let gatewayMac: string | null = null;
			if (gateway !== null && IPV4_RE.test(gateway)) {
				try {
					const neigh = JSON.parse(
						(await run("ip", ["-j", "neigh", "show", gateway, "dev", dev])) ||
							"[]",
					) as Array<{ lladdr?: string }>;
					const mac = neigh[0]?.lladdr?.toLowerCase();
					if (mac && BSSID_RE.test(mac)) gatewayMac = mac;
				} catch {
					// Unknown gateway MAC; classification falls back to gateway+subnet.
				}
			}
			return {
				gateway,
				gatewayMac,
				subnet: observation.address ? subnetOf(observation.address) : null,
				egress: null,
			};
		},

		async abandon(ifname: string, activation: string): Promise<boolean> {
			argMatch(ID_RE, ifname);
			if (!UUID_RE.test(activation)) return false;
			return (
				(await quiet("nmcli", ["connection", "delete", activation])) !==
				undefined
			);
		},
	};
}
