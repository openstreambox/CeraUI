import { describe, expect, test } from "bun:test";
import type { SharingPolicy } from "@ceraui/rpc/schemas";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	type UplinkHealthRecord,
} from "../modules/network/uplink-health/model.ts";
import { UplinkHealthRuntimeCore } from "../modules/network/uplink-health/runtime-core.ts";
import {
	ActiveUplinkSelector,
	commitSelectorPlan,
	selectionStillQualified,
} from "../modules/network/uplink-steering/active-uplink.ts";
import {
	type PreparedSteeringState,
	type UplinkRoutePlan,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import { DEFAULT_SHARING_POLICY } from "../modules/network/uplink-steering/policy.ts";
import {
	buildShareRuleset,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

/**
 * The health engine, state builder, selector, coordinator and applier
 * together, with injected clocks and system calls. Each scenario comes from
 * an independent review of the single-active client uplink; the comments
 * name what the reviewer observed before the fix.
 */

const HOLD = 30_000;

function netif(ip: string | undefined): NetworkInterface {
	return {
		...(ip === undefined ? {} : { ip }),
		netmask: "255.255.255.0",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	} as NetworkInterface;
}

const INTERFACES = {
	eth9: netif("10.42.0.1"),
	eth0: netif("192.0.2.2"),
	wwan0: netif("198.51.100.2"),
} as const;

const IDENTITIES = ["wired:a", "wired:replacement", "wwan0", "wwan1"];

interface World {
	readonly selector: ActiveUplinkSelector;
	now: number;
	ethId: string;
	policy: SharingPolicy;
	interfaces: Record<string, NetworkInterface>;
	health: readonly UplinkHealthRecord[];
}

function world(): World {
	return {
		selector: new ActiveUplinkSelector(),
		now: 0,
		ethId: "wired:a",
		policy: DEFAULT_SHARING_POLICY,
		interfaces: { ...INTERFACES },
		health: [],
	};
}

function read(w: World) {
	return (context = {}) =>
		readReadySteeringState(
			{
				policy: () => w.policy,
				selector: w.selector,
				now: () => w.now,
				health: () => w.health,
				interfaces: () => w.interfaces,
				wifiIdentity: () => undefined,
				physicalIdentity: (ifname) => (ifname === "eth0" ? w.ethId : ifname),
				markForIdentity: stableUplinkMark,
				isBondCandidate: () => false,
				isClientZone: (ifname) => ifname === "eth9",
				planRoute: async (candidate) => ({
					...candidate,
					table: String(30_000 + ((candidate.mark >>> 8) & 0xffff)),
					managed: true,
				}),
			},
			context,
		);
}

/** The uplink a ruleset's selection chain sends new client flows to. */
function selectedBy(rules: string | undefined): string | undefined {
	if (rules === undefined) return undefined;
	for (const identity of IDENTITIES) {
		const mark = stableUplinkMark(identity).toString(16).padStart(8, "0");
		if (rules.includes(`meta mark set (meta mark & 0x000000ff) | 0x${mark}`))
			return identity.startsWith("wired:") ? "eth0" : identity;
	}
	return undefined;
}

const active = (state: PreparedSteeringState | undefined) =>
	state?.uplinks.find((u) => u.selectable)?.ifname;

/** A record as the health engine publishes it for a probed uplink. */
function probed(
	iface: string,
	now: number,
	since: number | undefined = now,
	state: UplinkHealthRecord["state"] = "up",
): UplinkHealthRecord {
	return {
		iface,
		kind: iface === "eth0" ? "ethernet" : "cellular",
		state,
		weight: state === "down" ? 0 : 100,
		lastTransition: 0,
		staleAt: now + 15_000,
		probes:
			since === undefined
				? { successes: 0, failures: 3 }
				: { successes: 1 + Math.floor((now - since) / 5_000), failures: 0 },
		signals: {
			activeAt: now,
			...(since === undefined ? {} : { probeSince: since }),
		},
	};
}
const down = (iface: string, now: number) =>
	probed(iface, now, undefined, "down");

interface DriverOptions {
	/** Throws to reject a ruleset before the kernel installs it. */
	rejectRuleset?: (rules: string) => boolean;
	rejectFlush?: () => boolean;
	rejectRestore?: () => boolean;
	afterLoad?: (next: PreparedSteeringState) => void | Promise<void>;
	retry?: () => void;
	/** Runs while a route is provisioned; returns whether it changed. */
	provision?: (route: UplinkRoutePlan) => boolean;
}

/** The production wiring of `uplink-steering/runtime.ts` on stubbed system calls. */
function driver(w: World, options: DriverOptions = {}) {
	const log = {
		rules: undefined as string | undefined,
		attempted: [] as (string | undefined)[],
		verified: [] as (string | undefined)[],
		routes: new Map<string, UplinkRoutePlan>(),
		flushed: [] as number[],
		rolledBack: [] as string[],
	};
	let restoring = false;
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => [],
		ensureRoute: async (route) => {
			const changed = options.provision?.(route) ?? false;
			log.routes.set(route.ifname, route);
			return { route, changed };
		},
		rollbackRoute: async ({ route }) => {
			log.rolledBack.push(route.ifname);
			log.routes.delete(route.ifname);
		},
		removeRoute: async (route) => {
			log.routes.delete(route.ifname);
		},
		applyRuleset: async (rules) => {
			if (restoring && options.rejectRestore?.())
				throw new Error("restore rejected");
			if (options.rejectRuleset?.(rules)) throw new Error("nft rejected");
			log.rules = rules;
		},
		deactivateSharing: async () => {
			log.rules = undefined;
		},
		flushConntrack: async (mark) => {
			if (options.rejectFlush?.()) {
				restoring = true;
				throw new Error("conntrack refused flush");
			}
			log.flushed.push(mark);
		},
		setIpForwarding: async () => {},
		publishFlowsReset: () => {},
		selectionInstalled: (state) => {
			commitSelectorPlan(state, w.selector);
			coordinator.markInstalled(state);
		},
		selectionQualified: (state) => selectionStillQualified(state, w.now),
	});
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: read(w),
		publishAvailability: () => {},
		now: () => w.now,
		apply: async (previous, next) => {
			log.attempted.push(active(next));
			try {
				await applier.apply(previous, next);
			} finally {
				restoring = false;
			}
		},
		verifyApplied: async (next) => {
			await options.afterLoad?.(next);
			commitSelectorPlan(next, w.selector);
			log.verified.push(active(next));
		},
		waitBeforeRetry: async () => options.retry?.(),
		retryCleanup: () => applier.retryPendingCleanup(),
	});
	return {
		log,
		coordinator,
		/** The uplink new client flows use in the installed ruleset. */
		loaded: () => selectedBy(log.rules),
		reconcile: () => coordinator.requestReconcile(),
	};
}

interface HealthOptions extends DriverOptions {
	/** RTTs of sender rows on eth0; undefined means not streaming. */
	telemetry?: () => readonly number[] | undefined;
	target?: () => string | undefined;
	probe?: (iface: string) => UplinkHealthOutcome;
}

/** Health ticks feed the steering coordinator, as in production. */
function healthDriver(w: World, options: HealthOptions = {}) {
	const d = driver(w, options);
	const probes: string[] = [];
	let reconcile: Promise<void> = Promise.resolve();
	const engine = new UplinkHealthEngine();
	const rows = () => options.telemetry?.();
	const runtime = new UplinkHealthRuntimeCore(
		{
			interfaces: () => w.interfaces,
			now: () => w.now,
			streaming: () => rows() !== undefined,
			telemetry: (() => {
				const rtts = rows();
				return rtts === undefined
					? null
					: {
							links: rtts.map((rtt) => ({
								conn_id: "wired",
								iface: "eth0",
								rtt_ms: rtt,
								nak_count: 0,
								stale: false,
							})),
							lastReadMs: w.now,
							measured_bps: 0,
						};
			}) as never,
			resolveTarget: async () =>
				options.target === undefined ? "203.0.113.10" : options.target(),
			probe: async ({ name }) => {
				probes.push(name);
				return options.probe?.(name) ?? "success";
			},
			publish: () => {},
			notify: (records) => {
				w.health = records;
				reconcile = d.reconcile();
			},
			exclusionReason: (entry) => (entry?.ip ? undefined : "no_address"),
			candidates: () =>
				Object.entries(w.interfaces)
					.filter(([name, entry]) => name !== "eth9" && entry.ip)
					.map(([name, entry]) => ({ name, ip: entry.ip as string })),
			identity: (iface) => ({
				kind: iface === "eth0" ? "ethernet" : "cellular",
			}),
		},
		engine,
	);
	return {
		...d,
		probes,
		engine,
		async tick(now: number, wait = true) {
			w.now = now;
			await runtime.tick();
			if (wait) await reconcile;
		},
	};
}

describe("only the general-internet probe qualifies a client uplink", () => {
	test("healthy sender rows never promote a challenger that fails the probe", async () => {
		// Review 2 and 3: Ethernet took every new client flow at 35 s with zero
		// probes, its sender rows counted as probe successes.
		const w = world();
		delete w.interfaces.eth0;
		const d = healthDriver(w, {
			telemetry: () => [20],
			probe: (iface) => (iface === "eth0" ? "failure" : "success"),
		});
		await d.tick(0);
		expect(d.loaded()).toBe("wwan0");
		w.interfaces.eth0 = INTERFACES.eth0;
		for (let now = 5_000; now <= 60_000; now += 5_000) {
			await d.tick(now);
			expect(d.loaded()).toBe("wwan0");
		}
		expect(d.probes).not.toContain("eth0");
		// The engine still counts the rows for health, but records them as
		// sender evidence only.
		expect(d.engine.get("eth0")).toMatchObject({ state: "up" });
		expect(d.engine.get("eth0")?.signals.activeAt).toBeUndefined();
		expect(d.engine.get("eth0")?.signals.probeSince).toBeUndefined();
		expect(d.engine.get("eth0")?.signals.passiveAt).toBe(60_000);
		expect(w.selector.active()).toBe("wwan0");
	});

	test("sender rows alone cannot win the first pick", async () => {
		// Review 3: the sole WAN, represented only by sender telemetry, was
		// installed immediately with zero probes.
		const w = world();
		delete w.interfaces.wwan0;
		const d = healthDriver(w, {
			telemetry: () => [20],
			probe: () => "failure",
		});
		await d.tick(0);
		expect(d.probes).toEqual([]);
		expect(d.loaded()).toBeUndefined();
		expect(d.log.rules).toContain("no selectable client uplink");
		await d.tick(5_000);
		expect(d.loaded()).toBeUndefined();
	});

	test("the first probe success admits the sole WAN once streaming stops", async () => {
		const w = world();
		delete w.interfaces.wwan0;
		let streaming = true;
		const d = healthDriver(w, {
			telemetry: () => (streaming ? [20] : undefined),
		});
		await d.tick(0);
		expect(d.loaded()).toBeUndefined();
		streaming = false;
		await d.tick(5_000);
		expect(d.probes).toEqual(["eth0"]);
		expect(d.loaded()).toBe("eth0");
	});

	test("degraded sender rows still demote a streaming incumbent", async () => {
		// Review 1, kept in review 2: a preferred wired link that stays
		// `degraded` from sender rows yields to a probed backup after the hold.
		const w = world();
		w.policy = {
			...DEFAULT_SHARING_POLICY,
			priorities: { wired: 0, cellular: 10, wifi: 0 },
		};
		let rtt: number | undefined;
		// eth0 passes its probe until the stream starts, then its internet
		// path fails; streaming suppresses its probes, sender rows go bad.
		const d = healthDriver(w, {
			telemetry: () => (rtt === undefined ? undefined : [rtt]),
			probe: (iface) =>
				iface === "eth0" && rtt !== undefined ? "failure" : "success",
		});
		await d.tick(0);
		expect(d.loaded()).toBe("eth0");
		const probesBefore = d.probes.length;
		rtt = 2_000;
		for (let now = 5_000; now < HOLD; now += 5_000) {
			await d.tick(now);
			expect(d.loaded()).toBe("eth0");
		}
		await d.tick(HOLD);
		expect(d.engine.get("eth0")?.state).toBe("degraded");
		expect(d.loaded()).toBe("wwan0");
		expect(d.probes.slice(probesBefore)).not.toContain("eth0");
	});

	test("a confirmed standby wins failover over an unprobed preferred WAN", async () => {
		// Review 3 (repaired there, kept): wwan1 was confirmed, wwan0 never was.
		const w = world();
		w.interfaces.wwan1 = netif("203.0.113.2");
		w.health = [probed("eth0", 0)];
		const d = driver(w);
		await d.reconcile();
		expect(d.loaded()).toBe("eth0");
		w.now = 5_000;
		w.health = [probed("eth0", 5_000, 0), probed("wwan1", 5_000)];
		await d.reconcile();
		w.now = 6_000;
		delete w.interfaces.eth0;
		await d.reconcile();
		expect(d.loaded()).toBe("wwan1");
	});

	test("with no probe-confirmed WAN left, clients get the all-down drop", async () => {
		// Review 1: the generated drop must survive the single selection.
		const w = world();
		w.health = [down("eth0", 0), down("wwan0", 0)];
		const ruleset = buildShareRuleset(await read(w)());
		expect(ruleset).toContain(
			'iifname "eth9" ip saddr 10.42.0.0/24 ct state new meta mark != 0xcb000100 drop',
		);
		expect(ruleset).not.toContain("vmap @uplink_verdicts");
	});
});

describe("the probe run is tracked where every round is seen", () => {
	test("rounds skipped for DNS restart the hold", async () => {
		// Review 2: an unobserved stale gap counted toward the hold.
		const w = world();
		delete w.interfaces.eth0;
		let target: string | undefined = "203.0.113.10";
		const d = healthDriver(w, { target: () => target });
		await d.tick(0);
		w.interfaces.eth0 = INTERFACES.eth0;
		await d.tick(5_000);
		expect(d.loaded()).toBe("wwan0");
		target = undefined;
		const verifications = d.log.verified.length;
		for (let now = 10_000; now <= 30_000; now += 5_000) await d.tick(now);
		expect(d.log.verified).toHaveLength(verifications);
		expect(d.engine.get("eth0")?.staleAt).toBe(20_000);
		target = "203.0.113.10";
		for (let now = 35_000; now < 65_000; now += 5_000) {
			await d.tick(now);
			expect(d.loaded()).toBe("wwan0");
		}
		expect(d.engine.get("eth0")?.signals.probeSince).toBe(35_000);
		await d.tick(65_000);
		expect(d.loaded()).toBe("eth0");
	});

	test("a readback that blocks while four rounds pass does not restart a continuous hold", async () => {
		// Review 3: the coalesced reconcile saw a 20 s gap and kept cellular
		// until 60 s although Ethernet passed every 5 s round from 5 s.
		const w = world();
		delete w.interfaces.eth0;
		let blocked = false;
		const verification = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const d = healthDriver(w, {
			afterLoad: async () => {
				if (!blocked) return;
				blocked = false;
				entered.resolve();
				await verification.promise;
			},
		});
		await d.tick(0);
		w.interfaces.eth0 = INTERFACES.eth0;
		await d.tick(5_000);
		blocked = true;
		await d.tick(10_000, false);
		await entered.promise;
		for (let now = 15_000; now <= 30_000; now += 5_000)
			await d.tick(now, false);
		expect(d.engine.get("eth0")?.signals.probeSince).toBe(5_000);
		verification.resolve();
		await d.reconcile();
		expect(d.loaded()).toBe("wwan0");
		await d.tick(35_000);
		expect(d.loaded()).toBe("eth0");
	});

	test("a failed round hidden between two coalesced samples restarts the hold", async () => {
		// Review 3: one success, a missed failure, one success; the sampled
		// counters looked continuous and Ethernet took clients at 35 s.
		const w = world();
		delete w.interfaces.eth0;
		let blocked = false;
		const verification = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const d = healthDriver(w, {
			probe: (iface) =>
				iface === "eth0" && w.now === 10_000 ? "failure" : "success",
			afterLoad: async () => {
				if (!blocked) return;
				blocked = false;
				entered.resolve();
				await verification.promise;
			},
		});
		await d.tick(0);
		w.interfaces.eth0 = INTERFACES.eth0;
		blocked = true;
		await d.tick(5_000, false);
		await entered.promise;
		await d.tick(10_000, false);
		await d.tick(15_000, false);
		expect(d.engine.get("eth0")?.signals.probeSince).toBe(15_000);
		verification.resolve();
		await d.reconcile();
		for (let now = 20_000; now < 45_000; now += 5_000) {
			await d.tick(now);
			expect(d.loaded()).toBe("wwan0");
		}
		await d.tick(45_000);
		expect(d.loaded()).toBe("eth0");
	});

	test("a replacement on the same name waits for 30 seconds of its own probes", async () => {
		// Review 2: the replacement started its hold from its predecessor's
		// record and took clients at 40 s, 25 s after its first own success.
		const w = world();
		delete w.interfaces.eth0;
		const d = healthDriver(w);
		await d.tick(0);
		w.interfaces.eth0 = INTERFACES.eth0;
		await d.tick(5_000);
		expect(d.loaded()).toBe("wwan0");
		w.now = 6_000;
		w.ethId = "wired:replacement";
		w.interfaces.eth0 = netif("192.0.2.3");
		await d.reconcile();
		expect(d.loaded()).toBe("wwan0");
		for (let now = 15_000; now < 45_000; now += 5_000) {
			await d.tick(now);
			expect(d.loaded()).toBe("wwan0");
		}
		await d.tick(45_000);
		expect(d.loaded()).toBe("eth0");
		expect(w.selector.active()).toBe("wired:replacement");
	});

	test("the same port on a new network (new address) needs a fresh run", async () => {
		// Same physical identity, so only the engine can tell: it restarts
		// the run on the address change.
		const w = world();
		delete w.interfaces.eth0;
		const d = healthDriver(w);
		await d.tick(0);
		w.interfaces.eth0 = INTERFACES.eth0;
		await d.tick(5_000);
		await d.tick(10_000);
		w.interfaces.eth0 = netif("192.0.2.77");
		for (let now = 15_000; now < 45_000; now += 5_000) {
			await d.tick(now);
			expect(d.loaded()).toBe("wwan0");
		}
		expect(d.engine.get("eth0")?.signals.probeSince).toBe(15_000);
		await d.tick(45_000);
		expect(d.loaded()).toBe("eth0");
	});

	test("a replacement the engine cannot tell apart still needs its own run", async () => {
		// Review 1: same name and address, new device: an expired record from
		// the old device promoted it.
		const w = world();
		w.health = [down("eth0", 0), probed("wwan0", 0)];
		const d = driver(w);
		await d.reconcile();
		expect(d.loaded()).toBe("wwan0");
		w.now = 1_000;
		w.health = [probed("eth0", 1_000, 0), probed("wwan0", 1_000, 0)];
		await d.reconcile();
		w.now = 2_000;
		w.ethId = "wired:replacement";
		w.health = [probed("eth0", 1_000, 0), probed("wwan0", 2_000, 0)];
		await d.reconcile();
		for (let now = 6_000; now < 6_000 + HOLD; now += 5_000) {
			w.now = now;
			w.health = [probed("eth0", now, 0), probed("wwan0", now, 0)];
			await d.reconcile();
			expect(d.loaded()).toBe("wwan0");
		}
		w.now = 6_000 + HOLD;
		w.health = [probed("eth0", w.now, 0), probed("wwan0", w.now, 0)];
		await d.reconcile();
		expect(d.loaded()).toBe("eth0");
	});
});

describe("the selector follows what is installed", () => {
	test("losing the active address charges it before health catches up", async () => {
		// Review 2 (30 s), repaired in review 3: address loss is a failure.
		const w = world();
		const d = healthDriver(w);
		await d.tick(0);
		expect(d.loaded()).toBe("eth0");
		w.now = 1_000;
		w.interfaces.eth0 = netif(undefined);
		await d.reconcile();
		expect(d.loaded()).toBe("wwan0");
		await d.tick(5_000);
		expect(d.engine.get("eth0")?.state).toBe("down");
		expect(w.selector.rejoinHoldMs("wired:a")).toBe(HOLD * 2);
	});

	for (const failurePoint of ["before install", "after install"] as const) {
		test(`a promotion failing ${failurePoint} charges only the WAN that carried new flows`, async () => {
			// Reviews 1 to 3: a rejected reload doubled the hold of a WAN that
			// never carried clients; a readback failure after install missed it.
			const w = world();
			w.health = [down("eth0", 0), probed("wwan0", 0)];
			let injected = false;
			const d = driver(w, {
				rejectRuleset: (rules) => {
					if (failurePoint !== "before install" || selectedBy(rules) !== "eth0")
						return false;
					injected = true;
					return true;
				},
				afterLoad: (next) => {
					if (failurePoint !== "after install" || active(next) !== "eth0")
						return;
					injected = true;
					throw new Error("readback failed");
				},
				retry: () => {
					expect(d.loaded()).toBe(
						failurePoint === "before install" ? "wwan0" : "eth0",
					);
					expect(w.selector.active()).toBe(
						failurePoint === "before install" ? "wwan0" : "wired:a",
					);
					w.now += 100;
					w.health = [down("eth0", w.now), probed("wwan0", w.now, 0)];
				},
			});
			await d.reconcile();
			for (let now = 5_000; now <= 5_000 + HOLD; now += 5_000) {
				w.now = now;
				w.health = [probed("eth0", now, 5_000), probed("wwan0", now, 0)];
				await d.reconcile();
			}
			expect(injected).toBe(true);
			expect(d.loaded()).toBe("wwan0");
			expect(d.log.verified).not.toContain("eth0");
			expect(active(d.coordinator.appliedState())).toBe("wwan0");
			expect(w.selector.rejoinHoldMs("wired:a")).toBe(
				failurePoint === "after install" ? HOLD * 2 : HOLD,
			);
		});
	}

	test("a read-only plan (the shaper) never moves the incumbent", async () => {
		const w = world();
		w.health = [probed("eth0", 0, undefined, "down"), probed("wwan0", 0)];
		const d = driver(w);
		await d.reconcile();
		// eth0 is offered again from 5 s; health reconciles every round.
		w.now = 5_000;
		w.health = [probed("eth0", w.now, 5_000), probed("wwan0", w.now, 0)];
		await d.reconcile();
		w.now = 5_000 + HOLD;
		w.health = [probed("eth0", w.now, 5_000), probed("wwan0", w.now, 0)];
		expect(active(await read(w)())).toBe("eth0");
		expect(w.selector.active()).toBe("wwan0");
		expect(d.loaded()).toBe("wwan0");
	});

	test("a failed conntrack flush after a policy exclusion restores the previous selection", async () => {
		// Review 3: the exclusion ruleset (selecting cellular) stayed live
		// while the selector kept wired; cellular then escaped its penalty.
		const w = world();
		w.health = [probed("eth0", 0), probed("wwan0", 0)];
		let failFlush = false;
		let sawRetry = false;
		const d = driver(w, {
			rejectFlush: () => {
				if (!failFlush) return false;
				failFlush = false;
				return true;
			},
			retry: () => {
				sawRetry = true;
				// The rollback put wired back; the selector agrees.
				expect(d.loaded()).toBe("eth0");
				expect(w.selector.active()).toBe("wired:a");
			},
		});
		await d.reconcile();
		expect(d.loaded()).toBe("eth0");
		w.policy = { ...DEFAULT_SHARING_POLICY, mode: "cellular-only" };
		w.now = 5_000;
		w.health = [probed("eth0", 5_000, 0), probed("wwan0", 5_000, 0)];
		failFlush = true;
		await d.reconcile();
		expect(sawRetry).toBe(true);
		expect(d.loaded()).toBe("wwan0");
		expect(w.selector.active()).toBe("wwan0");
	});

	test("when that rollback also fails, the selector takes the selection left live", async () => {
		const w = world();
		w.health = [probed("eth0", 0), probed("wwan0", 0)];
		let failFlush = false;
		let failRestore = false;
		const d = driver(w, {
			rejectFlush: () => {
				if (!failFlush) return false;
				failFlush = false;
				return true;
			},
			rejectRestore: () => {
				if (!failRestore) return false;
				failRestore = false;
				return true;
			},
			retry: () => {
				expect(d.loaded()).toBe("wwan0");
				expect(w.selector.active()).toBe("wwan0");
				// Cellular, which carried new flows since the exclusion, fails.
				delete w.interfaces.wwan0;
				w.now += 100;
			},
		});
		await d.reconcile();
		w.policy = { ...DEFAULT_SHARING_POLICY, mode: "cellular-only" };
		w.now = 5_000;
		w.health = [probed("eth0", 5_000, 0), probed("wwan0", 5_000, 0)];
		failFlush = true;
		failRestore = true;
		await d.reconcile();
		expect(d.loaded()).toBeUndefined();
		expect(w.selector.rejoinHoldMs("wwan0")).toBe(HOLD * 2);
	});

	test("a WAN installed before a failed readback is retired from what was installed", async () => {
		// Review 3: the retry used the older verified inventory, so Ethernet's
		// route stayed provisioned and its mark was never flushed.
		const w = world();
		delete w.interfaces.eth0;
		w.policy = { ...DEFAULT_SHARING_POLICY, mode: "wired-only" };
		w.health = [probed("wwan0", 0)];
		let readbackFailed = false;
		const d = driver(w, {
			afterLoad: (next) => {
				if (active(next) !== "eth0") return;
				readbackFailed = true;
				throw new Error("readback failed");
			},
			retry: () => {
				expect(w.selector.active()).toBe("wired:a");
				delete w.interfaces.eth0;
				w.now += 100;
			},
		});
		await d.reconcile();
		expect(d.coordinator.appliedState()?.routes.map((r) => r.ifname)).toEqual([
			"wwan0",
		]);
		w.interfaces.eth0 = INTERFACES.eth0;
		w.now = 5_000;
		w.health = [probed("eth0", 5_000), probed("wwan0", 5_000, 0)];
		await d.reconcile();
		expect(readbackFailed).toBe(true);
		expect(w.selector.rejoinHoldMs("wired:a")).toBe(HOLD * 2);
		expect(d.coordinator.appliedState()?.routes.map((r) => r.ifname)).toEqual([
			"wwan0",
		]);
		expect(d.log.routes.has("eth0")).toBe(false);
		expect(d.log.flushed).toEqual([stableUplinkMark("wired:a")]);
	});

	test("spread, zone loss and backoff reset or keep selector state only through verified applies", async () => {
		// Review 2 (verified behaviour, kept).
		const w = world();
		const health = (now: number) => [
			probed("eth0", now, 0),
			probed("wwan0", now, 0),
		];
		w.health = health(0);
		let fail = false;
		const d = driver(w, {
			rejectRuleset: (rules) => fail && selectedBy(rules) === "eth0",
		});
		w.policy = { ...DEFAULT_SHARING_POLICY, mode: "cellular-only" };
		await d.reconcile();
		expect(w.selector.active()).toBe("wwan0");
		w.policy = { ...w.policy, selection: "spread" };
		await d.reconcile();
		expect(d.log.attempted).toEqual(["wwan0"]);
		expect(d.log.verified).toEqual(["wwan0", "wwan0"]);
		expect(w.selector.active()).toBeUndefined();
		w.policy = DEFAULT_SHARING_POLICY;
		await d.reconcile();
		expect(w.selector.active()).toBe("wired:a");
		delete w.interfaces.eth9;
		await d.reconcile();
		expect(w.selector.active()).toBeUndefined();
		expect(d.coordinator.appliedState()?.clientZones).toEqual([]);
		w.interfaces.eth9 = INTERFACES.eth9;
		fail = true;
		await d.reconcile();
		expect(w.selector.active()).toBeUndefined();
		const attempts = d.log.attempted.length;
		fail = false;
		w.now = 1_000;
		w.health = health(1_000);
		await d.reconcile();
		expect(d.log.attempted).toHaveLength(attempts);
		expect(w.selector.active()).toBeUndefined();
		w.now = 5_000;
		w.health = health(5_000);
		await d.reconcile();
		expect(w.selector.active()).toBe("wired:a");
	});

	test("an incumbent from before spread is neither kept nor charged when single resumes", async () => {
		// Review 1: spread froze the old incumbent and its clock.
		const w = world();
		w.health = [probed("eth0", 0), probed("wwan0", 0)];
		const d = driver(w);
		await d.reconcile();
		expect(w.selector.active()).toBe("wired:a");
		w.policy = { ...DEFAULT_SHARING_POLICY, selection: "spread" };
		w.now = 1_000;
		w.health = [down("eth0", 1_000), probed("wwan0", 1_000, 0)];
		await d.reconcile();
		expect(w.selector.active()).toBeUndefined();
		w.policy = DEFAULT_SHARING_POLICY;
		w.now = 2_000;
		await d.reconcile();
		// A fresh selector waits for a probe success it has observed itself.
		expect(d.loaded()).toBeUndefined();
		w.now = 5_000;
		w.health = [down("eth0", 5_000), probed("wwan0", 5_000, 0)];
		await d.reconcile();
		// Wired is down: cellular is a fresh first pick and wired is not
		// charged for a failure while it carried no single selection.
		expect(d.loaded()).toBe("wwan0");
		expect(w.selector.rejoinHoldMs("wired:a")).toBe(HOLD);
	});
});

describe("review of #177", () => {
	test("a replacement after spread cannot use its predecessor's probe run", async () => {
		// The engine saw no change (same name, address and eligibility); the
		// replacement appeared while spread had reset the selector.
		const w = world();
		delete w.interfaces.wwan0;
		let streaming = false;
		const d = healthDriver(w, {
			telemetry: () => (streaming ? [10] : undefined),
		});
		w.policy = { ...DEFAULT_SHARING_POLICY, selection: "spread" };
		await d.tick(1_000);
		w.ethId = "wired:replacement";
		streaming = true;
		w.now = 2_000;
		w.policy = DEFAULT_SHARING_POLICY;
		await d.reconcile();
		expect(d.loaded()).toBeUndefined();
		await d.tick(3_000);
		expect(d.probes).toEqual(["eth0"]);
		expect(d.loaded()).toBeUndefined();
		// Once streaming stops, its own first probe success admits it.
		streaming = false;
		await d.tick(8_000);
		expect(d.loaded()).toBe("eth0");
		expect(w.selector.active()).toBe("wired:replacement");
	});

	test("an incumbent on a new network loses clients until probed there", async () => {
		const w = world();
		let streaming = false;
		const d = healthDriver(w, {
			telemetry: () => (streaming ? [10] : undefined),
		});
		await d.tick(1_000);
		expect(d.loaded()).toBe("eth0");
		streaming = true;
		w.interfaces.eth0 = netif("192.0.3.2");
		await d.tick(2_000);
		expect(d.engine.get("eth0")?.signals.probeSince).toBeUndefined();
		// The confirmed cellular link takes new flows; no failure is charged.
		expect(d.loaded()).toBe("wwan0");
		expect(w.selector.rejoinHoldMs("wired:a")).toBe(HOLD);
		// Without a backup, nothing is selected.
		const solo = world();
		delete solo.interfaces.wwan0;
		let soloStreaming = false;
		const s = healthDriver(solo, {
			telemetry: () => (soloStreaming ? [10] : undefined),
		});
		await s.tick(1_000);
		expect(s.loaded()).toBe("eth0");
		soloStreaming = true;
		solo.interfaces.eth0 = netif("192.0.3.2");
		await s.tick(2_000);
		expect(s.log.routes.get("eth0")?.sourceAddress).toBe("192.0.3.2");
		expect(s.loaded()).toBeUndefined();
	});

	test("evidence that expires during route planning is not used", async () => {
		const w = world();
		w.now = 1_000;
		delete w.interfaces.wwan0;
		w.health = [probed("eth0", 1_000)];
		const state = await readReadySteeringState(
			{
				policy: () => w.policy,
				selector: w.selector,
				now: () => w.now,
				health: () => w.health,
				interfaces: () => w.interfaces,
				wifiIdentity: () => undefined,
				physicalIdentity: () => "wired:a",
				markForIdentity: stableUplinkMark,
				isBondCandidate: () => false,
				isClientZone: (name) => name === "eth9",
				planRoute: async (candidate) => {
					w.now = 17_000;
					return { ...candidate, table: "30001", managed: true };
				},
			},
			{},
		);
		expect(active(state)).toBeUndefined();
		expect(state.uplinks.map((u) => u.ifname)).toEqual(["eth0"]);
	});

	test("evidence that expires while routes are provisioned aborts the install", async () => {
		const w = world();
		delete w.interfaces.wwan0;
		w.now = 1_000;
		w.health = [probed("eth0", 1_000)];
		let slow = true;
		const d = driver(w, {
			// The first provisioning takes 16 s.
			provision: () => {
				if (slow) {
					slow = false;
					w.now = 17_000;
				}
				return true;
			},
		});
		await d.reconcile();
		expect(d.log.attempted[0]).toBe("eth0");
		// The retry re-planned with expired evidence: nothing is selected.
		expect(d.loaded()).toBeUndefined();
		expect(d.log.rolledBack).toContain("eth0");
		expect(w.selector.active()).toBeUndefined();
	});

	test("a failed rollback keeps the live selection's route and retires what it dropped", async () => {
		// Only Ethernet installed; it fails while a newly confirmed cellular
		// route is provisioned, and both the flush and the restore fail.
		const w = world();
		delete w.interfaces.wwan0;
		w.health = [probed("eth0", 0)];
		let failFlush = false;
		let failRestore = false;
		const d = driver(w, {
			provision: (route) => route.ifname === "wwan0",
			rejectFlush: () => {
				if (!failFlush) return false;
				failFlush = false;
				return true;
			},
			rejectRestore: () => {
				if (!failRestore) return false;
				failRestore = false;
				return true;
			},
			retry: () => {
				// Cellular carries new flows and keeps its route.
				expect(d.loaded()).toBe("wwan0");
				expect(w.selector.active()).toBe("wwan0");
				expect(d.log.rolledBack).not.toContain("wwan0");
				expect(d.log.routes.has("wwan0")).toBe(true);
				// Cellular then disappears before the retry.
				delete w.interfaces.wwan0;
				w.now += 100;
			},
		});
		await d.reconcile();
		expect(d.loaded()).toBe("eth0");
		w.now = 5_000;
		w.interfaces.wwan0 = INTERFACES.wwan0;
		w.health = [down("eth0", 5_000), probed("wwan0", 5_000)];
		failFlush = true;
		failRestore = true;
		await d.reconcile();
		// The retry retired cellular from what was installed and charged it.
		expect(d.log.flushed).toContain(stableUplinkMark("wwan0"));
		expect(d.log.routes.has("wwan0")).toBe(false);
		expect(w.selector.rejoinHoldMs("wwan0")).toBe(HOLD * 2);
		// Ethernet, dropped by the transition, is retired by the cleanup.
		expect(d.log.routes.has("eth0")).toBe(false);
	});
});
