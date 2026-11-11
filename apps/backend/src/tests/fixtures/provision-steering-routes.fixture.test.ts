import { expect, test } from "bun:test";
import {
	ensureUplinkRoute,
	planUplinkRoute,
} from "../../modules/network/uplink-steering/route-manager.ts";

test.skipIf(!process.env.CERALIVE_STEERING_FIXTURE_MARKS)(
	"provisions absent private FIBs",
	async () => {
		// Called inside the isolated packet fixture, before either private FIB exists.
		for (const [index, mark] of (
			process.env.CERALIVE_STEERING_FIXTURE_MARKS ?? ""
		)
			.split(",")
			.entries()) {
			const plan = await planUplinkRoute({
				identity: `fixture-wan-${index}`,
				ifname: `wan${index}`,
				sourceAddress: index === 0 ? "192.0.2.1" : "198.51.100.1",
				sourceAddressUnique: true,
				mark: Number(mark),
			});
			const provisioned = await ensureUplinkRoute(plan);
			expect(provisioned.createdTableRoute).toBe(true);
			expect(provisioned.createdFwmarkRule).toBe(true);
		}
	},
);
