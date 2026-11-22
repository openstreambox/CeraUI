import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import type { RPCContext } from "../../rpc/types.ts";
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
 * - Development and SSH forwards: on an image without the front door, a
 *   native client (no Origin, no forwarding headers) on loopback TCP. Binding
 *   is `loopback`, and the companion only accepts that for a loopback URL.
 * - Refused: remote-control relay senders, overlays and tunnels (the front
 *   door does not listen there), any TCP socket on an image with the front
 *   door (its proxied clients also arrive from loopback), and a socket whose
 *   interface evidence no longer holds.
 */
export interface CompanionIngressDeps {
	frontDoor(): boolean;
	isSetupHotspot(ifname: string): boolean;
	tlsBinding(): string | undefined;
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
	if (deps.frontDoor() || data.companionLoopbackClient !== true)
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
