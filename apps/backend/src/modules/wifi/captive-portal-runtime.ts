import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { run, runWithStdin } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { checkConnectivityViaDevice } from "../network/device-bound-probe.ts";
import { sameNmProfileActivation } from "../network/network-manager-profile-instance.ts";
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
import {
	captureHotspotSteeringFence,
	defaultHotspotSteeringDeps,
	type HotspotSteeringFence,
} from "./wifi-hotspot-readiness.ts";
import {
	canHotspot,
	type HotspotActivationInstance,
	hotspotApIfname,
} from "./wifi-hotspot-types.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";

interface RouteConfig {
	ap: string;
	/** Kernel ifindex of the AP lifetime the phone arrived through. */
	ap_ifindex: number;
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
let closedBinding: PortalBinding | undefined;
let needsSweep = false;
let radioId = 0;
let radioIncarnation = "";
let apPin: ApPin | undefined;
let releaseHealth: () => void = () => undefined;
const target = createConnectivityTargetResolver();
const helper = resolve("captive-portal-window.py");
const capture = () =>
	captureWifiPortalBindingFromSystem(
		radioId,
		radioIncarnation,
		createSystemPortalReaderDeps(),
	);

/**
 * The AP the phone arrived through, pinned at entry and separately from the
 * venue radio: the exact hotspot row and its operation ticket, its active AP
 * profile, the NM activation (active connection path and profile instance),
 * its netif incarnation and kernel ifindex. A Stop, restart, same-profile
 * reactivation on the same netdev or a replacement under the same name never
 * satisfies the pin.
 */
interface ApPin {
	readonly ifname: string;
	readonly ifindex: number;
	readonly uuid: string;
	readonly fence: HotspotSteeringFence;
	readonly witness: HotspotActivationInstance;
}
async function readIfindex(ifname: string): Promise<number | undefined> {
	const links = JSON.parse(
		await run("ip", ["-j", "link", "show", "dev", ifname], {
			timeout: 2000,
			maxBuffer: 16384,
		}),
	);
	const link = Array.isArray(links) && links.length === 1 ? links[0] : {};
	return link?.ifname === ifname &&
		Number.isSafeInteger(link.ifindex) &&
		link.ifindex > 0
		? link.ifindex
		: undefined;
}
/** NM's current activation of `uuid` on `ifname`; absent when not active there. */
async function readApActivation(
	ifname: string,
	uuid: string,
): Promise<HotspotActivationInstance | undefined> {
	const activation = await defaultHotspotSteeringDeps.readActivation?.(
		ifname,
		uuid,
	);
	return activation?.activePath && activation.profile ? activation : undefined;
}
/** A fresh observation of the pinned AP: cached fence, kernel and NM activation. */
async function apPinHolds(pin: ApPin): Promise<boolean> {
	if (!pin.fence.owned()) return false;
	const ifindex = await readIfindex(pin.ifname);
	const lifetime = wifiRadioIdentity.state.rows.get(pin.ifname)?.lifetime;
	if (
		ifindex !== pin.ifindex ||
		(lifetime !== undefined && lifetime.ifindex !== ifindex)
	)
		return false;
	const activation = await readApActivation(pin.ifname, pin.uuid);
	return (
		activation !== undefined &&
		activation.activePath === pin.witness.activePath &&
		sameNmProfileActivation(pin.witness.profile, activation.profile) &&
		pin.fence.owned() &&
		(await readIfindex(pin.ifname)) === pin.ifindex
	);
}
/** The one hotspot row whose running AP is `ifname`, if exactly one is. */
function hotspotRowFor(ifname: unknown) {
	if (typeof ifname !== "string") return undefined;
	const rows = Object.values(getWifiInterfacesByMacAddress()).filter(
		(row) => hotspotApIfname(row) === ifname,
	);
	const row = rows[0];
	return rows.length === 1 && row && canHotspot(row) && row.hotspot.conn
		? row
		: undefined;
}
async function captureApPin(ifname: unknown): Promise<ApPin | undefined> {
	const row = hotspotRowFor(ifname);
	const uuid = row?.hotspot.conn;
	if (typeof ifname !== "string" || !row || !uuid) return undefined;
	const fence = captureHotspotSteeringFence(row, uuid);
	if (
		fence.apIfname !== ifname ||
		fence.incarnation === undefined ||
		!fence.owned()
	)
		return undefined;
	const ifindex = await readIfindex(ifname);
	const witness = await readApActivation(ifname, uuid);
	if (ifindex === undefined || !witness) return undefined;
	const pin = { ifname, ifindex, uuid, fence, witness };
	return (await apPinHolds(pin)) ? pin : undefined;
}
/** The interface the kernel routes back to the phone through. */
async function routeDev(peer: string): Promise<unknown> {
	return JSON.parse(
		await run("ip", ["-j", "-4", "route", "get", peer], {
			timeout: 2000,
			maxBuffer: 8192,
		}),
	)[0]?.dev;
}
/** Fresh observations of both ends; names the end that no longer holds. */
async function changedEnd(pin: ApPin): Promise<"ap" | "station" | undefined> {
	if (!(await apPinHolds(pin))) return "ap";
	const expected = binding;
	const now = await capture();
	if (
		!expected ||
		!now.ok ||
		JSON.stringify(now.binding) !== JSON.stringify(expected)
	)
		return "station";
	return (await apPinHolds(pin)) ? undefined : "ap";
}
async function requireBothEnds(pin: ApPin): Promise<void> {
	const changed = await changedEnd(pin);
	if (changed === "ap") throw Error("not_on_box_wifi");
	if (changed === "station") throw Error("wifi_changed");
}
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
	async open(peer, radio, incarnation, via, viaLifetime) {
		closedBinding = undefined;
		if (shouldUseMocks()) throw Error("not_on_box_wifi");
		if (!isIPv4(peer)) throw Error("ipv4_required");
		// Behind the front door the phone's arrival interface is proven; it must
		// be the hotspot AP itself, not just any link where this address routes.
		if (via !== undefined && !hotspotRowFor(via))
			throw Error("not_on_box_wifi");
		const candidate = Object.values(getWifiInterfacesByMacAddress()).find(
			(r) => r.id === Number(radio),
		);
		if (candidate?.activeMode !== "infrastructure")
			throw Error("wifi_unavailable");
		if (
			getUplinkHealthEngine().get(candidate.ifname)?.reason !== "captive_portal"
		)
			throw Error("not_captive");
		// The arrival interface (proven by the front door, else the route back
		// to the phone) says which AP. Its lifetime is pinned now, before any
		// cleanup or capture, and only that pin is used from here on. A proven
		// interface is pinned before the first route read and must still be the
		// lifetime the front door's evidence was accepted on.
		let pin: ApPin | undefined;
		if (via !== undefined) {
			pin = await captureApPin(via);
			if (
				!pin ||
				viaLifetime?.ifindex === undefined ||
				viaLifetime.incarnation === undefined ||
				pin.ifindex !== viaLifetime.ifindex ||
				pin.fence.incarnation !== viaLifetime.incarnation ||
				(await routeDev(peer)) !== via ||
				!(await apPinHolds(pin))
			)
				throw Error("not_on_box_wifi");
		} else pin = await captureApPin(await routeDev(peer));
		if (!pin) throw Error("not_on_box_wifi");
		try {
			await reconcilePortalWindow();
			await effect("sweep");
		} catch {
			throw Error("cleanup_required");
		}
		radioId = candidate.id;
		radioIncarnation = incarnation;
		const captured = await capture();
		if (!captured.ok)
			throw Error(
				captured.reason === "binding_changed"
					? "wifi_changed"
					: "identity_unavailable",
			);
		binding = captured.binding;
		// Association evidence, bracketed by fresh observations of both ends.
		await requireBothEnds(pin);
		if ((await routeDev(peer)) !== pin.ifname) throw Error("not_on_box_wifi");
		const neighbors = JSON.parse(
			await run(
				"ip",
				["-j", "-4", "neigh", "show", "to", peer, "dev", pin.ifname],
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
		const stations = await run("iw", ["dev", pin.ifname, "station", "dump"], {
			timeout: 2000,
			maxBuffer: 32768,
		});
		if (!mac || !stations.toLowerCase().includes(`station ${mac} `))
			throw Error("not_on_box_wifi");
		apPin = pin;
		config = {
			ap: pin.ifname,
			ap_ifindex: pin.ifindex,
			phone: peer,
			mac,
			wan: binding.link.ifname,
			address: binding.link.address,
			gateway: binding.link.gateway,
			dns: binding.link.dnsServers[0] ?? binding.link.gateway,
			seconds: 600,
		};
		// The installation is bracketed the same way: before the helper runs and
		// after it returns. A failure here closes the installed window.
		await requireBothEnds(pin);
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
		await requireBothEnds(pin);
	},
	async close() {
		await effect(needsSweep ? "sweep" : "close");
		needsSweep = false;
		closedBinding = config ? binding : undefined;
		config = undefined;
		binding = undefined;
		apPin = undefined;
		releaseHealth();
	},
	/** Both ends: the venue radio's exact identity and the phone's AP lifetime. */
	async unchanged() {
		const pin = apPin;
		if (!pin) return false;
		return (await changedEnd(pin)) === undefined && apPin === pin;
	},
	async check() {
		const binding = closedBinding;
		closedBinding = undefined;
		if (!binding) return false;
		const now = await capture();
		if (!now.ok || JSON.stringify(now.binding) !== JSON.stringify(binding))
			return false;
		const address = await target();
		if (
			!address ||
			!isIPv4(address) ||
			!(await checkConnectivityViaDevice(address, binding.link.ifname))
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
				`if!${binding.link.ifname}`,
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
	arm(expire, peer, via) {
		const timeout = setTimeout(expire, 600000);
		const interval = setInterval(() => {
			void signInWindow.refresh(peer, via);
		}, 10000);
		return () => {
			clearTimeout(timeout);
			clearInterval(interval);
		};
	},
});
