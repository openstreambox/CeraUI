import { expect, test } from "bun:test";
import {
	initialPathHealth,
	observeAvailability,
	observePathProbe,
} from "./path-health-policy.ts";
import { requiresClat, selectSubscription } from "./subscription-policy.ts";
import { planSubscriptionProfile } from "./subscription-profile.ts";
import {
	decideInitialEps,
	parseInternalIpv4Grant,
	resolveTransportQuirk,
} from "./transport-policy.ts";

// Synthetic scenarios. These exercise policy, not hardware or a production owner.
const qmi = {
	model: "RM520N-GL",
	firmware: "RM520NGLAAR01A08M4G",
	mode: "qmi",
} as const;
const mbim = {
	model: "DW5821e Snapdragon X20 LTE",
	firmware: "T77W968.F1.0.0.4.2.GC.010\n026",
	mode: "mbim",
} as const;
const subscriptions = {
	tmo: { homePlmn: "310260", gid1: "6910" },
	att: { homePlmn: "310410", gid1: "20FF" },
};

test("SIM movement invalidates the old profile and cannot inherit CLAT readiness", () => {
	for (const [first, second] of [
		[subscriptions.tmo, subscriptions.att],
		[subscriptions.att, subscriptions.tmo],
	]) {
		if (!first || !second) throw new Error("Invalid scenario");
		const identity = { deviceId: "device-a", simId: "sim-a" };
		const oldProfile = { ...identity, uuid: "old-profile", automatic: true };
		const oldPlan = planSubscriptionProfile(identity, first, oldProfile);
		expect(oldPlan.action).toBe("reconcile");
		let health = observeAvailability(
			initialPathHealth(1000),
			"usb-a/sim-a/bearer-a",
			0,
		).state;
		health = observePathProbe(health, "usb-a/sim-a/bearer-a", 0, true).state;
		expect(health.ready).toBe(true);
		const moved = { ...identity, simId: "sim-b" };
		expect(planSubscriptionProfile(moved, second, oldProfile)).toEqual({
			action: "preserve",
			reason: "identity-mismatch",
		});
		const newPlan = planSubscriptionProfile(moved, second, undefined);
		expect(newPlan.action).toBe("create");
		health = observeAvailability(health, "usb-a/sim-b/bearer-b", 1000).state;
		expect(health.ready).toBe(false);
		expect(
			observePathProbe(health, "usb-a/sim-a/bearer-a", 20_000, true).state
				.ready,
		).toBe(false);
		const selected = selectSubscription(second);
		if (selected.state !== "recognized")
			throw new Error("Expected recognized subscription");
		expect(newPlan).toMatchObject({
			fields: { "gsm.apn": selected.policy.apn },
		});
	}
});

test("foreign attach, successful one-shot verification, native and translated grant policies", () => {
	for (const transport of [qmi, mbim]) {
		expect(resolveTransportQuirk(transport)?.owner).toBe("network-manager");
		for (const subscription of [subscriptions.tmo, subscriptions.att]) {
			const policy = selectSubscription(subscription);
			if (policy.state !== "recognized")
				throw new Error("Expected recognized subscription");
			const desired = {
				apn: policy.policy.apn,
				family: policy.policy.requestFamily,
			};
			const foreign = { apn: "foreign.example", family: "ipv4" } as const;
			expect(decideInitialEps(foreign, desired, false, true)).toBe(
				"baseline-and-attempt",
			);
			expect(decideInitialEps(foreign, desired, true, true)).toBe("blocked");
			expect(decideInitialEps(desired, desired, true, true)).toBe("aligned");
			// A dual-stack request can produce either observed grant.
			expect(requiresClat("ipv6")).toBe(true);
			expect(requiresClat("ipv4")).toBe(false);
		}
	}
});

test("one healthy path cannot heal another path's stale plane or USB outage", () => {
	let a = observeAvailability(initialPathHealth(1000), "a", 0).state;
	const b = observeAvailability(initialPathHealth(1000), "b", 0).state;
	a = observePathProbe(a, "a", 0, true).state;
	const failed = observePathProbe(b, "b", 0, false);
	expect(a.ready).toBe(true);
	expect(failed.state.ready).toBe(false);
	expect(observePathProbe(failed.state, "b", 30_000, false).reconnect).toBe(
		true,
	);
	const absent = observeAvailability(a, undefined, 1000).state;
	expect(observePathProbe(absent, "a", 2000, true).state.ready).toBe(false);
	const returned = observeAvailability(absent, "a-new", 51_000);
	expect(returned).toMatchObject({
		availability: "settling",
		state: { ready: false, reconnects: 0 },
	});
});

test("RNDIS IPv6-only reply is never published as a native IPv4 grant", () => {
	expect(
		parseInternalIpv4Grant(
			'+CGPADDR: 1,"32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1","0.0.0.0"',
			1,
		),
	).toBeUndefined();
	expect(
		resolveTransportQuirk({
			model: "FM350-GL",
			firmware: "unknown",
			mode: "rndis",
		}),
	).toBeUndefined();
	expect(selectSubscription({ homePlmn: "311480" }).state).toBe(
		"not-qualified",
	);
});
