import { expect, test } from "bun:test";
import {
	type CarrierIntent,
	effectiveCarrierAutomatic,
	newCarrierIntent,
} from "./automatic-carrier-intent.ts";
import {
	type CarrierProfileDeps,
	reconcileAutomaticCarrierProfile,
	restoreAutomaticCarrierProfile,
} from "./automatic-carrier-profile.ts";
import { selectSubscription } from "./subscription-policy.ts";

const identity = {
	uuid: "synthetic-profile",
	deviceId: "synthetic-device",
	simId: "89000000000000000000",
};
const choice = selectSubscription({ homePlmn: "310410", gid1: "20FF" });
if (choice.state !== "recognized") throw new Error("Invalid policy fixture");
const policy = choice.policy;
function fixture() {
	const original: Record<string, string> = {
		"gsm.apn": "old.invalid",
		"gsm.auto-config": "yes",
		"ipv4.method": "auto",
		"ipv6.method": "ignore",
		"ipv6.never-default": "no",
		"ipv6.ip6-privacy": "-1",
		"ipv6.ignore-auto-dns": "no",
	};
	let fields = { ...original };
	let intent: CarrierIntent | undefined;
	let pair = { ...identity };
	let present = true;
	let live = true;
	let partial = false;
	let refuseRestore = false;
	let writes = 0;
	let onArmed = () => {};
	let inverse: Readonly<Record<string, unknown>> = {};
	const calls: string[] = [];
	const deps: CarrierProfileDeps = {
		readFields: async (_uuid, names) =>
			names.map((name) =>
				name === "gsm.device-id"
					? pair.deviceId
					: name === "gsm.sim-id"
						? pair.simId
						: fields[name],
			),
		writeFields: async (_uuid, next) => {
			calls.push("nm-write");
			writes++;
			if (partial && writes === 1) {
				fields["gsm.apn"] = "partial.invalid";
				return false;
			}
			if (refuseRestore && writes > 1) return false;
			fields = { ...fields, ...next };
			return true;
		},
		pairPresent: async () => present,
		readIntent: async () => intent,
		writeIntent: async (_identity, next) => {
			calls.push(next ? `intent-${next.mode}-${next.phase}` : "intent-absent");
			intent = next;
		},
		journal: async (_key, _kind, before, work) => {
			inverse = before;
			calls.push("armed");
			onArmed();
			const result = await work({
				entry: {} as never,
				markExecuting: async () => {
					calls.push("executing");
				},
				markFailed: async () => {},
			});
			calls.push(result.confirmed ? "confirmed" : "blocked");
			return { ok: true, value: result.value };
		},
	};
	return {
		deps,
		original,
		calls,
		fields: () => fields,
		intent: () => intent,
		inverse: () => inverse,
		current: async () => live,
		setIntent: (v: CarrierIntent | undefined) => {
			intent = v;
		},
		setNmAutomatic: (v: boolean) => {
			fields["gsm.auto-config"] = v ? "yes" : "no";
		},
		setApn: (v: string) => {
			fields["gsm.apn"] = v;
		},
		setPair: (v: typeof identity) => {
			pair = v;
		},
		setPresent: (v: boolean) => {
			present = v;
		},
		setLive: (v: boolean) => {
			live = v;
		},
		setPartial: () => {
			partial = true;
		},
		setRefuseRestore: () => {
			refuseRestore = true;
		},
		onArmed: (f: () => void) => {
			onArmed = f;
		},
	};
}

test("subscription-derived APN is journaled and intent survives NM auto-config=no", async () => {
	const f = fixture();
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("updated");
	expect(f.calls).toEqual([
		"armed",
		"executing",
		"intent-automatic-pending",
		"nm-write",
		"intent-automatic-applied",
		"confirmed",
	]);
	expect(f.fields()).toMatchObject({
		"gsm.apn": "ereseller",
		"gsm.auto-config": "no",
		"ipv6.method": "auto",
		"ipv6.never-default": "yes",
		"ipv6.ignore-auto-dns": "yes",
	});
	expect(effectiveCarrierAutomatic(f.intent(), false, "ereseller")).toBe(true);
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("unchanged");
	expect(f.calls.filter((x) => x === "nm-write")).toHaveLength(1);
});

test("manual and out-of-band custom APN policies are preserved", async () => {
	const f = fixture();
	f.setNmAutomatic(false);
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("preserved");
	f.setIntent(newCarrierIntent(identity, "manual"));
	f.setNmAutomatic(true);
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("preserved");
	f.setIntent(newCarrierIntent(identity, "automatic", "ereseller"));
	f.setNmAutomatic(false);
	f.setApn("manual.invalid");
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("preserved");
	expect(f.calls).toEqual([]);
});

test("unqualified, stale subscription and moved SIM cannot dispatch", async () => {
	const f = fixture();
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			{ ...policy, qualified: false },
			f.current,
			f.deps,
		),
	).toBe("refused");
	f.setPair({ ...identity, simId: "other" });
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("refused");
	f.setPair(identity);
	f.onArmed(() => f.setLive(false));
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("refused");
	expect(f.calls).not.toContain("nm-write");
	expect(f.calls).not.toContain("intent-automatic-pending");
});

test("partial failure restores the profile and the absence of old provenance", async () => {
	const f = fixture();
	f.setPartial();
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("failed");
	expect(f.fields()).toEqual(f.original);
	expect(f.intent()).toBeUndefined();
	expect(f.calls.at(-1)).toBe("confirmed");
});

test("unverified inverse retains the durable block", async () => {
	const f = fixture();
	f.setPartial();
	f.setRefuseRestore();
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			policy,
			f.current,
			f.deps,
		),
	).toBe("failed");
	expect(f.calls.at(-1)).toBe("blocked");
});

test("restart inverse restores prior profile and provenance only for the original pair", async () => {
	const f = fixture();
	await reconcileAutomaticCarrierProfile(
		"key",
		identity,
		policy,
		f.current,
		f.deps,
	);
	f.setPair({ ...identity, simId: "other" });
	expect(await restoreAutomaticCarrierProfile("key", f.inverse(), f.deps)).toBe(
		"failed",
	);
	f.setPair(identity);
	expect(await restoreAutomaticCarrierProfile("key", f.inverse(), f.deps)).toBe(
		"restored",
	);
	expect(f.fields()).toEqual(f.original);
	expect(f.intent()).toBeUndefined();
	expect(await restoreAutomaticCarrierProfile("key", {}, f.deps)).toBe(
		"failed",
	);
});
