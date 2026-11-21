import { expect, test } from "bun:test";
import {
	type BearerIpFamily,
	bearerIpFamilyFields,
	resolveBearerIpFamily,
} from "./bearer-ip-family.ts";
import { planSubscriptionProfile } from "./subscription-profile.ts";

const identity = { deviceId: "synthetic-device", simId: "synthetic-sim" };
const automatic = { ...identity, uuid: "profile-a", automatic: true };

test("an IPv6-only carrier's profile asks for dual stack, IPv6 source-only", () => {
	for (const profile of [undefined, automatic]) {
		expect(
			planSubscriptionProfile(identity, { homePlmn: "310260" }, profile),
		).toEqual({
			action: profile ? "reconcile" : "create",
			policy: "t-mobile",
			fields: {
				"gsm.device-id": identity.deviceId,
				"gsm.sim-id": identity.simId,
				"gsm.apn": "fast.t-mobile.com",
				"gsm.auto-config": "no",
				"ipv4.method": "auto",
				"ipv6.method": "auto",
				"ipv6.never-default": "yes",
				"ipv6.ip6-privacy": "0",
			},
		});
	}
});
test("a dual-stack carrier keeps the IPv4 request the box makes today", () => {
	expect(
		planSubscriptionProfile(identity, { homePlmn: "310410" }, undefined),
	).toMatchObject({
		policy: "att",
		fields: {
			"gsm.apn": "broadband",
			"ipv4.method": "auto",
			"ipv6.method": "ignore",
		},
	});
	// The network's own IPv6-only attach still moves the request to dual stack.
	expect(
		planSubscriptionProfile(
			identity,
			{ homePlmn: "310410", attachIpType: "ipv6" },
			undefined,
		),
	).toMatchObject({ fields: { "ipv6.method": "auto" } });
});
test("planned family fields never drift from the live family convergence", () => {
	const cases = [
		{ homePlmn: "310260" },
		{ homePlmn: "310410" },
		{ homePlmn: "310410", attachIpType: "ipv6" },
		{ homePlmn: "310280", gid1: "20FF" },
		{ servingPlmn: "310240", registration: "home" },
	];
	for (const subscription of cases) {
		const plan = planSubscriptionProfile(identity, subscription, undefined);
		if (plan.action === "preserve") throw new Error("expected a plan");
		const family: BearerIpFamily = resolveBearerIpFamily({
			simOperatorCode: subscription.homePlmn,
			networkOperatorCode: subscription.servingPlmn,
			attachIpType: subscription.attachIpType,
		}).family;
		const {
			"gsm.device-id": _d,
			"gsm.sim-id": _s,
			"gsm.apn": _a,
			"gsm.auto-config": _c,
			...ip
		} = plan.fields;
		expect(ip).toEqual({ ...bearerIpFamilyFields(family) });
	}
});
test("a roaming SIM without a readable home PLMN keeps its profile", () => {
	expect(
		planSubscriptionProfile(
			identity,
			{ servingPlmn: "310260", registration: "roaming" },
			automatic,
		),
	).toEqual({ action: "preserve", reason: "unknown" });
	expect(
		planSubscriptionProfile(
			identity,
			{ servingPlmn: "310260", registration: "roaming" },
			undefined,
		),
	).toEqual({ action: "preserve", reason: "unknown" });
});
test("unknown, unqualified and manual policies preserve the existing profile", () => {
	expect(planSubscriptionProfile(identity, {}, automatic)).toEqual({
		action: "preserve",
		reason: "unknown",
	});
	expect(
		planSubscriptionProfile(identity, { homePlmn: "311480" }, automatic),
	).toEqual({ action: "preserve", reason: "not-qualified" });
	expect(
		planSubscriptionProfile(
			identity,
			{ homePlmn: "310260" },
			{ ...automatic, automatic: false },
		),
	).toEqual({ action: "preserve", reason: "manual" });
});
test("operator matching alone cannot reuse another device or SIM profile", () => {
	for (const profile of [
		{ ...automatic, deviceId: "other-device" },
		{ ...automatic, simId: "other-sim" },
	]) {
		expect(
			planSubscriptionProfile(identity, { homePlmn: "310260" }, profile),
		).toEqual({ action: "preserve", reason: "identity-mismatch" });
	}
	expect(
		planSubscriptionProfile({ ...identity, simId: "" }, {}, undefined),
	).toEqual({ action: "preserve", reason: "identity-unresolved" });
});
