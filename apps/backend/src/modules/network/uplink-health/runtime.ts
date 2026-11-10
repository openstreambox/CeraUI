import { logger } from "../../../helpers/logger.ts";
import { buildLinkTelemetry } from "../../streaming/link-telemetry.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import {
	deviceBoundProbeExclusionReason,
	eligibleProbeCandidates,
} from "../connectivity-candidates.ts";
import { probeConnectivityViaDevice } from "../device-bound-probe.ts";
import { getNetworkInterfaces } from "../network-interfaces.ts";
import { resolveUplinkIdentity } from "../uplink-identity.ts";
import {
	type ConnectivityTargetResolver,
	createConnectivityTargetResolver,
} from "./connectivity-target.ts";
import { UPLINK_HEALTH_CONFIG } from "./model.ts";
import {
	UplinkHealthRuntimeCore,
	type UplinkHealthRuntimeCoreDeps,
} from "./runtime-core.ts";
import { getUplinkHealthEngine, notifyUplinkHealthChange } from "./state.ts";

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
let sharedTarget: ConnectivityTargetResolver | undefined;
const resolveTargetShared: ConnectivityTargetResolver = () => {
	sharedTarget ??= createConnectivityTargetResolver();
	return sharedTarget();
};

const defaultDeps: UplinkHealthRuntimeDeps = {
	now: Date.now,
	interfaces: getNetworkInterfaces,
	streaming: getIsStreaming,
	telemetry: buildLinkTelemetry,
	resolveTarget: resolveTargetShared,
	probe: async (iface, remoteAddr) => {
		const result = await probeConnectivityViaDevice(remoteAddr, iface);
		switch (result) {
			case "reachable":
				return "success";
			case "captive_portal":
				return "captive_portal";
			case "unreachable":
				return "failure";
		}
	},
	publish: (records) => broadcastMsg(UPLINKS_EVENT, records),
};

/** Production adapter retains the shared engine, identity and publication ports. */
export class UplinkHealthRuntime extends UplinkHealthRuntimeCore {
	constructor(deps: UplinkHealthRuntimeDeps = defaultDeps) {
		super(
			{
				...deps,
				probe: (candidate, target) => deps.probe(candidate.name, target),
				exclusionReason: deviceBoundProbeExclusionReason,
				candidates: eligibleProbeCandidates,
				identity: resolveUplinkIdentity,
				notify: notifyUplinkHealthChange,
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
	runtime = next ?? new UplinkHealthRuntime();
}
