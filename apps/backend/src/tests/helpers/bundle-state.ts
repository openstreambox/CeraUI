import type { BundleDeviceState } from "../../modules/device-logs/bundle-state.ts";

/** A quiet device state for bundle tests that do not exercise the state record. */
export function bundleStateFixture(): BundleDeviceState {
	return {
		uptimeSeconds: 60,
		memory: null,
		boots: [],
		slots: null,
		bootAttempts: null,
		packages: [],
		modems: [],
		interfaces: [],
		stream: { lifecycle: "idle", bitrateKbps: null, ceilingKbps: null },
	};
}
