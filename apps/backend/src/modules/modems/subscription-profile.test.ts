import { expect, test } from "bun:test";
import { planSubscriptionProfile } from "./subscription-profile.ts";

const identity = { deviceId: "synthetic-device", simId: "synthetic-sim" };
const automatic = { ...identity, uuid: "profile-a", automatic: true };

test("existing and new profiles request dual stack by subscription, source-only IPv6", () => {
	for (const profile of [undefined, automatic]) {
		expect(
			planSubscriptionProfile(identity, { homePlmn: "310260" }, profile),
		).toMatchObject({
			action: profile ? "reconcile" : "create",
			fields: {
				"gsm.device-id": identity.deviceId,
				"gsm.sim-id": identity.simId,
				"gsm.apn": "fast.t-mobile.com",
				"ipv4.method": "auto",
				"ipv6.method": "auto",
				"ipv6.never-default": "yes",
				"ipv6.ignore-auto-dns": "yes",
			},
		});
	}
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
