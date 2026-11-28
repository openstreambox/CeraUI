import {
	buildShareRuleset,
	stableUplinkMark,
} from '../../apps/backend/src/modules/network/uplink-steering/ruleset.ts';

process.stdout.write(
	buildShareRuleset({
		clientZones: [{ ifname: 'ap0', ipv4Cidr: '10.42.0.0/24' }],
		uplinks: ['wan0', 'wan2'].map((ifname) => ({
			identity: ifname,
			ifname,
			mark: stableUplinkMark(ifname),
			selectable: true,
			weight: 50,
		})),
	}),
);
