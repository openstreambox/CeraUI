import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { inventoryCellularHosts } from "./cellular-host-inventory.ts";
import {
	CellularIpv6Bootstrap,
	type CellularIpv6BootstrapDeps,
} from "./cellular-ipv6-bootstrap.ts";
import {
	cellularIpv6BootstrapKey,
	cellularIpv6BootstrapRoutes,
	parseCellularIpv6BootstrapPlan,
} from "./cellular-ipv6-bootstrap-plan.ts";
import {
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "./cellular-native-host-plan.ts";
import type { CellularDnsResult } from "./cellular-path-probe.ts";

const plan = parseCellularIpv6BootstrapPlan({
	owner: "a".repeat(64),
	epoch: "grant-one",
	slot: 1,
	physical: {
		ifname: "wwan0",
		ifindex: "17",
		usbDevice: "synthetic-usb",
		netDevice: "synthetic-net",
		generation: "one",
	},
	bootId: "11111111-1111-1111-1111-111111111111",
	source: "2001:db8:1::2",
	gateway: "fe80::1",
	mtu: 1280,
	dns: ["2001:db8::53"],
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "cellular-ipv6-bootstrap-")),
		store = { dir },
		key = cellularIpv6BootstrapKey(plan.slot),
		events: string[] = [],
		installed = new Set<string>();
	let mode: "probe" | "withdrawn" | "absent" = "absent",
		current = true,
		consumers = true,
		allowance = true,
		bootId = plan.bootId;
	let probe: ((signal: AbortSignal) => Promise<CellularDnsResult>) | undefined;
	const deps: CellularIpv6BootstrapDeps = {
		store,
		get bootId() {
			return bootId;
		},
		owned: () => true,
		currentNow: () => current,
		current: async () => current,
		reserve: async (bytes) => {
			expect(bytes).toBe(32768);
			events.push("reserve");
			return allowance;
		},
		consumersReleased: async () => consumers,
		probe: async (path, signal) => {
			events.push("probe");
			expect(path).toMatchObject({
				source: plan.source,
				device: plan.physical.ifname,
				ifindex: 17,
				dns: plan.dns,
			});
			return probe ? probe(signal) : { ok: true, nat64: "64:ff9b::/96" };
		},
		effects: (_plan, _routes, _current, writable) => ({
			fence: {
				inspect: async () => mode,
				create: async (next) => {
					expect(writable()).toBe(true);
					expect(await readPrivateJson(store, key)).toMatchObject({
						cursor: 1,
					});
					mode = next;
					events.push(`fence-${next}`);
				},
				transition: async (next) => {
					expect(writable()).toBe(true);
					mode = next;
					events.push(`fence-${next}`);
				},
				remove: async () => {
					expect(writable()).toBe(true);
					mode = "absent";
					events.push("fence-remove");
					return true;
				},
			},
			ip: {
				inspect: async (effect) =>
					installed.has(JSON.stringify(effect)) ? "owned" : "absent",
				apply: async (effect) => {
					expect(writable()).toBe(true);
					installed.add(JSON.stringify(effect));
					events.push("ip-add");
				},
				remove: async (effect) => {
					expect(writable()).toBe(true);
					installed.delete(JSON.stringify(effect));
					events.push("ip-remove");
					return true;
				},
			},
		}),
	};
	return {
		host: new CellularIpv6Bootstrap(plan, deps),
		store,
		key,
		deps,
		events,
		installed,
		set: (state: {
			current?: boolean;
			consumers?: boolean;
			allowance?: boolean;
			bootId?: string;
			probe?: (signal: AbortSignal) => Promise<CellularDnsResult>;
		}) => {
			if (state.current !== undefined) current = state.current;
			if (state.consumers !== undefined) consumers = state.consumers;
			if (state.allowance !== undefined) allowance = state.allowance;
			if (state.bootId !== undefined) bootId = state.bootId;
			if (state.probe) probe = state.probe;
		},
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
test("DNS discovery owns only grant-specific routes and reserves budget before its single source/device probe", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		expect(f.events[0]).toBe("fence-withdrawn");
		expect(await f.host.discover()).toBe("64:ff9b::/96");
		expect(f.events.indexOf("reserve")).toBeLessThan(f.events.indexOf("probe"));
		expect(await f.host.discover()).toBeUndefined();
		expect(f.events.filter((event) => event === "probe")).toHaveLength(1);
		expect(await f.host.cleanup()).toBe(true);
		expect(f.installed.size).toBe(0);
		expect(await readPrivateJson(f.store, f.key)).toBeUndefined();
		expect(f.events.at(-1)).toBe("fence-remove");
		const routes = cellularIpv6BootstrapRoutes(plan);
		expect(routes.table).toBe(260001);
		expect(
			routes.effects.every(
				(effect) => effect.family === 6 && !effect.selector.includes("default"),
			),
		).toBe(true);
		for (const rule of routes.effects.filter(
			(effect) => effect.kind === "rule",
		))
			expect(rule.selector).toContain(`${plan.dns[0]}/128`);
	} finally {
		await f.close();
	}
});
test("abort is not socket closure: withdrawal denies before waiting for the actual probe promise", async () => {
	const f = await fixture();
	let finish: (result: CellularDnsResult) => void = () => {},
		started: () => void = () => {},
		aborted = false;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	f.set({
		probe: (signal) => {
			started();
			signal.addEventListener("abort", () => {
				aborted = true;
			});
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	try {
		await f.host.install();
		const discovery = f.host.discover();
		await entered;
		expect(await f.host.cleanup()).toBe(false);
		expect(aborted).toBe(true);
		expect(f.events.at(-1)).toBe("fence-withdrawn");
		expect(f.events).not.toContain("ip-remove");
		finish({ ok: true, nat64: "64:ff9b::/96" });
		expect(await discovery).toBeUndefined();
		f.set({ consumers: false });
		expect(await f.host.cleanup()).toBe(false);
		f.set({ consumers: true });
		expect(await f.host.cleanup()).toBe(true);
	} finally {
		await f.close();
	}
});
test("no allowance, revoked observation or another boot cannot issue a discovery query", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		f.set({ allowance: false });
		expect(await f.host.discover()).toBeUndefined();
		expect(f.events).not.toContain("probe");
		f.set({ current: false });
		expect(await f.host.valid()).toBe(false);
		expect(await f.host.cleanup()).toBe(true);
	} finally {
		await f.close();
	}
	const g = await fixture();
	try {
		await g.host.install();
		g.set({ bootId: "22222222-2222-2222-2222-222222222222" });
		expect(await g.host.discover()).toBeUndefined();
		expect(g.events).not.toContain("probe");
		await expect(g.host.cleanup()).rejects.toThrow("another lifetime");
		expect(g.events).not.toContain("ip-remove");
	} finally {
		await g.close();
	}
});
test("a native host slot cannot be overlapped or adopted as a discovery baseline", async () => {
	const f = await fixture();
	try {
		const n = parseCellularNativeHostPlan({
				input: {
					owner: plan.owner,
					epoch: "old-native",
					slot: 1,
					iface: "wwan0",
					ipv4: "192.0.2.2",
					mtu: 1280,
				},
				bootId: plan.bootId,
				ifindex: 17,
				dns: [],
			}),
			steps = cellularNativeHostSteps(n);
		await writePrivateJson(f.store, cellularUplinkSlotKey(1), {
			version: 1,
			owner: n.input.owner,
			epoch: n.input.epoch,
			plan: n,
			steps,
			cursor: steps.length,
			phase: "active",
		});
		await expect(f.host.install()).rejects.toThrow("slot remains owned");
		expect(f.events).toEqual([]);
		expect(await readPrivateJson(f.store, f.key)).toBeUndefined();
	} finally {
		await f.close();
	}
});

test("bootstrap authority rejects nonroutable sources, mapped DNS, ambiguous resolvers and misplaced slots", async () => {
	for (const changed of [
		{ source: "fe80::2" },
		{ source: "::ffff:192.0.2.2" },
		{ gateway: "::1" },
		{ dns: ["::ffff:192.0.2.53"] },
		{ dns: ["::1"] },
		{ dns: ["ff02::1"] },
		{ dns: ["2001:db8::53", "2001:0DB8:0:0::53"] },
		{ dns: [] },
		{ physical: { ...plan.physical, ifname: "lo" } },
	])
		expect(() =>
			parseCellularIpv6BootstrapPlan({ ...plan, ...changed }),
		).toThrow();
	const captured = parseCellularIpv6BootstrapPlan(plan);
	expect(Object.isFrozen(captured)).toBe(true);
	expect(Object.isFrozen(captured.physical)).toBe(true);
	expect(Object.isFrozen(captured.dns)).toBe(true);
	const f = await fixture();
	try {
		await f.host.install();
		const original = await readPrivateJson(f.store, f.key);
		await writePrivateJson(f.store, cellularIpv6BootstrapKey(2), original);
		await expect(inventoryCellularHosts(f.store)).rejects.toThrow(
			"slot identity",
		);
		expect(await readPrivateJson(f.store, f.key)).toEqual(original);
	} finally {
		await f.close();
	}
});
test("native and discovery cursors cannot coexist in one slot even with coherent individual records", async () => {
	const f = await fixture();
	try {
		await f.host.install();
		const n = parseCellularNativeHostPlan({
				input: {
					owner: plan.owner,
					epoch: "native",
					slot: 1,
					iface: "wwan0",
					ipv4: "192.0.2.2",
					mtu: 1280,
				},
				bootId: plan.bootId,
				ifindex: 17,
				dns: [],
			}),
			steps = cellularNativeHostSteps(n);
		await writePrivateJson(f.store, cellularUplinkSlotKey(1), {
			version: 1,
			owner: n.input.owner,
			epoch: n.input.epoch,
			plan: n,
			steps,
			cursor: steps.length,
			phase: "active",
		});
		await expect(inventoryCellularHosts(f.store)).rejects.toThrow("overlap");
	} finally {
		await f.close();
	}
});
