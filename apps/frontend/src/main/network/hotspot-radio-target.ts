import type { WifiInterface } from "@ceraui/rpc/schemas";

import { hotspotIsActive } from "$lib/rpc/os-toggle-predicates";

export function chooseHotspotRadio(
	radios: [string, WifiInterface][],
	selected?: string,
): [string, WifiInterface] | undefined {
	const capable = radios.filter(
		([, radio]) =>
			(radio.supports_hotspot || radio.hotspot) && !radio.degraded_reason,
	);
	if (selected !== undefined) {
		return capable.find(([id]) => id === selected);
	}
	// A live AP first (only a live AP carries a `hotspot` block).
	return (
		capable.find(([, radio]) => hotspotIsActive(radio)) ??
		capable.find(([, radio]) => !radio.conn) ??
		capable[0]
	);
}
