import { uplinkSteeringStatusSchema } from "@ceraui/rpc/schemas";

import { broadcastMsg } from "../../ui/websocket-server.ts";
import type {
	ShareRulesetState,
	SteeringAvailability,
	UplinkSteeringStatus,
} from "./contracts.ts";

export const UPLINK_STEERING_EVENT = "uplink-steering" as const;
export const UPLINK_FLOWS_RESET_EVENT = "uplink-flows-reset" as const;

let status: UplinkSteeringStatus = { state: "available" };
let statusKey = JSON.stringify(status);

export function getUplinkSteeringStatus(): UplinkSteeringStatus {
	return status;
}

/**
 * `applied` is the state the coordinator just committed; its selectable
 * uplinks are what new client flows can actually use, so the status reports
 * the ruleset rather than a policy preference.
 */
export function publishUplinkSteeringAvailability(
	availability: SteeringAvailability,
	applied?: Pick<ShareRulesetState, "uplinks">,
): void {
	const next: UplinkSteeringStatus = availability.available
		? {
				state: "available",
				...(applied === undefined
					? {}
					: {
							clientUplinks: applied.uplinks
								.filter((uplink) => uplink.selectable && uplink.weight > 0)
								.map((uplink) => uplink.ifname)
								.sort(),
						}),
			}
		: {
				state: "steering_unavailable",
				reason: availability.reason,
				...(availability.detail === undefined
					? {}
					: { detail: availability.detail }),
			};
	const nextKey = JSON.stringify(next);
	if (nextKey === statusKey) return;
	status = uplinkSteeringStatusSchema.parse(next);
	statusKey = JSON.stringify(status);
	broadcastMsg(UPLINK_STEERING_EVENT, status);
}

export function resetUplinkSteeringStatusForTest(): void {
	status = { state: "available" };
	statusKey = JSON.stringify(status);
}
