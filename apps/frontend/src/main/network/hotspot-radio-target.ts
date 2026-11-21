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
		return capable.find(
			([id, radio]) => (radio.radio_identity?.id ?? id) === selected,
		);
	}
	// A live AP first, then a saved setup: every hosting-capable radio of a
	// current device carries its saved `hotspot` block, on or off.
	return (
		capable.find(([, radio]) => hotspotIsActive(radio)) ??
		capable.find(([, radio]) => Boolean(radio.hotspot)) ??
		capable.find(([, radio]) => !radio.conn) ??
		capable[0]
	);
}
