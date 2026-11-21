import { describe, expect, test } from "bun:test";
import {
	type SharingPolicy,
	sharingPolicySchema,
	uplinkSteeringStatusSchema,
} from "@ceraui/rpc/schemas";
import {
	NETIF_ERR_HOTSPOT,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import type { UplinkHealthRecord } from "../modules/network/uplink-health/model.ts";
import {
	ACTIVE_UPLINK_CONFIG,
	ActiveUplinkSelector,
	applyClientUplinkPolicy,
	commitSelectorPlan,
} from "../modules/network/uplink-steering/active-uplink.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import {
	applySharingPolicy,
	DEFAULT_SHARING_POLICY,
	SharingPolicyOwner,
} from "../modules/network/uplink-steering/policy.ts";
import {
	buildShareRuleset,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";
import {
	getUplinkSteeringStatus,
	publishUplinkSteeringAvailability,
	resetUplinkSteeringStatusForTest,
} from "../modules/network/uplink-steering/status.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

const HOLD = ACTIVE_UPLINK_CONFIG.rejoinHoldMs;

function uplink(ifname: string): { uplink: SteeringUplink } {
	return {
		uplink: {
			identity: `id-${ifname}`,
			ifname,
			mark: stableUplinkMark(`id-${ifname}`),
			selectable: true,
			weight: 100,
		},
	};
}

function record(
	iface: string,
	state: UplinkHealthRecord["state"] = "up",
	successes = 5,
	staleAt = Number.MAX_SAFE_INTEGER,
	activeAt?: number,
): UplinkHealthRecord {
	return {
		iface,
		kind: "ethernet",
		state,
		weight: state === "down" ? 0 : state === "degraded" ? 25 : 100,
		lastTransition: 0,
		staleAt,
		probes: { successes, failures: 0 },
		signals: activeAt === undefined ? {} : { activeAt },
	} as UplinkHealthRecord;
}

/** A healthy record confirmed by the general-internet probe every 5 s. */
function live(iface: string, now: number): UplinkHealthRecord {
	return record(iface, "up", 1 + Math.floor(now / 5_000), now + 15_000, now);
}

/** Healthy only from sender telemetry: no active probe observation. */
function telemetryOnly(iface: string, now: number): UplinkHealthRecord {
	return {
		...record(iface, "up", 1 + Math.floor(now / 5_000), now + 15_000),
		signals: { passiveAt: now },
	} as UplinkHealthRecord;
}

/**
 * Drives one selector the way successive applied reconciles would. Health
 * publishes every 5 s probe round and each publish reconciles, so a call
 * without explicit health also replays the rounds since the previous call.
 */
function driver(policy: SharingPolicy = DEFAULT_SHARING_POLICY) {
	const selector = new ActiveUplinkSelector();
	let last: number | undefined;
	let lastDefault = false;
	const plan = (
		now: number,
		ifnames: readonly string[],
		health: readonly UplinkHealthRecord[] = ifnames.map((i) => live(i, now)),
	) =>
		applyClientUplinkPolicy(ifnames.map(uplink), selector, {
			now,
			policy,
			health: new Map(health.map((r) => [r.iface, r])),
			interfaces: new Set([...ifnames, ...health.map((r) => r.iface)]),
		});
	const selected = (candidates: readonly { uplink: SteeringUplink }[]) =>
		candidates
			.filter(({ uplink: u }) => u.selectable && u.weight > 0)
			.map(({ uplink: u }) => u.ifname);
	return {
		selector,
		/** Plans without applying, as a retry, a failed apply or the shaper. */
		peek(...args: Parameters<typeof plan>): string[] {
			return selected(plan(...args).candidates);
		},
		pick(
			now: number,
			ifnames: readonly string[],
			health?: readonly UplinkHealthRecord[],
		): string[] {
			if (health === undefined && lastDefault && last !== undefined) {
				for (let round = last + 5_000; round < now; round += 5_000)
					selector.commit(plan(round, ifnames).next);
			}
			last = now;
			lastDefault = health === undefined;
			const result = plan(now, ifnames, health);
			selector.commit(result.next);
			return selected(result.candidates);
		},
	};
}

describe("single-active client uplink selection", () => {
	test("first pick prefers wired, then Wi-Fi, then cellular, and operator priority overrides", () => {
		expect(driver().pick(0, ["wwan0", "wlan0", "eth0"])).toEqual(["eth0"]);
		expect(driver().pick(0, ["wwan0", "wlan0"])).toEqual(["wlan0"]);
		expect(
			driver({
				...DEFAULT_SHARING_POLICY,
				priorities: { wired: 10, cellular: 0, wifi: 10 },
			}).pick(0, ["wwan0", "eth0"]),
		).toEqual(["wwan0"]);
	});

	test("exactly one uplink is selectable and the rest stay listed with weight 0", () => {
		const selector = new ActiveUplinkSelector();
		const context = {
			now: 0,
			policy: DEFAULT_SHARING_POLICY,
			health: new Map(),
			interfaces: new Set<string>(),
		};
		const out = applyClientUplinkPolicy(
			["eth0", "wwan0", "wwan1"].map(uplink),
			selector,
			context,
		).candidates.map(({ uplink: u }) => [u.ifname, u.selectable, u.weight]);
		expect(out).toEqual([
			["eth0", true, 100],
			["wwan0", false, 0],
			["wwan1", false, 0],
		]);
		const ruleset = buildShareRuleset({
			clientZones: [{ ifname: "ap0", ipv4Cidr: "10.42.0.0/24" }],
			uplinks: applyClientUplinkPolicy(
				["eth0", "wwan0"].map(uplink),
				selector,
				context,
			).candidates.map(({ uplink: u }) => u),
		});
		// One selection chain, but restore and NAT rules for both uplinks.
		expect(ruleset.match(/chain select_\d+/g)).toEqual(["chain select_0"]);
		expect(ruleset.match(/restore client flow/g)?.length).toBe(2);
		expect(ruleset.match(/client flow NAT/g)?.length).toBe(2);
	});

	test("hard-down or blackhole withdrawal fails over in the same reconcile", () => {
		const d = driver();
		expect(d.pick(0, ["eth0", "wwan0"])).toEqual(["eth0"]);
		// Health dropped eth0 (state-builder never offers a down uplink).
		expect(
			d.pick(
				1_000,
				["wwan0"],
				[record("eth0", "down", 0), live("wwan0", 1_000)],
			),
		).toEqual(["wwan0"]);
		expect(d.selector.rejoinHoldMs("id-eth0")).toBe(HOLD * 2);
		// No uplink left: nothing is selectable, the ruleset's drop chain applies.
		expect(d.pick(2_000, [], [record("wwan0", "down", 0)])).toEqual([]);
	});

	test("an unapplied plan neither moves the incumbent nor charges a failure", () => {
		const d = driver();
		expect(d.pick(0, ["eth0", "wwan0"])).toEqual(["eth0"]);
		// A failover plan whose apply is rejected, then eth0 comes back.
		expect(
			d.peek(
				1_000,
				["wwan0"],
				[record("eth0", "down", 0), live("wwan0", 1_000)],
			),
		).toEqual(["wwan0"]);
		expect(d.selector.active()).toBe("id-eth0");
		expect(d.selector.rejoinHoldMs("id-eth0")).toBe(HOLD);
		expect(d.pick(2_000, ["eth0", "wwan0"])).toEqual(["eth0"]);
		// A promotion plan that is never applied leaves the backup in charge.
		const r = driver();
		r.pick(0, ["wwan0"]);
		r.pick(10_000, ["eth0", "wwan0"]);
		// eth0 has been probed since the 5 s round; its hold ends at 35 s.
		r.pick(HOLD, ["eth0", "wwan0"]);
		expect(r.peek(5_000 + HOLD, ["eth0", "wwan0"])).toEqual(["eth0"]);
		expect(r.selector.active()).toBe("id-wwan0");
		// eth0 then fails before any apply: it never carried clients, no penalty.
		r.pick(
			5_000 + HOLD + 1,
			["wwan0"],
			[record("eth0", "down", 0), live("wwan0", 5_000 + HOLD + 1)],
		);
		expect(r.selector.rejoinHoldMs("id-eth0")).toBe(HOLD);
	});

	test("a better uplink rejoins only after its hold with fresh probe evidence", () => {
		const d = driver();
		expect(d.pick(0, ["wwan0"])).toEqual(["wwan0"]);
		// A fresh record starts `up` before any probe: no evidence, no switch.
		const unproven = (now: number) => [
			record("eth0", "up", 0, now + 15_000),
			live("wwan0", now),
		];
		expect(d.pick(1_000, ["eth0", "wwan0"], unproven(1_000))).toEqual([
			"wwan0",
		]);
		expect(d.pick(HOLD * 5, ["eth0", "wwan0"], unproven(HOLD * 5))).toEqual([
			"wwan0",
		]);
		// Proven from t=200 s; the hold counts from there.
		const start = 200_000;
		expect(d.pick(start, ["eth0", "wwan0"])).toEqual(["wwan0"]);
		expect(d.pick(start + HOLD - 1, ["eth0", "wwan0"])).toEqual(["wwan0"]);
		expect(d.pick(start + HOLD, ["eth0", "wwan0"])).toEqual(["eth0"]);
	});

	test("sender telemetry alone never qualifies an uplink to take clients", () => {
		const d = driver();
		d.pick(0, ["wwan0"]);
		// A streaming wired link reports healthy SRTLA rows but is never probed.
		for (let now = 5_000; now <= HOLD * 10; now += 5_000) {
			expect(
				d.pick(
					now,
					["eth0", "wwan0"],
					[telemetryOnly("eth0", now), live("wwan0", now)],
				),
			).toEqual(["wwan0"]);
		}
	});

	test("expired, interrupted or inherited evidence cannot complete a rejoin hold", () => {
		const d = driver();
		d.pick(0, ["wwan0"]);
		// One success at t=10 s, then probe rounds stop: the record expires.
		const frozen = (now: number) => [
			record("eth0", "up", 1, 25_000, 10_000),
			live("wwan0", now),
		];
		d.pick(10_000, ["eth0", "wwan0"], frozen(10_000));
		expect(
			d.pick(10_000 + HOLD, ["eth0", "wwan0"], frozen(10_000 + HOLD)),
		).toEqual(["wwan0"]);
		// Probing resumes at 100 s: the hold restarts there, not at 10 s.
		expect(d.pick(100_000, ["eth0", "wwan0"])).toEqual(["wwan0"]);
		expect(d.pick(100_000 + HOLD - 5_000, ["eth0", "wwan0"])).toEqual([
			"wwan0",
		]);
		expect(d.pick(100_000 + HOLD, ["eth0", "wwan0"])).toEqual(["eth0"]);

		// A replacement device on the same name: a sample taken before it
		// appeared does not start its hold.
		const r = driver();
		r.pick(0, ["wwan0"]);
		const predecessor = [
			record("eth0", "up", 9, 20_000, 6_000),
			live("wwan0", 6_000),
		];
		r.pick(6_000, ["eth0", "wwan0"], predecessor);
		r.pick(15_000, ["eth0", "wwan0"]);
		expect(r.pick(6_000 + HOLD, ["eth0", "wwan0"])).toEqual(["wwan0"]);
		expect(r.pick(15_000 + HOLD, ["eth0", "wwan0"])).toEqual(["eth0"]);
	});

	test("losing the active uplink's address counts as a failure before health catches up", () => {
		const d = driver();
		expect(d.pick(0, ["eth0", "wwan0"])).toEqual(["eth0"]);
		// eth0 is no longer offered (no address); its health record still says up.
		const selector = d.selector;
		const plan = applyClientUplinkPolicy(["wwan0"].map(uplink), selector, {
			now: 1_000,
			policy: DEFAULT_SHARING_POLICY,
			health: new Map([
				["eth0", live("eth0", 1_000)],
				["wwan0", live("wwan0", 1_000)],
			]),
			interfaces: new Set(["wwan0"]),
		});
		selector.commit(plan.next);
		expect(selector.active()).toBe("id-wwan0");
		expect(selector.rejoinHoldMs("id-eth0")).toBe(HOLD * 2);
	});

	test("a degraded uplink yields to a proven healthy one even against priority", () => {
		const d = driver({
			...DEFAULT_SHARING_POLICY,
			priorities: { wired: 0, cellular: 10, wifi: 10 },
		});
		expect(d.pick(0, ["eth0", "wwan0"])).toEqual(["eth0"]);
		// While streaming, a dead wired link can stay `degraded` from sender
		// telemetry without being withdrawn.
		const health = (now: number) => [
			record("eth0", "degraded", 0, now + 15_000),
			live("wwan0", now),
		];
		for (let now = 5_000; now < HOLD; now += 5_000)
			expect(d.pick(now, ["eth0", "wwan0"], health(now))).toEqual(["eth0"]);
		expect(d.pick(HOLD, ["eth0", "wwan0"], health(HOLD))).toEqual(["wwan0"]);
	});

	test("an equal-rank uplink never displaces a working active one", () => {
		const d = driver();
		expect(d.pick(0, ["wwan1"])).toEqual(["wwan1"]);
		expect(d.pick(1, ["wwan0", "wwan1"])).toEqual(["wwan1"]);
		expect(d.pick(HOLD * 10, ["wwan0", "wwan1"])).toEqual(["wwan1"]);
	});

	test("repeated failures double the rejoin hold up to the cap, and the penalty expires", () => {
		const d = driver();
		let now = 0;
		const proven = ["eth0", "wwan0"];
		d.pick(now, proven);
		for (const expected of [2, 4, 8, 10, 10]) {
			now += 1_000;
			expect(
				d.pick(now, ["wwan0"], [record("eth0", "down", 0), live("wwan0", now)]),
			).toEqual(["wwan0"]);
			const hold = d.selector.rejoinHoldMs("id-eth0");
			expect(hold).toBe(Math.min(HOLD * expected, 300_000));
			now += 1_000;
			d.pick(now, proven);
			expect(d.pick(now + hold - 1, proven)).toEqual(["wwan0"]);
			now += hold;
			expect(d.pick(now, proven)).toEqual(["eth0"]);
		}
		// Ten quiet minutes as the active uplink clear the history.
		now += ACTIVE_UPLINK_CONFIG.flapWindowMs;
		expect(d.pick(now, proven)).toEqual(["eth0"]);
		expect(d.selector.rejoinHoldMs("id-eth0")).toBe(HOLD);
	});

	test("an exclusion or a withheld uplink switches immediately without a failure penalty", () => {
		let policy: SharingPolicy = DEFAULT_SHARING_POLICY;
		const selector = new ActiveUplinkSelector();
		const pick = (now: number, ifnames = ["eth0", "wwan0"]) => {
			const result = applyClientUplinkPolicy(ifnames.map(uplink), selector, {
				now,
				policy,
				health: new Map(["eth0", "wwan0"].map((i) => [i, live(i, now)])),
				interfaces: new Set(["eth0", "wwan0"]),
			});
			selector.commit(result.next);
			return result.candidates
				.filter(({ uplink: u }) => u.selectable)
				.map(({ uplink: u }) => u.ifname);
		};
		expect(pick(0)).toEqual(["eth0"]);
		policy = { ...policy, administrativelyDown: ["eth0"] };
		expect(pick(1)).toEqual(["wwan0"]);
		expect(selector.rejoinHoldMs("id-eth0")).toBe(HOLD);
		policy = { ...policy, administrativelyDown: [] };
		// Re-enabled: the ordinary hold runs from its return to the candidates.
		expect(pick(2)).toEqual(["wwan0"]);
		for (let now = 5_002; now < 2 + HOLD; now += 5_000)
			expect(pick(now)).toEqual(["wwan0"]);
		expect(pick(2 + HOLD)).toEqual(["eth0"]);
		// Held back (identity proof pending) while present and healthy.
		expect(pick(HOLD * 3, ["wwan0"])).toEqual(["wwan0"]);
		expect(selector.rejoinHoldMs("id-eth0")).toBe(HOLD);
	});

	test("spread keeps the weighted distribution and resets single-selection state", () => {
		const policy: SharingPolicy = {
			...DEFAULT_SHARING_POLICY,
			selection: "spread",
		};
		const candidates = ["eth0", "wwan0", "wlan0"].map(uplink);
		const selector = new ActiveUplinkSelector();
		selector.select(candidates, {
			now: 0,
			policy: DEFAULT_SHARING_POLICY,
			health: new Map(),
			interfaces: new Set(),
		});
		expect(selector.active()).toBe("id-eth0");
		const spread = applyClientUplinkPolicy(candidates, selector, {
			now: 0,
			policy,
			health: new Map(),
			interfaces: new Set(),
		});
		expect(spread.candidates).toEqual(applySharingPolicy(candidates, policy));
		selector.commit(spread.next);
		expect(selector.active()).toBeUndefined();
	});
});

describe("single-active selection on the live state builder", () => {
	function netif(ip: string, error = 0): NetworkInterface {
		return {
			ip,
			netmask: "255.255.255.0",
			tp: 0,
			txb: 0,
			rxb: 0,
			enabled: error === 0,
			error,
		};
	}

	test("health-down withdraws the active uplink and the status names the new one", async () => {
		let now = 0;
		let health: UplinkHealthRecord[] = [record("eth0"), record("wwan0")];
		const selector = new ActiveUplinkSelector();
		const deps = {
			policy: () => DEFAULT_SHARING_POLICY,
			selector,
			now: () => now,
			interfaces: () => ({
				"clap-wlan0": netif("10.42.0.1", NETIF_ERR_HOTSPOT),
				eth0: netif("192.0.2.2"),
				wwan0: netif("198.51.100.2"),
			}),
			health: () => health,
			wifiIdentity: () => undefined,
			physicalIdentity: (ifname: string) => `phys-${ifname}`,
			markForIdentity: stableUplinkMark,
			isBondCandidate: () => false,
			isClientZone: (ifname: string) => ifname.startsWith("clap-"),
			planRoute: async (candidate: {
				identity: string;
				ifname: string;
				sourceAddress: string;
				mark: number;
			}) => ({
				identity: candidate.identity,
				ifname: candidate.ifname,
				sourceAddress: candidate.sourceAddress,
				mark: candidate.mark,
				table: `${30_000 + ((candidate.mark >>> 8) & 0xffff)}`,
				managed: true,
			}),
		};
		const first = await readReadySteeringState(deps);
		expect(
			first.uplinks.map((u) => [u.ifname, u.selectable, u.weight]),
		).toEqual([
			["eth0", true, 100],
			["wwan0", false, 0],
		]);
		// Reading plans only; the runtime commits after a verified apply.
		expect(selector.active()).toBeUndefined();
		commitSelectorPlan(first, selector);
		expect(selector.active()).toBe("phys-eth0");
		resetUplinkSteeringStatusForTest();
		publishUplinkSteeringAvailability({ available: true }, first);
		expect(getUplinkSteeringStatus()).toEqual({
			state: "available",
			clientUplinks: ["eth0"],
		});

		now = 15_000;
		health = [record("eth0", "down", 0), record("wwan0")];
		const failed = await readReadySteeringState(deps);
		expect(
			failed.uplinks.map((u) => [u.ifname, u.selectable, u.weight]),
		).toEqual([["wwan0", true, 100]]);
		commitSelectorPlan(failed, selector);
		expect(selector.active()).toBe("phys-wwan0");
		expect(selector.rejoinHoldMs("phys-eth0")).toBe(HOLD * 2);
		publishUplinkSteeringAvailability({ available: true }, failed);
		expect(getUplinkSteeringStatus()).toEqual({
			state: "available",
			clientUplinks: ["wwan0"],
		});
		expect(
			uplinkSteeringStatusSchema.safeParse(getUplinkSteeringStatus()).success,
		).toBe(true);
		resetUplinkSteeringStatusForTest();
	});
});

describe("sharing policy schema", () => {
	test("selection defaults to single and rejects unknown styles", () => {
		const { selection: _omitted, ...legacy } = DEFAULT_SHARING_POLICY;
		expect(sharingPolicySchema.parse(legacy).selection).toBe("single");
		expect(DEFAULT_SHARING_POLICY.selection).toBe("single");
		expect(
			sharingPolicySchema.safeParse({
				...DEFAULT_SHARING_POLICY,
				selection: "all",
			}).success,
		).toBe(false);
	});

	test("a setter without selection keeps the current one", async () => {
		const owner = new SharingPolicyOwner();
		const reconcile = async () => {};
		await owner.set({ ...owner.get(), selection: "spread" }, reconcile);
		const { selection: _omitted, ...legacy } = owner.get();
		await owner.set(
			{ ...legacy, priorities: { wired: 0, cellular: 10, wifi: 0 } },
			reconcile,
		);
		expect(owner.get().selection).toBe("spread");
		expect(owner.get().priorities.cellular).toBe(10);
	});
});
