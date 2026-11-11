import { expect, test } from "bun:test";
import {
	ensureUplinkRoute,
	planUplinkRoute,
	type UplinkRouteManagerDeps,
} from "../modules/network/uplink-steering/route-manager.ts";
import { scripted } from "./uplink-steering-route-test-fixtures.ts";

test.each(["eth0", "wlan1", "wwan0"])(
	"allocates an absent %s FIB before installing policy rules",
	async (ifname) => {
		const h = scripted({
			"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
			[`ip -4 route show default dev ${ifname}`]: `default via 192.0.2.1 dev ${ifname}`,
		});
		const plan = await planUplinkRoute(
			{
				identity: ifname,
				ifname,
				sourceAddress: "192.0.2.2",
				sourceAddressUnique: true,
				mark: 0xca000100,
			},
			h,
		);
		const deps: UplinkRouteManagerDeps = {
			run: async (cmd, args) => {
				if (args.join(" ") === `route show table ${plan.table}`) {
					throw Object.assign(new Error("missing FIB"), {
						code: 2,
						stderr: "Error: ipv4: FIB table does not exist.\nDump terminated\n",
					});
				}
				return h.run(cmd, args);
			},
		};
		const provisioned = await ensureUplinkRoute(plan, deps);
		expect(provisioned.createdTableRoute).toBe(true);
		expect(provisioned.createdFwmarkRule).toBe(true);
		const create = h.calls.findIndex((call) => call.includes("replace"));
		const rule = h.calls.findIndex((call) => call.includes("add"));
		expect(create).toBeGreaterThan(-1);
		expect(rule).toBeGreaterThan(create);
	},
);

test.each([
	{ code: 2, stderr: "RTNETLINK answers: Operation not permitted" },
	{
		code: 1,
		stderr: "Error: ipv4: FIB table does not exist.\nDump terminated",
	},
])("preserves refusal for other kernel failures: %j", async (failure) => {
	const h = scripted({
		"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
		"ip -4 route show default dev eth0": "default via 192.0.2.1 dev eth0",
	});
	const plan = await planUplinkRoute(
		{
			identity: "eth0",
			ifname: "eth0",
			sourceAddress: "192.0.2.2",
			sourceAddressUnique: true,
			mark: 0xca000100,
		},
		h,
	);
	await expect(
		ensureUplinkRoute(plan, {
			run: async (cmd, args) => {
				if (args.includes("table"))
					throw Object.assign(new Error("kernel failure"), failure);
				return h.run(cmd, args);
			},
		}),
	).rejects.toMatchObject({ reason: "policy_route_missing" });
	expect(h.calls.some((call) => call.includes("replace"))).toBe(false);
});

test("retries an NM activation still waiting for its default route before publishing ready", async () => {
	const { UplinkSteeringCoordinator } = await import(
		"../modules/network/uplink-steering/coordinator.ts"
	);
	const { prepared, uplink } = await import(
		"./uplink-steering-test-fixtures.ts"
	);
	const statuses: boolean[] = [];
	let nmActivated = false;
	let installed = false;
	const h = scripted({
		"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
	});
	const deps: UplinkRouteManagerDeps = {
		run: async (cmd, args) => {
			if (args.join(" ") === "-4 route show default dev eth0")
				return nmActivated ? "default via 192.0.2.1 dev eth0" : "";
			if (args.join(" ") === "route show table 30001")
				throw Object.assign(new Error("absent"), {
					code: 2,
					stderr: "Error: ipv4: FIB table does not exist.\nDump terminated",
				});
			return h.run(cmd, args);
		},
	};
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: async () => {
			const state = prepared([uplink("wired", "eth0", 100)]);
			const route = await planUplinkRoute(
				{
					identity: "wired",
					ifname: "eth0",
					sourceAddress: "192.0.2.2",
					sourceAddressUnique: true,
					mark: 0xca000100,
				},
				deps,
			);
			return { ...state, routes: [route] };
		},
		apply: async (_previous, next) => {
			for (const route of next.routes) await ensureUplinkRoute(route, deps);
			installed = true;
		},
		waitBeforeRetry: async (delay) => {
			expect(delay).toBe(100);
			expect(installed).toBe(false);
			nmActivated = true;
		},
		publishAvailability: (status) => {
			if (status.available) expect(installed).toBe(true);
			statuses.push(status.available);
		},
	});
	await coordinator.requestReconcile();
	expect(statuses).toEqual([false, true]);
});
