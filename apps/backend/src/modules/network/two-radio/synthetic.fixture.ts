import { liveConfigSchema, type RadioState } from "./native-owner.ts";
import type { Radio } from "./reducer.ts";
export const config = liveConfigSchema.parse({
	target: "203.0.113.7",
	port: 47831,
	mark: 48000,
	table: 48000,
	priority: 18000,
	radios: {
		a: {
			permanentMac: "02:00:00:00:00:01",
			phy: "phy-a",
			usbPath: "/synthetic/a",
			table: 48001,
			priority: 18001,
		},
		b: {
			permanentMac: "02:00:00:00:00:02",
			phy: "phy-b",
			usbPath: "/synthetic/b",
			table: 48002,
			priority: 18002,
		},
	},
});
export const state = (r: Radio): RadioState => ({
	ifname: `radio${r}`,
	subnet: `198.18.${r === "a" ? 1 : 2}.0/24`,
	gateway: `198.18.${r === "a" ? 1 : 2}.1`,
	identity: {
		physical: JSON.stringify(config.radios[r]),
		permanentMac: config.radios[r].permanentMac,
		epoch: {
			activation: `active-${r}`,
			bssid: `synthetic-${r}`,
			lease: r,
			routeGeneration: 1,
		},
	},
});
