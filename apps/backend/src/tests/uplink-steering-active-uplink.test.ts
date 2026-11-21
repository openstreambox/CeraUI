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
} from "../modules/network/uplink-steering/active-uplink.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import {
	applySharingPolicy,
	DEFAULT_SHARING_POLICY,
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
): UplinkHealthRecord {
	return {
		iface,
		kind: "ethernet",
		state,
		weight: state === "down" ? 0 : state === "degraded" ? 25 : 100,
		lastTransition: 0,
		staleAt: 0,
		probes: { successes, failures: 0 },
		signals: {},
	} as UplinkHealthRecord;
}

/** Drives one selector the way successive reconciles would. */
function driver(policy: SharingPolicy = DEFAULT_SHARING_POLICY) {
	const selector = new ActiveUplinkSelector();
	return {
		selector,
		pick(
			now: number,
			ifnames: readonly string[],
			health: readonly UplinkHealthRecord[] = ifnames.map((i) => record(i)),
		): string[] {
			const candidates = ifnames.map(uplink);
			return applyClientUplinkPolicy(candidates, selector, {
				now,
				policy,
				health: new Map(health.map((r) => [r.iface, r])),
				present: new Set(
					health.filter((r) => r.state !== "down").map((r) => `id-${r.iface}`),
				),
			})
				.filter(({ uplink: u }) => u.selectable && u.weight > 0)
				.map(({ uplink: u }) => u.ifname);
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
		const out = applyClientUplinkPolicy(
			["eth0", "wwan0", "wwan1"].map(uplink),
			selector,
			{
				now: 0,
				policy: DEFAULT_SHARING_POLICY,
				health: new Map(),
				present: new Set(),
			},
		).map(({ uplink: u }) => [u.ifname, u.selectable, u.weight]);
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
				{
					now: 1,
					policy: DEFAULT_SHARING_POLICY,
					health: new Map(),
					present: new Set(),
				},
			).map(({ uplink: u }) => u),
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
			d.pick(1_000, ["wwan0"], [record("eth0", "down", 0), record("wwan0")]),
		).toEqual(["wwan0"]);
		expect(d.selector.rejoinHoldMs("id-eth0")).toBe(HOLD * 2);
		// No uplink left: nothing is selectable, the ruleset's drop chain applies.
		expect(d.pick(2_000, [], [record("wwan0", "down", 0)])).toEqual([]);
	});

	test("a better uplink rejoins only after its hold with probe evidence", () => {
		const d = driver();
		expect(d.pick(0, ["wwan0"])).toEqual(["wwan0"]);
		// A fresh record starts `up` before any probe: no evidence, no switch.
		const unproven = [record("eth0", "up", 0), record("wwan0")];
		expect(d.pick(1_000, ["eth0", "wwan0"], unproven)).toEqual(["wwan0"]);
		expect(d.pick(HOLD * 5, ["eth0", "wwan0"], unproven)).toEqual(["wwan0"]);
		// Proven from t=200 s; the hold counts from there.
		const start = 200_000;
		expect(d.pick(start, ["eth0", "wwan0"])).toEqual(["wwan0"]);
		expect(d.pick(start + HOLD - 1, ["eth0", "wwan0"])).toEqual(["wwan0"]);
		expect(d.pick(start + HOLD, ["eth0", "wwan0"])).toEqual(["eth0"]);
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
		const down = [record("eth0", "down", 0), record("wwan0")];
		d.pick(now, proven);
		for (const expected of [2, 4, 8, 10, 10]) {
			now += 1_000;
			expect(d.pick(now, ["wwan0"], down)).toEqual(["wwan0"]);
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

	test("an administrative exclusion switches immediately without a failure penalty", () => {
		let policy: SharingPolicy = DEFAULT_SHARING_POLICY;
		const selector = new ActiveUplinkSelector();
		const pick = (now: number) =>
			applyClientUplinkPolicy(["eth0", "wwan0"].map(uplink), selector, {
				now,
				policy,
				health: new Map(["eth0", "wwan0"].map((i) => [i, record(i)])),
				present: new Set(["id-eth0", "id-wwan0"]),
			})
				.filter(({ uplink: u }) => u.selectable)
				.map(({ uplink: u }) => u.ifname);
		expect(pick(0)).toEqual(["eth0"]);
		policy = { ...policy, administrativelyDown: ["eth0"] };
		expect(pick(1)).toEqual(["wwan0"]);
		expect(selector.rejoinHoldMs("id-eth0")).toBe(HOLD);
		policy = { ...policy, administrativelyDown: [] };
		// Re-enabled: the ordinary hold runs from its return to the candidates.
		expect(pick(2)).toEqual(["wwan0"]);
		expect(pick(2 + HOLD - 1)).toEqual(["wwan0"]);
		expect(pick(2 + HOLD)).toEqual(["eth0"]);
	});

	test("a degraded active uplink yields to a proven healthy one after the hold", () => {
		const d = driver();
		expect(d.pick(0, ["eth0", "eth1"])).toEqual(["eth0"]);
		const health = [record("eth0", "degraded", 0), record("eth1")];
		// eth1 has been proven since t=0, so the hold is already served.
		expect(d.pick(HOLD, ["eth0", "eth1"], health)).toEqual(["eth1"]);
	});

	test("spread keeps the weighted distribution of the existing policy", () => {
		const policy: SharingPolicy = {
			...DEFAULT_SHARING_POLICY,
			selection: "spread",
		};
		const candidates = ["eth0", "wwan0", "wlan0"].map(uplink);
		expect(
			applyClientUplinkPolicy(candidates, new ActiveUplinkSelector(), {
				now: 0,
				policy,
				health: new Map(),
				present: new Set(),
			}),
		).toEqual(applySharingPolicy(candidates, policy));
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
});
