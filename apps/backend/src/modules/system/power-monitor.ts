import { getms } from "../../helpers/time.ts";
import { shouldUseMocks } from "../../mocks/index.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import {
	createPowerReconciler,
	readPowerState,
	unavailablePower,
} from "./power-state.ts";

let current = unavailablePower(false);
let sampledAt = 0;
export function getPowerSensors(): Record<string, string> {
	if (!current.summary) return {};
	return {
		Power: current.summary,
		"Power sample": String(sampledAt),
		...current.sensors,
	};
}
const reconcile = createPowerReconciler(
	(n) =>
		notificationBroadcast(
			`power-${n.id}`,
			n.type,
			n.message,
			0,
			true,
			true,
			true,
			"notifications.power.status",
			{ text: n.message },
		),
	(id) => notificationRemove(`power-${id}`),
);
let started = false;
export function initPowerMonitoring(publish: () => void) {
	if (started || shouldUseMocks()) return;
	started = true;
	const sample = async () => {
		current = await readPowerState();
		sampledAt = getms();
		try {
			reconcile(current);
			publish();
		} catch {
			// A UI or transport failure must not stop freshness sampling.
		}
		setTimeout(() => {
			void sample();
		}, 1000).unref();
	};
	void sample();
}
