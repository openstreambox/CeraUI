import { logger } from "../../../helpers/logger.ts";
import { isDevelopment } from "../../../mocks/mock-config.ts";
import { emitEvent } from "../../events/emit.ts";
import {
	buildLinkTelemetry,
	linkQuietForMs,
} from "../../streaming/link-telemetry.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { portalHealthProbe } from "../../wifi/captive-portal-health.ts";
import {
	deviceBoundProbeExclusionReason,
	eligibleProbeCandidates,
} from "../connectivity-candidates.ts";
import { probeConnectivityViaDevice } from "../device-bound-probe.ts";
import {
	getNetworkInterfaces,
	onNetworkInterfacesChange,
} from "../network-interfaces.ts";
import { resolveUplinkIdentity } from "../uplink-identity.ts";
import {
	type ConnectivityTargetResolver,
	type ConnectivityTargetRotation,
	createConnectivityTargetResolver,
} from "./connectivity-target.ts";
import { UPLINK_HEALTH_CONFIG, type UplinkHealthState } from "./model.ts";
import {
	UplinkHealthRuntimeCore,
	type UplinkHealthRuntimeCoreDeps,
} from "./runtime-core.ts";
import {
	getPhoneLinkCounts,
	getUplinkHealthEngine,
	notifyUplinkHealthChange,
} from "./state.ts";

export const UPLINKS_EVENT = "uplinks" as const;

export type UplinkHealthRuntimeDeps = Omit<
	UplinkHealthRuntimeCoreDeps,
	"exclusionReason" | "candidates" | "identity" | "notify" | "probe"
> & {
	readonly probe: (
		iface: string,
		remoteAddr: string,
	) => Promise<import("./model.ts").UplinkHealthOutcome>;
};

/*
  Built on FIRST USE, never at module scope. `connectivity-target.ts` reaches
  `dns.ts`/`internet.ts`, and that graph comes back here through
  `gateways.ts -> uplink-health/index.ts`, so constructing the resolver while
  this module is still initializing reads a `const` the cycle has not defined
  yet. One shared instance, so the TTL cache is shared by every default runtime.
*/
let sharedTarget:
	| (ConnectivityTargetResolver & ConnectivityTargetRotation)
	| undefined;
const resolveTargetShared: ConnectivityTargetResolver = (family) => {
	sharedTarget ??= createConnectivityTargetResolver();
	return sharedTarget(family);
};

/**
 * The default check target. Under mocks the interfaces are fictional, so
 * resolving the public check domain on the host and probing through mock
 * interface names would only reach the developer's own network; no target
 * skips the active round, exactly as an unresolvable address does.
 */
export const resolveUplinkHealthTarget = (
	resolve: ConnectivityTargetResolver = resolveTargetShared,
	mocked: () => boolean = isDevelopment,
	family?: 4 | 6,
): Promise<string | undefined> =>
	mocked() ? Promise.resolve(undefined) : resolve(family);

const defaultDeps: UplinkHealthRuntimeDeps = {
	now: Date.now,
	interfaces: getNetworkInterfaces,
	onInterfacesChange: onNetworkInterfacesChange,
	streaming: getIsStreaming,
	telemetry: buildLinkTelemetry,
	quietForMs: linkQuietForMs,
	// Each source family is checked against an address of its own family: an
	// IPv6-only modem probed at an IPv4 address fails however healthy it is.
	resolveTarget: (family) =>
		resolveUplinkHealthTarget(undefined, undefined, family),
	alternateTarget: (family, failed) => sharedTarget?.alternate(family, failed),
	targetFailed: (family, target) => sharedTarget?.failed(family, target),
	logDiagnostic: ({ iface, outcome, quietMs }) =>
		logger.info("uplink check while streaming", { iface, outcome, quietMs }),
	probe: async (iface, remoteAddr) => {
		const result = await portalHealthProbe(iface, () =>
			probeConnectivityViaDevice(remoteAddr, iface),
		);
		switch (result) {
			case "reachable":
				return "success";
			case "captive_portal":
				return "captive_portal";
			case "unreachable":
				return "failure";
		}
	},
	publish: (records) => {
		broadcastMsg(UPLINKS_EVENT, records);
		broadcastMsg("status", { phone_links: getPhoneLinkCounts() });
	},
};

/** Production adapter retains the shared engine, identity and publication ports. */
export class UplinkHealthRuntime extends UplinkHealthRuntimeCore {
	constructor(deps: UplinkHealthRuntimeDeps = defaultDeps) {
		let publishedStates = new Map<string, UplinkHealthState>();
		super(
			{
				...deps,
				probe: (candidate, target) => deps.probe(candidate.name, target),
				exclusionReason: deviceBoundProbeExclusionReason,
				candidates: eligibleProbeCandidates,
				identity: resolveUplinkIdentity,
				// The core notifies only when the published records changed.
				notify: (records) => {
					for (const record of records) {
						const previous = publishedStates.get(record.iface);
						if (previous === undefined || previous === record.state) continue;
						const code = {
							up: "link_up",
							degraded: "link_degraded",
							down: "link_down",
						} as const;
						const { iface, kind, displayName, reason } = record;
						emitEvent(code[record.state], { iface, kind, displayName, reason });
					}
					publishedStates = new Map(
						records.map(({ iface, state }) => [iface, state]),
					);
					notifyUplinkHealthChange(records);
				},
			},
			getUplinkHealthEngine(),
		);
	}
}

let runtime = new UplinkHealthRuntime();
let interval: ReturnType<typeof setInterval> | undefined;

export function initUplinkHealth(): void {
	if (interval !== undefined) return;
	void runtime.tick().catch((error: unknown) => {
		logger.warn("uplink-health tick failed", { err: error });
	});
	interval = setInterval(() => {
		void runtime.tick().catch((error: unknown) => {
			logger.warn("uplink-health tick failed", { err: error });
		});
	}, UPLINK_HEALTH_CONFIG.probeRoundCadenceMs);
}

export function setUplinkHealthRuntimeForTest(
	next: UplinkHealthRuntime | null,
): void {
	runtime.dispose();
	runtime = next ?? new UplinkHealthRuntime();
}
