import { uplinkFlowsResetEventSchema } from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
import { hasCapability } from "../../system/board-capabilities.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { broadcastWifiState } from "../../wifi/wifi.ts";
import {
	getNetworkInterfaceIncarnation,
	getNetworkInterfaces,
	onNetworkInterfacesChange,
} from "../network-interfaces.ts";
import { onUsbNetScanCommitted } from "../router-cellular-scan.ts";
import { onUplinkHealthChange } from "../uplink-health/state.ts";
import {
	applyNftablesRules,
	deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
} from "../uplink-sharing.ts";
import { commitSelectorPlan } from "./active-uplink.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "./applier.ts";
import { UplinkSteeringCoordinator } from "./coordinator.ts";
import {
	beginSteeringVerification,
	enableSteeringReadiness,
	publishSteeringReadiness,
	type SteeringVerificationEntry,
} from "./readiness.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
} from "./route-manager.ts";
import { readDesiredSteeringState } from "./state-builder.ts";
import {
	publishUplinkSteeringAvailability,
	UPLINK_FLOWS_RESET_EVENT,
} from "./status.ts";
import { verifySteeringState } from "./verify.ts";

const applier = new UplinkSteeringApplier({
	discoverRoutes: discoverOwnedUplinkRoutes,
	ensureRoute: ensureUplinkRoute,
	rollbackRoute: rollbackUplinkRoute,
	removeRoute: removeUplinkRoute,
	applyRuleset: (ruleset, mode) => applyNftablesRules(ruleset, undefined, mode),
	deactivateSharing: deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
	publishFlowsReset: (event) =>
		broadcastMsg(
			UPLINK_FLOWS_RESET_EVENT,
			uplinkFlowsResetEventSchema.parse(event),
		),
});

// Each plan carries the AP lifetimes it was built for, taken before any await.
const verificationEntries = new WeakMap<
	PreparedSteeringState,
	SteeringVerificationEntry
>();

const coordinator = new UplinkSteeringCoordinator({
	readDesiredState: async (context) => {
		// The builder collects client zones from this snapshot before it awaits.
		const entry = beginSteeringVerification(
			Object.keys(getNetworkInterfaces()),
			getNetworkInterfaceIncarnation,
		);
		const desired = await readDesiredSteeringState(undefined, context);
		if (!("pending" in desired)) verificationEntries.set(desired, entry);
		return desired;
	},
	apply: async (previous, next) => {
		publishSteeringReadiness([]);
		await applier.apply(previous, next);
		// Installed is live for clients even if the readback below fails.
		commitSelectorPlan(next);
	},
	verifyApplied: async (next) => {
		await verifySteeringState(next);
		// The selector's incumbent follows what is live, never a mere plan.
		commitSelectorPlan(next);
		publishSteeringReadiness(
			next.clientZones,
			verificationEntries.get(next),
			getNetworkInterfaceIncarnation,
		);
	},
	publishAvailability: (availability) => {
		if (!availability.available) publishSteeringReadiness([]);
		publishUplinkSteeringAvailability(
			availability,
			availability.available ? coordinator.appliedState() : undefined,
		);
		broadcastWifiState();
	},
	retryCleanup: () => applier.retryPendingCleanup(),
});

let unsubscribeNetif: (() => void) | undefined;
let unsubscribeHealth: (() => void) | undefined;
let unsubscribeScan: (() => void) | undefined;

export async function initUplinkSteering(): Promise<void> {
	if (
		unsubscribeNetif !== undefined ||
		!(await hasCapability("client-internet"))
	)
		return;
	enableSteeringReadiness();
	const reconcile = () => {
		void coordinator.requestReconcile().catch((error: unknown) => {
			logger.warn("uplink steering reconcile failed", { err: error });
		});
	};
	unsubscribeNetif = onNetworkInterfacesChange(reconcile);
	unsubscribeHealth = onUplinkHealthChange(reconcile);
	unsubscribeScan = onUsbNetScanCommitted(reconcile);
	await coordinator.requestReconcile();
}

export function requestUplinkSteeringReconcile(): Promise<void> {
	return coordinator.requestReconcile();
}

export function stopUplinkSteeringForTest(): void {
	unsubscribeNetif?.();
	unsubscribeHealth?.();
	unsubscribeScan?.();
	coordinator.stop();
	unsubscribeNetif = undefined;
	unsubscribeHealth = undefined;
	unsubscribeScan = undefined;
}
