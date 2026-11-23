import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import {
	HOST_ROUTE_PROTOCOL,
	setDefaultRoute,
} from "../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../modules/network/gateway-route-lifecycle.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import {
	NETIF_ERR_HOTSPOT,
	type NetworkInterface,
} from "../modules/network/network-interfaces.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const BASELINE = [
	"default via 192.0.2.1 dev uplink-a proto 16 metric 37",
	"default via 198.51.100.1 dev uplink-b proto 16 metric 83",
] as const;

function election(table: DefaultRouteTable): GatewayElectionDeps {
	return {
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: [], fromCache: false }),
		validateDns: () => {},
		checkConnectivity: async () => false,
		interfaces: () => ({}),
		eligible: () => true,
		defaultInterface: async () => "uplink-b",
		installRoute: (name, family) =>
			setDefaultRoute(name, { runner: table.runner, family }),
		releaseRoutes: () => setDefaultRoute(undefined, { runner: table.runner }),
		probes: {
			probeViaSourceIp: async () => false,
			probeViaDevice: async () => false,
			probeRepository: async () => ({
				verdict: "unreachable",
				ipv4: "no_route",
				ipv6: "no_route",
				used: "none",
				detail: [],
			}),
		},
	};
}

afterEach(resetShutdownForTest);

describe("gateway election and shutdown ownership wiring", () => {
	test("an empty election removes its previous preference", async () => {
		// Given: an owned winner whose interface is absent from the candidate roster.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		// When: the real coordinator completes an empty election.
		await updateGw(election(table));
		// Then: it releases only its own route, leaving the DHCP baseline intact.
		expect(table.rows()).toEqual([...BASELINE].sort());
	});

	test("a failed release reports failure instead of disarming maintenance", async () => {
		// Given: a preference whose deletion will fail.
		const table = new DefaultRouteTable(BASELINE);
		await setDefaultRoute("uplink-b", { runner: table.runner });
		table.failMutation = table.mutations.length + 1;
		// When: the coordinator tries to release on an empty election.
		const result = await updateGw(election(table));
		// Then: retry remains required and the unchanged preference stays observable.
		expect(result).toBe(false);
		expect(
			table
				.rows()
				.filter((row) => row.includes(`proto ${HOST_ROUTE_PROTOCOL}`)),
		).toHaveLength(1);
	});

	test("termination awaits route teardown before exit", async () => {
		// Given: the controller owns a live preference.
		const table = new DefaultRouteTable(BASELINE);
		const preference = new GatewayRoutePreference(table.runner);
		await preference.apply("uplink-b");
		const finished = Promise.withResolvers<void>();
		let atExit: string[] = [];
		// When: the real termination lifecycle is signalled.
		handleTerminationSignal("SIGTERM", {
			stopGatewayRoutes: () => preference.stop(),
			stopSrtIngest: async () => {},
			stopDmesgWatchers: () => {},
			gracefulShutdown: async () => {},
			exit: () => {
				atExit = table.rows();
				finished.resolve();
			},
		});
		await finished.promise;
		// Then: exit observes the baseline rather than an owned preference.
		expect(atExit).toEqual([...BASELINE].sort());
	});

	test("a boot sweep failure retries before allowing an election", async () => {
		// Given: a crash row and an initial failing deletion.
		const stale = `default via 203.0.113.1 dev absent proto ${HOST_ROUTE_PROTOCOL} metric 10`;
		const table = new DefaultRouteTable([...BASELINE, stale]);
		const preference = new GatewayRoutePreference(table.runner);
		table.failMutation = 1;
		await expect(preference.start()).rejects.toThrow();
		// When: the next election retries the failed startup boundary.
		await preference.apply("uplink-b");
		// Then: the stale interface cannot be carried into the winning preference.
		expect(table.rows()).not.toContain(stale);
		expect(
			table
				.rows()
				.filter((row) => row.includes(`proto ${HOST_ROUTE_PROTOCOL}`)),
		).toHaveLength(1);
	});
});

describe("gateway election current candidates", () => {
	const routes = [
		BASELINE[0].replace("37", "83"),
		BASELINE[1].replace("83", "37"),
	];
	const netif = (ip: string): NetworkInterface => ({
		ip,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	});
	const reachable = deriveVerdict([
		{
			origin: {
				url: "https://packages.example.test",
				host: "packages.example.test",
				scheme: "https",
				probeUrl: "https://packages.example.test/",
			},
			ipv4: "ok",
			ipv6: "no_route",
		},
	]);

	for (const outcome of ["success", "failure"] as const) {
		test.each([
			"replacement address",
			"in-place address",
			"removed interface",
			"health exclusion",
			"hotspot exclusion",
			"new candidate",
		] as const)(`withholds stale ${outcome} after %s`, async (change) => {
			const table = new DefaultRouteTable(routes);
			await setDefaultRoute("uplink-a", { runner: table.runner });
			const before = table.orderedRows();
			expect(before).toHaveLength(routes.length + 1);
			table.mutations.length = 0;
			const current: Record<string, NetworkInterface> = {
				"uplink-a": netif("192.0.2.2"),
				"uplink-b": netif("198.51.100.2"),
			};
			let eligible = true;
			let validations = 0;
			const actions: string[] = [];
			const base = election(table);
			const entered = Promise.withResolvers<void>();
			const probe =
				Promise.withResolvers<
					Awaited<ReturnType<typeof base.probes.probeRepository>>
				>();
			const deps: GatewayElectionDeps = {
				...base,
				resolve: async () => ({
					addrs: ["203.0.113.10"],
					fromCache: false,
				}),
				validateDns: () => validations++,
				interfaces: () => current,
				eligible: (name) => name !== "uplink-b" || eligible,
				installRoute: async (name, family) => {
					actions.push(`install:${name}:${family}`);
					await base.installRoute(name, family);
				},
				releaseRoutes: async (condition) => {
					actions.push("release");
					await base.releaseRoutes?.(condition);
				},
				probes: {
					...base.probes,
					probeRepository: async (name) => {
						if (name !== "uplink-b") return base.probes.probeRepository(name);
						entered.resolve();
						return probe.promise;
					},
				},
			};
			const sweep = updateGw(deps);
			await entered.promise;
			switch (change) {
				case "replacement address":
					current["uplink-b"] = netif("198.51.100.3");
					break;
				case "in-place address":
					current["uplink-b"].ip = "198.51.100.3";
					break;
				case "removed interface":
					delete current["uplink-b"];
					break;
				case "health exclusion":
					eligible = false;
					break;
				case "hotspot exclusion":
					current["uplink-b"].error = NETIF_ERR_HOTSPOT;
					break;
				case "new candidate":
					current["uplink-c"] = netif("203.0.113.2");
					break;
			}
			probe.resolve(
				outcome === "success"
					? reachable
					: await base.probes.probeRepository("uplink-b"),
			);
			const result = await sweep;
			expect(table.mutations).toEqual([]);
			expect(actions).toEqual([]);
			expect(table.orderedRows()).toEqual(before);
			expect(validations).toBe(0);
			expect(result).toBe(false);
		});
	}

	test.each(["unchanged", "counters", "reordered", "disabled"] as const)(
		"accepts a current winner with %s records",
		async (change) => {
			const table = new DefaultRouteTable(routes);
			await setDefaultRoute("uplink-a", { runner: table.runner });
			table.mutations.length = 0;
			let current: Record<string, NetworkInterface> = {
				"uplink-a": netif("192.0.2.2"),
				"uplink-b": netif("198.51.100.2"),
			};
			const base = election(table);
			const entered = Promise.withResolvers<void>();
			const probe = Promise.withResolvers<typeof reachable>();
			const actions: string[] = [];
			let validations = 0;
			const deps: GatewayElectionDeps = {
				...base,
				resolve: async () => ({
					addrs: ["203.0.113.10"],
					fromCache: false,
				}),
				interfaces: () => current,
				validateDns: () => validations++,
				installRoute: async (name, family) => {
					actions.push(`install:${name}:${family}`);
					await base.installRoute(name, family);
				},
				probes: {
					...base.probes,
					probeRepository: async () => {
						entered.resolve();
						return probe.promise;
					},
				},
			};
			const sweep = updateGw(deps);
			await entered.promise;
			if (change === "counters") {
				current["uplink-b"].txb++;
				current["uplink-b"].rxb++;
			} else if (change === "reordered") {
				current = {
					"uplink-b": current["uplink-b"],
					"uplink-a": current["uplink-a"],
				};
			} else if (change === "disabled") {
				current["uplink-b"].enabled = false;
			}
			probe.resolve(reachable);
			expect(await sweep).toBe(true);
			expect(actions).toEqual(["install:uplink-b:4"]);
			expect(validations).toBe(1);
			expect(table.mutations).toHaveLength(1);
			expect(table.rows()).toEqual([...routes].sort());
		},
	);

	test.each(["known failure", "unknown"] as const)(
		"keeps current %s release semantics",
		async (outcome) => {
			const table = new DefaultRouteTable(routes);
			await setDefaultRoute("uplink-a", { runner: table.runner });
			const before = table.rows();
			table.mutations.length = 0;
			const base = election(table);
			let releases = 0;
			const deps: GatewayElectionDeps = {
				...base,
				interfaces: () => ({ "uplink-b": netif("198.51.100.2") }),
				releaseRoutes: async (condition) => {
					releases++;
					await base.releaseRoutes?.(condition);
				},
				probes: {
					...base.probes,
					probeRepository:
						outcome === "unknown"
							? async () => deriveVerdict([])
							: base.probes.probeRepository,
				},
			};
			expect(await updateGw(deps)).toBe(false);
			expect(releases).toBe(outcome === "known failure" ? 1 : 0);
			expect(table.mutations).toHaveLength(outcome === "known failure" ? 1 : 0);
			expect(table.rows()).toEqual(
				outcome === "known failure" ? [...routes].sort() : before,
			);
		},
	);

	const boundaries = [
		"startup",
		"queue",
		"inventory",
		"candidate",
		"fib",
	] as const;
	for (const boundary of boundaries) {
		for (const outcome of ["success", "failure"] as const) {
			if (
				outcome === "failure" &&
				(boundary === "candidate" || boundary === "fib")
			)
				continue;
			for (const change of [
				"replacement",
				"in-place",
				"removed",
				"excluded",
				"hotspot",
				"added",
				"throws",
				"unchanged",
				"counters",
				"reordered",
				"disabled",
			] as const) {
				test(`${outcome} at ${boundary} respects ${change} roster`, async () => {
					const native = spyOn(Bun, "spawn").mockImplementation(() => {
						throw new Error("native runner forbidden");
					});
					const table = new DefaultRouteTable(
						boundary === "candidate" ? [BASELINE[0]] : BASELINE,
					);
					const entered = Promise.withResolvers<void>();
					const resume = Promise.withResolvers<void>();
					const dispatched = Promise.withResolvers<void>();
					let armed = false;
					const runner: typeof table.runner = async (bin, args, ...rest) => {
						const candidateLookup =
							args.includes("table") && args.includes("uplink-b");
						const answer = candidateLookup
							? BASELINE[1]
							: await table.runner(bin, args, ...rest);
						const matches =
							boundary === "startup"
								? args.includes("-6") && args.includes("show")
								: boundary === "candidate"
									? candidateLookup
									: boundary === "fib"
										? args.includes("get")
										: !args.includes("-6") &&
											args.includes("show") &&
											!args.includes("table");
						if (armed && matches) {
							armed = false;
							entered.resolve();
							await resume.promise;
						}
						return answer;
					};
					const owner = new GatewayRoutePreference(runner);
					let startup: Promise<void> | undefined;
					let queued: Promise<void> | undefined;
					let sweep: Promise<boolean> | undefined;
					try {
						if (boundary === "startup") {
							// Prime startup independently: its captured inventory is empty, so it cannot delete these later fixture rows.
							armed = true;
							startup = owner.start();
							await entered.promise;
							table.routes
								.get(4)
								?.add(
									"default via 198.51.100.1 dev uplink-b proto 242 metric 36",
								);
						} else {
							await owner.start();
							await setDefaultRoute("uplink-b", { runner });
							if (boundary === "queue") {
								// This earlier no-op captures only its retained winner, before the obsolete row is added.
								armed = true;
								queued = setDefaultRoute("uplink-b", { runner });
								await entered.promise;
							}
						}
						table.routes
							.get(4)
							?.add(
								"default via 203.0.113.1 dev old-uplink proto 242 metric 50",
							);
						const before = table.orderedRows();
						table.mutations.length = 0;
						let current: Record<string, NetworkInterface> = {
							"uplink-a": netif("192.0.2.2"),
							"uplink-b": netif("198.51.100.2"),
						};
						let eligible = true,
							throwing = false,
							validations = 0;
						const base = election(table);
						const deps: GatewayElectionDeps = {
							...base,
							resolve: async () => ({
								addrs: ["203.0.113.10"],
								fromCache: false,
							}),
							interfaces: () => current,
							eligible: (name) => {
								if (throwing) throw new Error("changed roster unavailable");
								return name !== "uplink-b" || eligible;
							},
							validateDns: () => {
								validations++;
							},
							installRoute: async (name, family, admit?: () => boolean) => {
								dispatched.resolve();
								await owner.apply(name, family, admit);
							},
							releaseRoutes: async (condition, admit?: () => boolean) => {
								dispatched.resolve();
								if (condition) await owner.release(condition, admit);
								else await owner.apply(undefined, 4, admit);
							},
							probes: {
								...base.probes,
								probeRepository: (name) =>
									outcome === "success" && name === "uplink-b"
										? Promise.resolve(reachable)
										: base.probes.probeRepository(name),
							},
						};
						if (boundary !== "startup" && boundary !== "queue") armed = true;
						sweep = updateGw(deps);
						if (boundary === "startup" || boundary === "queue")
							await dispatched.promise;
						else await entered.promise;
						switch (change) {
							case "replacement":
								current["uplink-b"] = netif("198.51.100.3");
								break;
							case "in-place":
								current["uplink-b"].ip = "198.51.100.3";
								break;
							case "removed":
								delete current["uplink-b"];
								break;
							case "excluded":
								eligible = false;
								break;
							case "hotspot":
								current["uplink-b"].error = NETIF_ERR_HOTSPOT;
								break;
							case "added":
								current["uplink-c"] = netif("203.0.113.2");
								break;
							case "throws":
								throwing = true;
								break;
							case "counters":
								current["uplink-b"].txb++;
								current["uplink-b"].rxb++;
								break;
							case "reordered":
								current = {
									"uplink-b": current["uplink-b"],
									"uplink-a": current["uplink-a"],
								};
								break;
							case "disabled":
								current["uplink-b"].enabled = false;
								break;
							case "unchanged":
								break;
						}
						resume.resolve();
						const result = await sweep;
						await startup;
						await queued;
						const stale = ![
							"unchanged",
							"counters",
							"reordered",
							"disabled",
						].includes(change);
						if (stale) {
							expect(table.mutations).toEqual([]);
							expect(table.orderedRows()).toEqual(before);
							expect(result).toBe(false);
							expect(validations).toBe(0);
							if (
								boundary === "queue" &&
								change === "replacement" &&
								outcome === "success"
							) {
								// The withheld transaction must not poison the same runner's queue tail.
								expect(await updateGw(deps)).toBe(true);
								expect(table.mutations).toHaveLength(1);
							}
						} else {
							expect(result).toBe(outcome === "success");
							expect(validations).toBe(outcome === "success" ? 1 : 0);
							expect(table.mutations).toHaveLength(
								outcome === "success" ? 1 : 2,
							);
							for (const row of boundary === "candidate"
								? [BASELINE[0]]
								: BASELINE)
								expect(table.rows()).toContain(row);
						}
						expect(native).not.toHaveBeenCalled();
					} finally {
						resume.resolve();
						await Promise.allSettled(
							[startup, queued, sweep].filter((value) => value !== undefined),
						);
						native.mockRestore();
					}
				});
			}
		}
	}

	test("roster changes after the first write do not suppress rollback", async () => {
		const native = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("native runner forbidden");
		});
		const old = "default via 192.0.2.1 dev uplink-a proto 242 metric 35";
		const table = new DefaultRouteTable(BASELINE);
		let applying = false,
			allowed = true,
			checked = 0;
		const runner: typeof table.runner = async (bin, args, ...rest) => {
			if (applying && args.includes("get")) return BASELINE[0];
			const result = await table.runner(bin, args, ...rest);
			if (applying && table.mutations.length > 0) allowed = false;
			return result;
		};
		try {
			const owner = new GatewayRoutePreference(runner);
			await owner.start();
			table.routes.get(4)?.add(old);
			const before = table.orderedRows();
			applying = true;
			await expect(
				owner.apply("uplink-b", 4, () => {
					checked++;
					return allowed;
				}),
			).rejects.toThrow();
			expect(checked).toBe(1);
			expect(allowed).toBe(false);
			expect(table.mutations).toHaveLength(4);
			expect(table.orderedRows()).toEqual(before);
			expect(native).not.toHaveBeenCalled();
		} finally {
			native.mockRestore();
		}
	});

	test("natural release condition remains independent of ordinary admission", async () => {
		const native = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("native runner forbidden");
		});
		const table = new DefaultRouteTable(BASELINE);
		try {
			const owner = new GatewayRoutePreference(table.runner);
			await owner.apply("uplink-b");
			const before = table.orderedRows();
			table.mutations.length = 0;
			await expect(
				owner.release(
					() => false,
					() => true,
				),
			).rejects.toThrow();
			await expect(
				owner.release(
					() => true,
					() => false,
				),
			).rejects.toThrow();
			expect(table.mutations).toEqual([]);
			expect(table.orderedRows()).toEqual(before);
			await owner.release(
				() => true,
				() => true,
			);
			expect(table.mutations).toHaveLength(1);
			expect(table.rows()).toEqual([...BASELINE].sort());
			expect(native).not.toHaveBeenCalled();
		} finally {
			native.mockRestore();
		}
	});
});
