import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { run, runWithStdin } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { checkConnectivityViaDevice } from "../network/device-bound-probe.ts";
import { createConnectivityTargetResolver } from "../network/uplink-health/connectivity-target.ts";
import { getUplinkHealthEngine } from "../network/uplink-health/state.ts";
import { holdPortalInterface } from "./captive-portal-health.ts";
import {
	captureWifiPortalBindingFromSystem,
	createSystemPortalReaderDeps,
} from "./captive-portal-readers.ts";
import type { PortalBinding } from "./captive-portal-session.ts";
import { createSignInWindow } from "./captive-portal-window.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { currentHotspotApIfnames } from "./wifi-hotspot-clients.ts";

interface RouteConfig {
	ap: string;
	phone: string;
	mac: string;
	wan: string;
	address: string;
	gateway: string;
	dns: string;
	seconds: number;
}
let config: RouteConfig | undefined;
let binding: PortalBinding | undefined;
let needsSweep = false;
let radioId = 0;
let releaseHealth: () => void = () => undefined;
const target = createConnectivityTargetResolver();
const helper = resolve("captive-portal-window.py");
const capture = () =>
	captureWifiPortalBindingFromSystem(radioId, createSystemPortalReaderDeps());
const effect = async (action: "open" | "close" | "sweep") => {
	if (!config && action !== "sweep") return;
	await runWithStdin(
		"python3",
		["-I", helper, action],
		JSON.stringify(config ?? {}),
		{
			timeout: 120000,
			maxBuffer: 4096,
		},
	);
};

let reconciliation: Promise<void> | undefined;
export async function reconcilePortalWindow() {
	if (shouldUseMocks()) return;
	// A late boot call must join the first sweep, never retire a newer window.
	reconciliation ??= effect("sweep").catch((error) => {
		reconciliation = undefined;
		throw error;
	});
	await reconciliation;
}

export const signInWindow = createSignInWindow({
	async open(peer, radio) {
		if (shouldUseMocks()) throw Error("not_on_box_wifi");
		if (!isIPv4(peer)) throw Error("ipv4_required");
		const candidate = Object.values(getWifiInterfacesByMacAddress()).find(
			(r) => r.id === Number(radio),
		);
		if (candidate?.activeMode !== "infrastructure")
			throw Error("wifi_unavailable");
		if (
			getUplinkHealthEngine().get(candidate.ifname)?.reason !== "captive_portal"
		)
			throw Error("not_captive");
		try {
			await reconcilePortalWindow();
			await effect("sweep");
		} catch {
			throw Error("cleanup_required");
		}
		radioId = candidate.id;
		const captured = await capture();
		if (!captured.ok) throw Error("identity_unavailable");
		binding = captured.binding;
		const route = JSON.parse(
			await run("ip", ["-j", "-4", "route", "get", peer], {
				timeout: 2000,
				maxBuffer: 8192,
			}),
		)[0];
		if (!currentHotspotApIfnames().includes(route?.dev))
			throw Error("not_on_box_wifi");
		const neighbors = JSON.parse(
			await run(
				"ip",
				["-j", "-4", "neigh", "show", "to", peer, "dev", route.dev],
				{ timeout: 2000, maxBuffer: 8192 },
			),
		);
		const mac =
			neighbors.length === 1 &&
			neighbors[0].state?.some((s: string) =>
				["REACHABLE", "STALE"].includes(s),
			)
				? neighbors[0].lladdr?.toLowerCase()
				: undefined;
		const stations = await run("iw", ["dev", route.dev, "station", "dump"], {
			timeout: 2000,
			maxBuffer: 32768,
		});
		if (!mac || !stations.toLowerCase().includes(`station ${mac} `))
			throw Error("not_on_box_wifi");
		config = {
			ap: route.dev,
			phone: peer,
			mac,
			wan: binding.link.ifname,
			address: binding.link.address,
			gateway: binding.link.gateway,
			dns: binding.link.dnsServers[0] ?? binding.link.gateway,
			seconds: 600,
		};
		if (!(await this.unchanged())) throw Error("wifi_changed");
		const release = holdPortalInterface(config.wan);
		let deadline = setTimeout(release, 720000);
		releaseHealth = () => {
			clearTimeout(deadline);
			release();
		};
		needsSweep = true;
		try {
			await effect("open");
			needsSweep = false;
		} finally {
			clearTimeout(deadline);
			deadline = setTimeout(release, 600000);
		}
	},
	async close() {
		await effect(needsSweep ? "sweep" : "close");
		needsSweep = false;
		releaseHealth();
	},
	async unchanged() {
		const now = await capture();
		return now.ok && JSON.stringify(now.binding) === JSON.stringify(binding);
	},
	async check() {
		if (!config || !(await this.unchanged())) return false;
		const address = await target();
		if (
			!address ||
			!isIPv4(address) ||
			!(await checkConnectivityViaDevice(address, config.wan))
		)
			return false;
		// TLS must validate normally; never follow redirects or accept a portal certificate.
		const result = await run(
			"curl",
			[
				"-q",
				"--noproxy",
				"*",
				"--silent",
				"--interface",
				`if!${config.wan}`,
				"--max-time",
				"5",
				"--resolve",
				`www.gstatic.com:443:${address}`,
				"--write-out",
				"%{http_code}",
				"https://www.gstatic.com/generate_204",
			],
			{ timeout: 6000, maxBuffer: 1024 },
		);
		return result === "204";
	},
	arm(expire) {
		const timeout = setTimeout(expire, 600000);
		const interval = setInterval(() => {
			if (config) void signInWindow.refresh(config.phone);
		}, 10000);
		return () => {
			clearTimeout(timeout);
			clearInterval(interval);
		};
	},
});
