import {
	buildShareRuleset,
	stableUplinkMark,
} from "../../../modules/network/uplink-steering/ruleset.ts";

process.stdout.write(
	buildShareRuleset({
		clientZones: [{ ifname: "lan0", ipv4Cidr: "10.42.0.0/24" }],
		uplinks: [
			{
				identity: "synthetic-modem",
				ifname: process.env.SHARE_UPLINK ?? "wan0",
				mark: stableUplinkMark("synthetic-modem"),
				selectable: true,
				weight: 100,
			},
		],
	}),
);
