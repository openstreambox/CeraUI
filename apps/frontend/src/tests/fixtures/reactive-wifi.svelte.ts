/**
 * A reactive `wifi` status feed for views that derive from `getWifi()`, so a
 * test can replace the roster (restart, replug) and watch the view follow.
 */
import type { WifiStatus } from "@ceraui/rpc/schemas";

let wifi = $state.raw<WifiStatus | undefined>(undefined);

export const reactiveWifi = {
	get value(): WifiStatus | undefined {
		return wifi;
	},
	set value(next: WifiStatus | undefined) {
		wifi = next;
	},
	reset(): void {
		wifi = undefined;
	},
};
