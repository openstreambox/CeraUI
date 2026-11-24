import { expect, test } from "bun:test";
import { sharingPolicySchema } from "@ceraui/rpc/schemas";
import { UplinkSteeringApplier } from "../modules/network/uplink-steering/applier.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import {
	applySharingPolicy,
	DEFAULT_SHARING_POLICY,
	SharingPolicyOwner,
} from "../modules/network/uplink-steering/policy.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

const candidates = ["eth0", "wwan0", "wlan0"].map((ifname) => ({
	uplink: {
		ifname,
		identity: ifname,
		mark: stableUplinkMark(ifname),
		weight: 100,
		selectable: true,
	},
}));
test("schema bounds runtime inputs", () => {
	for (const patch of [
		{ mode: "all" },
		{ administrativelyDown: ["eth0;reboot"] },
		{ priorities: { wired: -1, wifi: 0, cellular: 0 } },
	]) {
		expect(
			sharingPolicySchema.safeParse({ ...DEFAULT_SHARING_POLICY, ...patch })
				.success,
		).toBe(false);
	}
});
test("automatic picks the best healthy tier, ties share, down and forced modes fail closed", () => {
	const policy = {
		...DEFAULT_SHARING_POLICY,
		priorities: { wired: 0, cellular: 10, wifi: 20 },
	};
	expect(
		applySharingPolicy(candidates, policy).map((c) => c.uplink.weight),
	).toEqual([100, 0, 0]);
	expect(
		applySharingPolicy(candidates.slice(1), policy).map((c) => c.uplink.weight),
	).toEqual([100, 0]);
	expect(
		applySharingPolicy(candidates, DEFAULT_SHARING_POLICY).map(
			(c) => c.uplink.weight,
		),
	).toEqual([100, 100, 100]);
	expect(
		applySharingPolicy(candidates.slice(0, 1), {
			...policy,
			mode: "cellular-only",
		}),
	).toEqual([]);
	expect(
		applySharingPolicy(candidates, {
			...policy,
			administrativelyDown: ["eth0", "wwan0", "wlan0"],
		}),
	).toEqual([]);
});
test("runtime setter reconciles without a health/NM tick, retires only excluded marks, and resets on restart", async () => {
	const owner = new SharingPolicyOwner();
	const effects: string[] = [];
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => [],
		ensureRoute: async (route) => ({ route, changed: false }),
		rollbackRoute: async () => {},
		removeRoute: async (route) => {
			effects.push(`remove:${route.ifname}`);
		},
		applyRuleset: async () => {
			effects.push("rules");
		},
		deactivateSharing: async () => {},
		flushConntrack: async (mark) => {
			effects.push(`flush:${mark}`);
		},
		setIpForwarding: async () => {},
		publishFlowsReset: (event) => {
			effects.push(`reset:${event.iface}`);
		},
	});
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: async () => {
			const uplinks = applySharingPolicy(candidates, owner.get()).map(
				(c) => c.uplink,
			);
			return {
				clientZones: [{ ifname: "ap0", ipv4Cidr: "10.42.0.0/24" }],
				uplinks,
				routes: candidates.map(({ uplink: u }) => ({
					...u,
					sourceAddress: "192.0.2.2",
					table: String(u.mark),
					managed: true,
				})),
			};
		},
		apply: (before, after) => applier.apply(before, after),
		publishAvailability: () => {},
	});
	await coordinator.requestReconcile();
	effects.length = 0;
	const start = performance.now();
	await owner.set({ ...owner.get(), mode: "cellular-only" }, () =>
		coordinator.requestReconcile(),
	);
	expect(performance.now() - start).toBeLessThan(1000);
	expect(coordinator.appliedState()?.uplinks.map((u) => u.ifname)).toEqual([
		"wwan0",
	]);
	expect(effects.indexOf("rules")).toBeLessThan(
		effects.indexOf(`flush:${candidates[0]?.uplink.mark}`),
	);
	expect(effects).toContain("reset:eth0");
	expect(effects).not.toContain("reset:wwan0");
	expect(effects.some((effect) => effect.startsWith("remove:"))).toBe(false);
	await owner.set({ ...owner.get(), mode: "automatic" }, () =>
		coordinator.requestReconcile(),
	);
	effects.length = 0;
	await owner.set(
		{ ...owner.get(), priorities: { wired: 0, cellular: 10, wifi: 20 } },
		() => coordinator.requestReconcile(),
	);
	expect(effects).toEqual(["rules"]);
	await owner.set({ ...owner.get(), administrativelyDown: ["eth0"] }, () =>
		coordinator.requestReconcile(),
	);
	expect(
		coordinator.appliedState()?.uplinks.find((u) => u.ifname === "wwan0")
			?.selectable,
	).toBe(true);
	expect(effects).toContain("reset:eth0");
	await owner.set({ ...owner.get(), administrativelyDown: [] }, () =>
		coordinator.requestReconcile(),
	);
	expect(
		coordinator.appliedState()?.uplinks.find((u) => u.ifname === "eth0")
			?.selectable,
	).toBe(true);
	expect(effects.some((effect) => effect.startsWith("remove:"))).toBe(false);
	const routesBeforeAllDown = coordinator.appliedState()?.routes;
	await owner.set(
		{ ...owner.get(), administrativelyDown: ["eth0", "wwan0", "wlan0"] },
		() => coordinator.requestReconcile(),
	);
	expect(coordinator.appliedState()?.uplinks).toEqual([]);
	expect(coordinator.appliedState()?.routes).toEqual(routesBeforeAllDown);
	expect(coordinator.appliedState()?.clientZones).toEqual([
		{ ifname: "ap0", ipv4Cidr: "10.42.0.0/24" },
	]);
	expect(new SharingPolicyOwner().get()).toEqual(DEFAULT_SHARING_POLICY);
});

test("queued policy writes serialize and failed reconciliation does not poison the next mutation", async () => {
	const owner = new SharingPolicyOwner();
	const seen: string[] = [];
	const first = owner.set({ ...owner.get(), mode: "wired-only" }, async () => {
		seen.push(owner.get().mode);
		throw new Error("apply failed");
	});
	const second = owner.set(
		{ ...owner.get(), mode: "cellular-only" },
		async () => {
			seen.push(owner.get().mode);
		},
	);
	await expect(first).rejects.toThrow("apply failed");
	await expect(second).resolves.toMatchObject({ mode: "cellular-only" });
	expect(seen).toEqual(["wired-only", "cellular-only"]);
	const copy = owner.get();
	copy.administrativelyDown.push("eth0");
	expect(owner.get().administrativelyDown).toEqual([]);
});

test("startup exclusion flushes recovered client marks while retaining healthy routes", async () => {
	const routes = candidates.map(({ uplink }) => ({
		...uplink,
		sourceAddress: "192.0.2.2",
		table: String(uplink.mark),
		managed: true,
	}));
	const effects: string[] = [];
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => routes,
		ensureRoute: async (route) => ({ route, changed: false }),
		rollbackRoute: async () => {},
		removeRoute: async () => {
			effects.push("remove");
		},
		applyRuleset: async () => {
			effects.push("rules");
		},
		deactivateSharing: async () => {},
		flushConntrack: async (mark) => {
			effects.push(`flush:${mark}`);
		},
		setIpForwarding: async () => {},
		publishFlowsReset: () => {},
	});
	await applier.apply(undefined, {
		clientZones: [{ ifname: "ap0", ipv4Cidr: "10.42.0.0/24" }],
		routes,
		uplinks: applySharingPolicy(candidates, {
			...DEFAULT_SHARING_POLICY,
			mode: "cellular-only",
		}).map((c) => c.uplink),
	});
	expect(effects).toEqual([
		"rules",
		`flush:${candidates[0]?.uplink.mark}`,
		`flush:${candidates[2]?.uplink.mark}`,
	]);
});
