import type { WifiInterface } from "@ceraui/rpc/schemas";

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
	return (
		capable.find(([, radio]) => Boolean(radio.hotspot)) ??
		capable.find(([, radio]) => !radio.conn) ??
		capable[0]
	);
}
