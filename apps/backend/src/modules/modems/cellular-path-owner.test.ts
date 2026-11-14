import { beforeEach, expect, test } from "bun:test";
import {
	cellularSourceReady,
	resetCellularSourcesForTest,
} from "../network/cellular-source-state.ts";
import {
	CellularPathOwner,
	type CellularPathSession,
} from "./cellular-path-owner.ts";

beforeEach(resetCellularSourcesForTest);
function fixture() {
	let now = 0,
		valid = true,
		budget = true,
		verdict: "ok" | "failed" | "unavailable" = "ok",
		clean = true,
		reconnect = true,
		fence = true,
		validError = false;
	const events: string[] = [];
	const session: CellularPathSession = {
		binding: {
			source: "192.0.2.2",
			device: "wwan0",
			translated: false,
			generation: "grant-one",
		},
		dns: { device: "wwan0", source: "192.0.2.2", dns: ["192.0.2.53"] },
		valid: async () => {
			if (validError) throw new Error("identity read unavailable");
			return valid;
		},
		prepareProbe: async () => {
			events.push("probe-fence");
			return fence;
		},
		setReady: async (value) => {
			events.push(`ready-fence-${value}`);
			return fence;
		},
		cancelProbe: () => {
			events.push("cancel-probe");
		},
		cleanup: async () => {
			events.push("cleanup");
			return clean;
		},
	};
	const path = new CellularPathOwner("a".repeat(64), "usb-one", "wwan0", {
		now: () => now,
		reserve: async () => {
			events.push("reserve");
			return budget ? { remaining: 1024 * 1024 } : undefined;
		},
		capable: async () => true,
		install: async () => {
			events.push("install");
			return session;
		},
		probe: async () => {
			events.push("probe");
			return verdict;
		},
		reconnect: async () => {
			events.push("reconnect");
			return reconnect;
		},
		passiveHealthy: () => false,
	});
	return {
		path,
		events,
		set: (value: {
			now?: number;
			valid?: boolean;
			budget?: boolean;
			verdict?: typeof verdict;
			clean?: boolean;
			reconnect?: boolean;
			fence?: boolean;
			validError?: boolean;
		}) => {
			if (value.now !== undefined) now = value.now;
			if (value.valid !== undefined) valid = value.valid;
			if (value.budget !== undefined) budget = value.budget;
			if (value.verdict !== undefined) verdict = value.verdict;
			if (value.clean !== undefined) clean = value.clean;
			if (value.reconnect !== undefined) reconnect = value.reconnect;
			if (value.fence !== undefined) fence = value.fence;
			if (value.validError !== undefined) validError = value.validError;
		},
		observe: () => path.observe({ generation: "one", grant: {} }),
	};
}
test("a granted source is unpublished until a reserved, bound traffic probe passes", async () => {
	const f = fixture();
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	await f.observe();
	expect(f.events).toEqual([
		"install",
		"reserve",
		"probe-fence",
		"probe",
		"ready-fence-true",
	]);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(true);
	f.set({ now: 100_000 });
	await f.observe();
	expect(f.events.filter((event) => event === "probe")).toHaveLength(1);
});
test("a 50-second USB outage withdraws without carrier failures or reconnect, then settles", async () => {
	const f = fixture();
	await f.observe();
	f.set({ now: 1000 });
	await f.path.observe({});
	expect(f.path.availability).toBe("usb-wait");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(f.path.health.failures).toBe(0);
	f.set({ now: 51_000 });
	await f.observe();
	expect(f.path.availability).toBe("settling");
	f.set({ now: 66_000 });
	await f.observe();
	expect(f.path.availability).toBe("present");
	expect(f.events).not.toContain("reconnect");
});
test("failure hysteresis waits for capped backoff and lease refusal cannot force a reconnect", async () => {
	const f = fixture();
	f.set({ verdict: "failed" });
	await f.observe();
	expect(f.path.health.failures).toBe(1);
	f.set({ now: 30_000 });
	await f.observe();
	expect(f.path.health.reconnects).toBe(1);
	expect(f.events).not.toContain("reconnect");
	f.set({ now: 89_999 });
	await f.observe();
	expect(f.events).not.toContain("reconnect");
	f.set({ now: 90_000, reconnect: false });
	await f.observe();
	expect(f.events.at(-1)).toBe("reconnect");
	f.set({ now: 90_001 });
	await f.observe();
	expect(f.events.filter((event) => event === "reconnect")).toHaveLength(1);
});
test("budget exhaustion and missing probe capability do not count as carrier failures", async () => {
	const f = fixture();
	f.set({ budget: false });
	await f.observe();
	expect(f.events).not.toContain("probe");
	expect(f.path.health.failures).toBe(0);
	const g = fixture();
	g.set({ verdict: "unavailable" });
	await g.observe();
	expect(g.path.health.failures).toBe(0);
	expect(g.events).not.toContain("reconnect");
});

test("availability loss during an awaited probe cannot republish the withdrawn generation", async () => {
	let finish: (value: "ok") => void = () => {};
	const result = new Promise<"ok">((resolve) => {
		finish = resolve;
	});
	const session: CellularPathSession = {
		binding: {
			source: "192.0.2.2",
			device: "wwan0",
			translated: false,
			generation: "grant-one",
		},
		dns: { device: "wwan0", source: "192.0.2.2", dns: [] },
		valid: async () => true,
		prepareProbe: async () => true,
		setReady: async () => true,
		cancelProbe: () => {},
		cleanup: async () => true,
	};
	let probing: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		probing = resolve;
	});
	const owner = new CellularPathOwner("a".repeat(64), "usb-one", "wwan0", {
		now: () => 0,
		reserve: async () => ({ remaining: 1024 * 1024 }),
		capable: async () => true,
		install: async () => session,
		probe: async () => {
			probing();
			return result;
		},
		reconnect: async () => true,
		passiveHealthy: () => false,
	});
	const pending = owner.observe({ generation: "one", grant: {} });
	await started;
	await owner.observe({});
	finish("ok");
	await pending;
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(owner.health.failures).toBe(0);
});

test("a lost address grant on a present USB device cannot retain old readiness", async () => {
	const f = fixture();
	await f.observe();
	await f.path.observe({ generation: "one" });
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(f.path.health.ready).toBe(false);
	expect(f.path.availability).toBe("present");
	expect(f.path.health.failures).toBe(0);
	expect(f.events.at(-1)).toBe("cleanup");
});

test("a fresh persistent daily allowance is not trapped behind an exhausted in-memory balance", async () => {
	let now = 0,
		probes = 0;
	const session: CellularPathSession = {
		binding: {
			source: "192.0.2.2",
			device: "wwan0",
			translated: false,
			generation: "grant-one",
		},
		dns: { device: "wwan0", source: "192.0.2.2", dns: [] },
		valid: async () => true,
		prepareProbe: async () => true,
		setReady: async () => true,
		cancelProbe: () => {},
		cleanup: async () => true,
	};
	const owner = new CellularPathOwner("a".repeat(64), "usb-one", "wwan0", {
		now: () => now,
		reserve: async () => ({ remaining: 0 }),
		capable: async () => true,
		install: async () => session,
		probe: async () => {
			probes++;
			return "ok";
		},
		reconnect: async () => true,
		passiveHealthy: () => false,
	});
	await owner.observe({ generation: "one", grant: {} });
	expect(owner.health.budgetRemaining).toBe(0);
	now = 86_400_000;
	await owner.observe({ generation: "one", grant: {} });
	expect(probes).toBe(2);
});

test("a failed host fence is unavailable rather than a carrier failure and cannot publish readiness", async () => {
	const f = fixture();
	f.set({ fence: false });
	await f.observe();
	expect(f.events).not.toContain("probe");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(f.path.health.failures).toBe(0);
});

test("a throwing identity reader withdraws old readiness and cancels the active probe", async () => {
	const f = fixture();
	await f.observe();
	f.set({ now: 300_000, validError: true });
	await expect(f.observe()).rejects.toThrow("identity read unavailable");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(f.path.health.failures).toBe(0);
	expect(f.events).toContain("cancel-probe");
	expect(f.events.at(-1)).toBe("ready-fence-false");
});
