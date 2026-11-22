import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import type { RPCContext } from "../../rpc/types.ts";
import { isConcurrentHotspot, isHotspot } from "../wifi/wifi-hotspot-types.ts";
import type { WifiInterface } from "../wifi/wifi-interfaces.ts";
import { ingressBudgetKey } from "./budget.ts";
import type { ChannelIngress } from "./channel.ts";
import { keyFingerprint } from "./transcript.ts";

/**
 * Which arrival paths may carry the companion channel, decided on the server
 * from transport evidence only, never from anything the caller says.
 *
 * - Front door (the image's TLS listener on physical links): the socket came
 *   in on the private local ingress with validated interface and peer
 *   evidence. Binding is the SHA-256 of the box's TLS key, which the front
 *   door serves. The setup hotspot's AP interface is the setup ingress; any
 *   other physical link is local.
 * - Development only: in a development runtime on an image without the
 *   front door, a native client (no Origin, no forwarding headers) on
 *   loopback TCP. Binding is `loopback`, and a companion only accepts that
 *   for a loopback URL. Production runtimes never take this path.
 * - Refused: remote-control relay senders, overlays and tunnels (the front
 *   door does not listen there), any TCP socket on an image with the front
 *   door (its proxied clients also arrive from loopback), and a socket whose
 *   interface evidence no longer holds.
 */
export interface CompanionIngressDeps {
	frontDoor(): boolean;
	isSetupHotspot(ifname: string): boolean;
	tlsBinding(): string | undefined;
	/** True only in a development runtime (not a production build or launch). */
	development(): boolean;
}

export function classifyCompanionIngress(
	context: Pick<RPCContext, "ws" | "getSenderId">,
	deps: CompanionIngressDeps,
): ChannelIngress | undefined {
	if (context.getSenderId() !== undefined) return undefined;
	const { data } = context.ws;
	const path = data.ingressPath;
	if (path) {
		if (data.ingressPathValid?.() !== true) return undefined;
		const binding = deps.tlsBinding();
		if (!binding) return undefined;
		return {
			kind: deps.isSetupHotspot(path.interface) ? "setup" : "local",
			key: ingressBudgetKey(path.interface, path.peer),
			binding,
		};
	}
	if (
		!deps.development() ||
		deps.frontDoor() ||
		data.companionLoopbackClient !== true
	)
		return undefined;
	const peer = context.ws.remoteAddress.replace(/^::ffff:/, "");
	if (peer !== "127.0.0.1" && peer !== "::1") return undefined;
	return {
		kind: "setup",
		key: ingressBudgetKey("lo", peer),
		binding: "loopback",
	};
}

export const DEFAULT_TLS_CERT = "/data/ceralive/tls/ceralive.crt";

/** `tls-spki:<hex>` for the certificate the front door serves, if readable. */
export function tlsBindingFromCertificate(path: string): string | undefined {
	try {
		const cert = new X509Certificate(readFileSync(path));
		const spki = cert.publicKey.export({ type: "spki", format: "der" });
		return `tls-spki:${keyFingerprint(Buffer.from(spki))}`;
	} catch {
		return undefined;
	}
}

/** The same value a companion computes from the certificate it was shown. */
export function tlsBindingFromPeer(certificate: X509Certificate): string {
	const spki = certificate.publicKey.export({ type: "spki", format: "der" });
	return `tls-spki:${keyFingerprint(Buffer.from(spki))}`;
}

/**
 * Upgrade-time admission for the development loopback path: the flag, a
 * development runtime, no Origin, no forwarding headers and no front door.
 */
export function companionLoopbackAdmission(
	headers: Headers,
	deps: { enabled: boolean; development: boolean; frontDoor: () => boolean },
): boolean {
	return (
		deps.enabled &&
		deps.development &&
		!headers.has("origin") &&
		!["forwarded", "x-forwarded-for", "x-real-ip", "via"].some((name) =>
			headers.has(name),
		) &&
		!deps.frontDoor()
	);
}

/**
 * The setup ingress: the interface that runs the box's own hotspot profile
 * now, on exactly one radio. Any other AP-mode connection does not count.
 */
export function setupHotspotInterface(
	rows: readonly WifiInterface[],
	ifname: string,
): boolean {
	return (
		rows.filter((row) => {
			if (isHotspot(row)) return row.ifname === ifname;
			if (isConcurrentHotspot(row))
				return row.concurrentHotspot?.ifname === ifname;
			return false;
		}).length === 1
	);
}

/**
 * Load the Wi-Fi state reader on first use, so importing the companion routes
 * with the flag off never pulls in the Wi-Fi modules. Until it has loaded,
 * no interface is the setup ingress.
 */
export function lazySetupHotspotCheck(
	load: () => Promise<(ifname: string) => boolean>,
): (ifname: string) => boolean {
	let check: ((ifname: string) => boolean) | undefined;
	let loading = false;
	return (ifname) => {
		if (check) return check(ifname);
		if (!loading) {
			loading = true;
			void load()
				.then((loaded) => {
					check = loaded;
				})
				.catch(() => {
					loading = false;
				});
		}
		return false;
	};
}
