import { describe, expect, test } from "bun:test";

import type { UplinkRoutePlan } from "../modules/network/uplink-steering/applier.ts";
import { FWMARK_RULE_PRIORITY } from "../modules/network/uplink-steering/contracts.ts";
import {
	ensureUplinkRoute,
	hasFwmarkRule,
	planUplinkRoute,
	removeUplinkRoute,
	type UplinkRouteManagerDeps,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { hexMark, scripted } from "./uplink-steering-route-test-fixtures.ts";

describe("uplink steering route teardown", () => {
	test("retains wlan1 ownership on re-plan so teardown removes all installed support", async () => {
		const candidate = {
			identity: "wifi-a",
			ifname: "wlan1",
			sourceAddress: "192.168.1.50",
			sourceAddressUnique: true,
			mark: 0xca000100,
		};
		const answers: Record<string, string> = {
			"ip rule show": "0: from all lookup local\n32766: from all lookup main\n",
			"ip -4 route show default dev wlan1":
				"default via 192.168.1.1 proto dhcp src 192.168.1.50 metric 600",
		};
		const h = scripted(answers);
		const plan = await planUplinkRoute(candidate, h);

		await ensureUplinkRoute(plan, h);

		expect(h.calls.slice(2)).toEqual([
			["ip", "rule", "show"],
			["ip", "route", "show", "table", "30001"],
			[
				"ip",
				"route",
				"replace",
				"table",
				"30001",
				"default",
				"via",
				"192.168.1.1",
				"proto",
				"dhcp",
				"src",
				"192.168.1.50",
				"metric",
				"600",
				"dev",
				"wlan1",
			],
			[
				"ip",
				"rule",
				"add",
				"priority",
				"100",
				"from",
				"192.168.1.50/32",
				"lookup",
				"30001",
			],
			[
				"ip",
				"rule",
				"add",
				"priority",
				"110",
				"fwmark",
				"0xca000100/0xffffff00",
				"lookup",
				"30001",
			],
		]);
		answers["ip rule show"] =
			"0: from all lookup local\n100: from 192.168.1.50 lookup 30001\n110: from all fwmark 0xca000100/0xffffff00 lookup 30001\n32766: from all lookup main\n";
		answers["ip route show table 30001"] =
			"default via 192.168.1.1 dev wlan1 proto dhcp src 192.168.1.50 metric 600";
		h.calls.length = 0;

		const replanned = await planUplinkRoute(candidate, h);
		expect(replanned).toMatchObject({
			table: "30001",
			managed: true,
			sourceRulePriority: 100,
		});
		await removeUplinkRoute(replanned, h);

		expect(h.calls).toEqual([
			["ip", "rule", "show"],
			["ip", "route", "show", "table", "30001"],
			["ip", "rule", "show"],
			[
				"ip",
				"rule",
				"del",
				"priority",
				"110",
				"fwmark",
				"0xca000100/0xffffff00",
				"lookup",
				"30001",
			],
			[
				"ip",
				"rule",
				"del",
				"priority",
				"100",
				"from",
				"192.168.1.50/32",
				"lookup",
				"30001",
			],
			["ip", "route", "flush", "table", "30001"],
		]);
	});

	test("rolls back partial managed provisioning when fwmark installation fails", async () => {
		const mark = stableUplinkMark("managed-failure");
		const plan: UplinkRoutePlan = {
			identity: "managed-failure",
			ifname: "wwan0",
			sourceAddress: "100.64.1.2",
			mark,
			table: "30124",
			managed: true,
			sourceRulePriority: 100,
			defaultRouteArgv: [
				"route",
				"replace",
				"table",
				"30124",
				"default",
				"via",
				"100.64.1.1",
				"dev",
				"wwan0",
			],
		};
		const calls: string[][] = [];
		const h: UplinkRouteManagerDeps = {
			run: async (command, args) => {
				calls.push([command, ...args]);
				if (
					args[0] === "rule" &&
					args[1] === "add" &&
					args.includes("fwmark")
				) {
					throw new Error("fwmark refused");
				}
				return args[0] === "rule" && args[1] === "show"
					? "0: from all lookup local\n32766: from all lookup main\n"
					: "";
			},
		};

		await expect(ensureUplinkRoute(plan, h)).rejects.toMatchObject({
			reason: "policy_route_missing",
		});
		expect(calls).toContainEqual([
			"ip",
			"rule",
			"del",
			"priority",
			"100",
			"from",
			"100.64.1.2/32",
			"lookup",
			"30124",
		]);
		expect(calls[calls.length - 1]).toEqual([
			"ip",
			"route",
			"flush",
			"table",
			"30124",
		]);
	});

	test("recognizes and removes only the exact mark/table rule", async () => {
		const mark = stableUplinkMark("cellular-a");
		const plan: UplinkRoutePlan = {
			identity: "cellular-a",
			ifname: "wwan0",
			sourceAddress: "100.64.1.2",
			mark,
			table: "120",
			managed: false,
		};
		const output = `${FWMARK_RULE_PRIORITY}: from all fwmark ${hexMark(mark)}/0xffffff00 lookup 120\n`;
		expect(hasFwmarkRule(output, plan)).toBe(true);
		const h = scripted({ "ip rule show": output });

		await removeUplinkRoute(plan, h);
		expect(h.calls).toEqual([
			["ip", "rule", "show"],
			[
				"ip",
				"rule",
				"del",
				"priority",
				String(FWMARK_RULE_PRIORITY),
				"fwmark",
				`${hexMark(mark)}/0xffffff00`,
				"lookup",
				"120",
			],
		]);
	});

	test("tears down a managed source rule, fwmark rule, and private table", async () => {
		const mark = stableUplinkMark("managed-wwan");
		const plan: UplinkRoutePlan = {
			identity: "managed-wwan",
			ifname: "wwan0",
			sourceAddress: "100.64.1.2",
			mark,
			table: "30123",
			managed: true,
			sourceRulePriority: 100,
		};
		const output = `100: from 100.64.1.2 lookup 30123
${FWMARK_RULE_PRIORITY}: from all fwmark ${hexMark(mark)}/0xffffff00 lookup 30123
`;
		const h = scripted({ "ip rule show": output });

		await removeUplinkRoute(plan, h);

		expect(h.calls).toEqual([
			["ip", "rule", "show"],
			[
				"ip",
				"rule",
				"del",
				"priority",
				String(FWMARK_RULE_PRIORITY),
				"fwmark",
				`${hexMark(mark)}/0xffffff00`,
				"lookup",
				"30123",
			],
			[
				"ip",
				"rule",
				"del",
				"priority",
				"100",
				"from",
				"100.64.1.2/32",
				"lookup",
				"30123",
			],
			["ip", "route", "flush", "table", "30123"],
		]);
	});
});

test("replanning a missing managed default retains source ownership through Stop/Delete", async () => {
	const candidate = {
		identity: "wired",
		ifname: "eth0",
		sourceAddress: "192.0.2.2",
		sourceAddressUnique: true,
		mark: 0xca000100,
	};
	const h = scripted({
		"ip rule show":
			"100: from 192.0.2.2 lookup 30001\n110: from all fwmark 0xca000100/0xffffff00 lookup 30001\n",
		"ip route show table 30001": "",
		"ip -4 route show default dev eth0": "default via 192.0.2.1 dev eth0",
	});
	const plan = await planUplinkRoute(candidate, h);
	expect(plan.sourceRulePriority).toBe(100);
	await removeUplinkRoute(plan, h);
	expect(h.calls).toContainEqual([
		"ip",
		"rule",
		"del",
		"priority",
		"100",
		"from",
		"192.0.2.2/32",
		"lookup",
		"30001",
	]);
});

test.each([
	"100: from 192.0.2.2 lookup 300010",
	"100: from 192.0.2.2 to 198.51.100.1 lookup 30001",
	"100: from 192.0.2.2 lookup 30001 suppress_prefixlength 0",
])("never deletes foreign source selectors: %s", async (output) => {
	const plan: UplinkRoutePlan = {
		identity: "wired",
		ifname: "eth0",
		sourceAddress: "192.0.2.2",
		mark: 0xca000100,
		table: "30001",
		managed: true,
		sourceRulePriority: 100,
	};
	const h = scripted({ "ip rule show": output });
	await removeUplinkRoute(plan, h);
	expect(h.calls.filter((call) => call.includes("del"))).toEqual([]);
});
