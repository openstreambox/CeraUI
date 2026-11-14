import { mkdir, readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { getms } from "../../helpers/time.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getNetworkInterfaces } from "../network/network-interfaces.ts";
import { withDeviceLock } from "../network/state/device-lock.ts";
import { installHeatWifiWake } from "./heat-wifi-demand.ts";
import { HeatWifiRest, type IdleWifiRadio } from "./heat-wifi-rest.ts";
import { wifiAdapterLockKey } from "./wifi-adapter-lock.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { isApMode } from "./wifi-hotspot-types.ts";

/** An address of any family can carry management; any route can carry an uplink. */
export function idleWifiEvidence(row: {
	usb: boolean;
	singleRadioInterface: boolean;
	disconnected: boolean;
	bond: boolean;
	hotspot: boolean;
	addresses: unknown[];
	routes: unknown[];
}): boolean {
	return (
		row.usb &&
		row.singleRadioInterface &&
		row.disconnected &&
		!row.bond &&
		!row.hotspot &&
		row.addresses.length === 0 &&
		row.routes.length === 0
	);
}

export const heatWifiReaders = {
	registry: getWifiInterfacesByMacAddress,
	interfaces: getNetworkInterfaces,
	realpath: (path: string) => realpath(path),
	read: (path: string) => Bun.file(path).text(),
	list: (path: string) => readdir(path),
	command: run,
};
export async function readHeatWifiRadios(
	deps = heatWifiReaders,
	key?: string,
): Promise<IdleWifiRadio[]> {
	const rows: IdleWifiRadio[] = [];
	for (const [mac, radio] of Object.entries(deps.registry())) {
		try {
			if (key && wifiAdapterLockKey(mac) !== key) continue;
			if (radio.removed || radio.degradedReason) continue;
			const base = `/sys/class/net/${radio.ifname}`;
			const path = await deps.realpath(`${base}/device`);
			const index = (await deps.read(`${base}/ifindex`)).trim();
			const phy = await deps.realpath(`${base}/phy80211`);
			const siblings = await deps.list(`${phy}/device/net`);
			const uppers = (await deps.list(base)).some((name) =>
				name.startsWith("upper_"),
			);
			const nmState = await deps.command(
				"nmcli",
				["-g", "GENERAL.STATE", "device", "show", radio.ifname],
				{ timeout: 2000 },
			);
			const address = JSON.parse(
				await deps.command(
					"ip",
					["-j", "address", "show", "dev", radio.ifname],
					{
						timeout: 2000,
					},
				),
			);
			const routes = [];
			for (const family of ["-4", "-6"]) {
				const data: unknown = JSON.parse(
					await deps.command(
						"ip",
						[
							family,
							"-j",
							"route",
							"show",
							"table",
							"all",
							"dev",
							radio.ifname,
						],
						{ timeout: 2000 },
					),
				);
				if (!Array.isArray(data)) throw Error("Unknown routes");
				routes.push(...data);
			}
			if (
				!Array.isArray(address) ||
				address.length !== 1 ||
				!Array.isArray(address[0].addr_info) ||
				!Array.isArray(address[0].flags)
			)
				continue;
			rows.push({
				key: wifiAdapterLockKey(mac),
				identity: `${(await deps.read("/proc/sys/kernel/random/boot_id")).trim()}/${path}/${index}`,
				ifname: radio.ifname,
				up: address[0].flags.includes("UP"),
				eligible: idleWifiEvidence({
					usb: /\/usb\d+\//.test(path),
					singleRadioInterface:
						siblings.length === 1 && siblings[0] === radio.ifname && !uppers,
					disconnected:
						radio.conn === null &&
						radio.activeConn === null &&
						radio.activeMode === undefined &&
						(/^(?:30)(?:\s|$)/.test(nmState.trim()) ||
							(!address[0].flags.includes("UP") &&
								/^20(?:\s|$)/.test(nmState.trim()))) &&
						!address[0].master,
					bond: deps.interfaces()[radio.ifname]?.enabled === true,
					hotspot: isApMode(radio) || !!radio.concurrentHotspot,
					addresses: address[0].addr_info,
					routes,
				}),
			});
		} catch {
			/* Unreadable identity or network evidence never admits a rest. */
		}
	}
	return rows;
}
async function nativeIdentity(ifname: string): Promise<string> {
	const base = `/sys/class/net/${ifname}`;
	return `${(await Bun.file("/proc/sys/kernel/random/boot_id").text()).trim()}/${await realpath(`${base}/device`)}/${(await Bun.file(`${base}/ifindex`).text()).trim()}`;
}
let latest = { stage: 0, known: false, at: -Infinity };
const journal = "/run/ceralive/heat-wifi-rest.json";
export async function saveHeatWifiJournal(
	rows: IdleWifiRadio[],
	file = journal,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o755 });
	writeFileAtomicSync(file, JSON.stringify(rows), { mode: 0o600 });
}
const owner = new HeatWifiRest({
	load: async () => {
		let text: string;
		try {
			text = await Bun.file(journal).text();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const rows: unknown = JSON.parse(text);
		if (
			!Array.isArray(rows) ||
			rows.length > 32 ||
			rows.some(
				(r) =>
					!r ||
					typeof r.key !== "string" ||
					typeof r.identity !== "string" ||
					typeof r.ifname !== "string",
			)
		)
			throw Error("Invalid Wi-Fi heat recovery record");
		return rows as IdleWifiRadio[];
	},
	save: (rows) => saveHeatWifiJournal(rows),
	read: (key) => readHeatWifiRadios(heatWifiReaders, key),
	wakeRead: async (old) => {
		const current = Object.entries(getWifiInterfacesByMacAddress()).find(
			([mac]) => wifiAdapterLockKey(mac) === old.key,
		)?.[1];
		const ifname = current?.ifname ?? old.ifname;
		return { ...old, ifname, identity: await nativeIdentity(ifname) };
	},
	canRest: () =>
		latest.known && latest.stage >= 1 && getms() - latest.at <= 5000,
	lock: withDeviceLock,
	set: async (row, up) => {
		const identity = await nativeIdentity(row.ifname);
		if (identity !== row.identity)
			throw Error("Wi-Fi identity changed before heat action");
		if (
			!up &&
			(!latest.known || latest.stage < 1 || getms() - latest.at > 5000)
		)
			throw Error("Heat trigger no longer current");
		await run("ip", ["link", "set", "dev", row.ifname, up ? "up" : "down"], {
			timeout: 2000,
		});
	},
	record: (row, reason) =>
		logger.info("Wi-Fi heat action", {
			ifname: row.ifname,
			reason,
			method: "ip-link",
		}),
});
installHeatWifiWake((key) =>
	shouldUseMocks() ? Promise.resolve() : owner.demand(key),
);
let busy = false;
export function updateHeatWifi(stage: number, known: boolean): void {
	latest = { stage, known, at: getms() };
	if (shouldUseMocks() || busy) return;
	busy = true;
	void owner
		.update(stage, known)
		.catch((error) => logger.warn("Wi-Fi heat action failed", { error }))
		.finally(() => {
			busy = false;
		});
}
