/// <reference types="bun" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EffectOwner } from "../helpers/effect-owner.ts";
import { logger } from "../helpers/logger.ts";
import * as time from "../helpers/time.ts";
import * as events from "../modules/events/emit.ts";
import {
	type GatewayElectionDeps,
	NO_INTERNET_NOTIFICATION,
	updateGwWrapper,
} from "../modules/network/gateways.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";

afterEach(() => {
	notificationRemove(NO_INTERNET_NOTIFICATION);
	mock.restore();
});

const nic = (ip: string) => ({
	ip,
	tp: 0,
	txb: 0,
	rxb: 0,
	enabled: true,
	error: 0,
});

/**
 * An election that finds a better uplink and parks on its repository probe,
 * so a test can let requesters come, go and end while it is in flight.
 */
function election(options: { readonly elects?: boolean } = {}) {
	const installed: Array<[string, number]> = [];
	let released = 0;
	const probing = Promise.withResolvers<void>();
	const probe = Promise.withResolvers<void>();
	const elects = options.elects ?? true;
	const deps: GatewayElectionDeps = {
		canRouteClients: async () => true,
		resolve: async () => ({ addrs: ["203.0.113.10"], fromCache: true }),
		validateDns: () => {},
		checkConnectivity: async () => elects,
		interfaces: () => ({
			"uplink-a": nic("192.0.2.2"),
			"uplink-b": nic("198.51.100.2"),
		}),
		eligible: () => true,
		defaultInterface: async () => "uplink-a",
		installRoute: async (ifname, family) => {
			installed.push([ifname, family]);
		},
		releaseRoutes: async () => {
			released++;
		},
		probes: {
			probeRepository: async (ifname) => {
				probing.resolve();
				await probe.promise;
				return deriveVerdict([
					{
						origin: {
							url: "https://packages.example.test",
							host: "packages.example.test",
							scheme: "https",
							probeUrl: "https://packages.example.test/",
						},
						ipv4: elects && ifname === "uplink-b" ? "ok" : "no_route",
						ipv6: "no_route",
					},
				]);
			},
			probeViaDevice: async () => elects,
			probeViaSourceIp: async () => elects,
		},
	};
	return {
		deps,
		installed,
		released: () => released,
		/** The election is in flight, at its probe. */
		probing: probing.promise,
		finishProbe: () => probe.resolve(),
	};
}

/** A requester that can end, as a package install does. */
function requester() {
	let ended = false;
	const owner: EffectOwner = { ended: () => ended };
	return {
		owner,
		end() {
			ended = true;
		},
	};
}

describe("the shared gateway election and who asked for it", () => {
	test("every requester has ended: no route is written, and the next election writes it", async () => {
		// Given: an install asks for the election, and another joins it in flight.
		const h = election();
		const first = requester();
		const second = requester();
		const run = updateGwWrapper(true, h.deps, first.owner);
		await h.probing;
		expect(updateGwWrapper(true, h.deps, second.owner)).toBe(run);
		// When: both have ended before the election reaches its route write.
		first.end();
		second.end();
		h.finishProbe();
		// Then: it reports no repair and leaves the route as it was.
		expect(await run).toBe(false);
		expect(h.installed).toEqual([]);
		// The host still gets its route: the election stays queued, and the
		// network module's next pass (which asks for nobody) writes it.
		const next = election();
		next.finishProbe();
		const now = time.getms();
		spyOn(time, "getms").mockReturnValue(now + 60 * 60_000);
		expect(await updateGwWrapper(false, next.deps)).toBe(true);
		expect(next.installed).toEqual([["uplink-b", 4]]);
	});

	test("an ended install and the network module's own request: the route is written", async () => {
		// Given: an install started the election; the network module joined it.
		const h = election();
		const install = requester();
		const run = updateGwWrapper(true, h.deps, install.owner);
		await h.probing;
		expect(updateGwWrapper(true, h.deps)).toBe(run);
		// When: the install ends before the route write.
		install.end();
		h.finishProbe();
		// Then: the election is still wanted, by the host itself.
		expect(await run).toBe(true);
		expect(h.installed).toEqual([["uplink-b", 4]]);
	});

	test("the network module's election, joined by an install that ends: the route is written", async () => {
		const h = election();
		const install = requester();
		const run = updateGwWrapper(true, h.deps);
		await h.probing;
		expect(updateGwWrapper(true, h.deps, install.owner)).toBe(run);
		install.end();
		h.finishProbe();
		expect(await run).toBe(true);
		expect(h.installed).toEqual([["uplink-b", 4]]);
	});

	test("one install ended, another still waits for it: the route is written", async () => {
		const h = election();
		const ended = requester();
		const waiting = requester();
		const run = updateGwWrapper(true, h.deps, ended.owner);
		await h.probing;
		expect(updateGwWrapper(true, h.deps, waiting.owner)).toBe(run);
		ended.end();
		h.finishProbe();
		expect(await run).toBe(true);
		expect(h.installed).toEqual([["uplink-b", 4]]);
	});

	test("an install that has not ended gets its route as before", async () => {
		const h = election();
		const install = requester();
		const run = updateGwWrapper(true, h.deps, install.owner);
		await h.probing;
		h.finishProbe();
		expect(await run).toBe(true);
		expect(h.installed).toEqual([["uplink-b", 4]]);
	});

	test("requesters of one election do not carry over to the next", async () => {
		// Given: an election only an ended install asked for.
		const h = election();
		const install = requester();
		const run = updateGwWrapper(true, h.deps, install.owner);
		await h.probing;
		install.end();
		h.finishProbe();
		expect(await run).toBe(false);
		// When: a live install asks for the next one.
		const next = election();
		const live = requester();
		const again = updateGwWrapper(true, next.deps, live.owner);
		await next.probing;
		next.finishProbe();
		// Then: only the new requester counts.
		expect(await again).toBe(true);
		expect(next.installed).toEqual([["uplink-b", 4]]);
	});

	test("nothing is elected and every requester has ended: no route is released either", async () => {
		// Given: no uplink answers, which would release the host's routes.
		// (The host notes that it is offline, as in any election.)
		spyOn(logger, "warn").mockImplementation(() => logger);
		spyOn(events, "emitEvent").mockImplementation(() => {});
		const h = election({ elects: false });
		const install = requester();
		const run = updateGwWrapper(true, h.deps, install.owner);
		await h.probing;
		install.end();
		h.finishProbe();
		expect(await run).toBe(false);
		expect(h.released()).toBe(0);
		expect(h.installed).toEqual([]);
	});
});
