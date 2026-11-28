import { m } from "@ceraui/i18n/svelte";

export type DeviceCounts = {
	readonly devices: number;
	readonly hubs: number;
	readonly ports: number;
};

function words(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

/** Devices, hubs and ports, with the real singular and plural. */
export function deviceCountSentence(counts: DeviceCounts): string {
	if (counts.devices === 0 && counts.hubs === 0)
		return m["network.devices.summary.none"]();
	const devices = words(
		counts.devices,
		m["network.devices.summary.deviceOne"](),
		m["network.devices.summary.deviceMany"]({ count: counts.devices }),
	);
	const ports = words(
		counts.ports,
		m["network.devices.summary.onPortsOne"](),
		m["network.devices.summary.onPortsMany"]({ count: counts.ports }),
	);
	if (counts.hubs === 0) return `${devices} ${ports}`;
	const hubs = words(
		counts.hubs,
		m["network.devices.summary.hubOne"](),
		m["network.devices.summary.hubMany"]({ count: counts.hubs }),
	);
	return `${devices}${m["network.devices.summary.and"]()}${hubs} ${ports}`;
}
