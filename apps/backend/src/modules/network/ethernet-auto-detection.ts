import type { EthernetRole } from "@ceraui/rpc/schemas";
import { networkChangeSafetyEnabled } from "./ethernet-role-safety.ts";

const DISH_HOST = "192.168.100.1";
const ROUTER_HOST = "192.168.1.1";

export type EthernetPortPolicy = EthernetRole | "auto";

type StarlinkStatus = "dish" | "router";

interface EthernetRouteScope {
	readonly ifindex: number;
	readonly attachment: number;
	readonly routeGeneration: number;
}

/**
 * Read-side evidence for one port and one continuous cable attachment.
 * Discard old observations on carrier loss or port replacement, and assign
 * a new attachment generation even if the ifindex is reused. Advance the route
 * generation for every effective route or source change, even with carrier up.
 */
export interface EthernetDiscovery extends EthernetRouteScope {
	readonly carrier: boolean;
	readonly window: "listening" | "complete" | "unavailable";
	/**
	 * The observer latches external DHCP (response or lease) or a
	 * positive-lifetime IPv6 default router until the attachment ends.
	 */
	readonly upstreamSeen: boolean;
	/** An ingress Discover or Request from a peer, excluding our own DHCP client. */
	readonly peerDhcpRequestSeen: boolean;
	/** Current DHCPv4 lease from this attachment, if any. */
	readonly lease?: { readonly address: string; readonly gateway?: string };
	/** A decoded status reply tagged with the bound route's scope at dispatch. */
	readonly starlinkStatus?: EthernetRouteScope & {
		readonly kind: StarlinkStatus;
		readonly host: string;
		readonly port: number;
	};
}

type Direction =
	| { readonly kind: "manual"; readonly role: EthernetRole }
	| { readonly kind: "uplink" }
	| { readonly kind: "share-candidate" }
	| { readonly kind: "unresolved" }
	| { readonly kind: "detecting" }
	| { readonly kind: "disconnected" };

type StarlinkIdentification = "unknown" | "possible" | "identified";

function identifyStarlink(evidence: EthernetDiscovery): StarlinkIdentification {
	const status = evidence.starlinkStatus;
	if (
		status?.ifindex === evidence.ifindex &&
		status.attachment === evidence.attachment &&
		status.routeGeneration === evidence.routeGeneration &&
		((status.kind === "dish" &&
			status.host === DISH_HOST &&
			status.port === 9200) ||
			(status.kind === "router" &&
				status.host === ROUTER_HOST &&
				status.port === 9000 &&
				evidence.lease?.gateway === ROUTER_HOST))
	) {
		return "identified";
	}

	// The router address and shared address space are common on other networks.
	// Only the dish address is worth surfacing as an unconfirmed hint.
	const lease = evidence.lease;
	return lease?.gateway === DISH_HOST ||
		lease?.address.startsWith("192.168.100.")
		? "possible"
		: "unknown";
}

function detectDirection(
	policy: EthernetPortPolicy,
	evidence: EthernetDiscovery,
): Direction {
	if (policy !== "auto") return { kind: "manual", role: policy };
	if (!evidence.carrier) return { kind: "disconnected" };
	if (evidence.upstreamSeen) return { kind: "uplink" };
	if (evidence.window === "listening") return { kind: "detecting" };
	if (evidence.window === "complete" && evidence.peerDhcpRequestSeen) {
		return { kind: "share-candidate" };
	}
	return { kind: "unresolved" };
}

/**
 * Observe only. A share candidate does not authorize DHCP service or a profile
 * change. Link health and bond admission remain with the existing owners.
 */
export function detectEthernetPort(
	policy: EthernetPortPolicy,
	evidence: EthernetDiscovery,
	env?: Readonly<Record<string, string | undefined>>,
):
	| { readonly direction: Direction; readonly starlink: StarlinkIdentification }
	| undefined {
	if (!networkChangeSafetyEnabled(env)) return undefined;
	const direction = detectDirection(policy, evidence);
	const canIdentify =
		evidence.carrier &&
		(direction.kind === "uplink" ||
			(direction.kind === "manual" && direction.role === "uplink"));
	return {
		direction,
		starlink: canIdentify ? identifyStarlink(evidence) : "unknown",
	};
}
