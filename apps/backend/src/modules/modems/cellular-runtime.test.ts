import { beforeEach, expect, test } from "bun:test";
import {
	cellularSourceReady,
	resetCellularSourcesForTest,
} from "../network/cellular-source-state.ts";
import type { CellularDataGrant } from "./cellular-grant.ts";
import {
	CellularRuntime,
	type CellularRuntimeObservation,
} from "./cellular-runtime.ts";
import { CellularRuntimeSession } from "./cellular-runtime-session.ts";

beforeEach(resetCellularSourcesForTest);
function fixture(reservedSlots: () => readonly number[] = () => []) {
	let now = 0,
		clean = true,
		capable = true,
		installFails = false,
		retainFails = false,
		verdict: "ok" | "failed" = "ok";
	const events: string[] = [];
	const sessions: CellularRuntimeSession[] = [];
	const root = new CellularRuntime({
		now: () => now,
		reservedSlots,
		capable: async () => capable,
		reserve: async () => ({ remaining: 1024 * 1024 }),
		failure: () => {
			events.push("failure");
		},
		retain: (row, grant, slot, _sourceEpoch, hostEpoch, owned, currentNow) => {
			if (retainFails) throw new Error("factory unavailable");
			events.push(`retain-${row.owner[0]}-${slot}`);
			const session = new CellularRuntimeSession(grant, slot, hostEpoch, {
				current: async () => owned() && currentNow(),
				currentNow,
				withdraw: () => {},
				bootstrap: async () => undefined,
				consumersReleased: async () => clean,
				host: async (_prefix, released) => ({
					binding: {
						source: grant.source,
						device: row.iface,
						generation: hostEpoch,
						translated: false,
					},
					dns: { source: grant.source, device: row.iface, dns: grant.dns },
					install: async () => {
						events.push("install");
						if (installFails) throw new Error("uncertain kernel reply");
					},
					valid: async () => !installFails && currentNow(),
					prepareProbe: async () => true,
					setReady: async (ready) => {
						events.push(`ready-${ready}`);
						return true;
					},
					cancelProbe: () => {},
					cleanup: async () => {
						events.push("cleanup");
						return clean && (await released());
					},
				}),
				dns: async () => ({ ok: true }),
				https: async () => verdict,
				httpsPath: async () => ({
					source: grant.source,
					device: row.iface,
					ifindex: Number(grant.physical.ifindex),
				}),
			});
			sessions.push(session);
			return {
				session,
				finish: (complete) => {
					events.push(`finish-${complete}`);
				},
			};
		},
	});
	function observation(owner = "a", stamp = "one", iface = "wwan0") {
		let current = true;
		const grant: CellularDataGrant = {
			family: "ipv4",
			source: "192.0.2.2",
			mtu: 1428,
			dns: ["192.0.2.53"],
			generation: "grant-one",
			physical: {
				ifname: iface,
				ifindex: "17",
				usbDevice: "synthetic-usb",
				netDevice: "synthetic-net",
				generation: "usb-one",
			},
		};
		const value: CellularRuntimeObservation = {
			owner: owner.repeat(64),
			stamp,
			iface,
			linkId: "synthetic-link",
			physicalGeneration: "usb-one",
			grant,
			currentNow: () => current,
			current: async () => current,
			close: async () => {
				events.push(`close-${stamp}`);
				current = false;
			},
			reconnect: async (withdrawn) => {
				expect(withdrawn()).toBe(true);
				events.push("reconnect");
				return false;
			},
		};
		return value;
	}
	return {
		root,
		events,
		sessions,
		observation,
		set: (values: {
			now?: number;
			clean?: boolean;
			capable?: boolean;
			installFails?: boolean;
			retainFails?: boolean;
			verdict?: "ok" | "failed";
		}) => {
			if (values.verdict !== undefined) verdict = values.verdict;
			if (values.now !== undefined) now = values.now;
			if (values.clean !== undefined) clean = values.clean;
			if (values.capable !== undefined) capable = values.capable;
			if (values.installFails !== undefined) installFails = values.installFails;
			if (values.retainFails !== undefined) retainFails = values.retainFails;
		},
	};
}
test("runtime retains one actor and session for unchanged grants across fresh MM/NM snapshots", async () => {
	const f = fixture();
	await f.root.reconcile([f.observation()]);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(true);
	await f.root.reconcile([f.observation()]);
	expect(f.sessions).toHaveLength(1);
	expect(f.events.filter((event) => event === "install")).toHaveLength(1);
	expect(f.events).toContain("close-one");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(true);
});
test("a new SIM cannot claim the old interface while its retained inverse is incomplete", async () => {
	const f = fixture();
	await f.root.reconcile([f.observation()]);
	f.set({ clean: false });
	await f.root.reconcile([f.observation("b", "new-sim")]);
	expect(f.sessions).toHaveLength(1);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	f.set({ clean: true, now: 60000 });
	await f.root.reconcile([f.observation("b", "new-sim")]);
	expect(f.sessions).toHaveLength(2);
	expect(f.events).toContain("retain-b-1");
	expect(f.events).not.toContain("reconnect");
});
test("an uncertain install retains its exact session and slot until inverse retry succeeds", async () => {
	const f = fixture();
	f.set({ installFails: true, clean: false });
	await f.root.reconcile([f.observation()]);
	expect(f.sessions).toHaveLength(1);
	f.set({ now: 60000 });
	await f.root.reconcile([f.observation()]);
	expect(f.sessions).toHaveLength(1);
	f.set({ clean: true, installFails: false });
	await f.root.reconcile([f.observation()]);
	expect(f.sessions).toHaveLength(2);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(true);
});
test("immediate event revocation survives a stale successful probe/read and revalidates with a new lifetime", async () => {
	const f = fixture();
	await f.root.reconcile([f.observation()]);
	f.root.invalidate("wwan0");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(await f.sessions[0]?.valid()).toBe(false);
	f.set({ now: 60000 });
	await f.root.reconcile([f.observation()]);
	expect(f.sessions).toHaveLength(2);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(true);
});
test("a whole USB loss and 50-second return stays availability-only with settling", async () => {
	const f = fixture();
	await f.root.reconcile([f.observation()]);
	f.set({ now: 1000 });
	await f.root.reconcile([]);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	f.set({ now: 51000 });
	await f.root.reconcile([f.observation("a", "returned")]);
	expect(f.sessions).toHaveLength(1);
	f.set({ now: 66000 });
	await f.root.reconcile([f.observation("a", "returned")]);
	expect(f.sessions).toHaveLength(2);
	expect(f.events).not.toContain("reconnect");
});
test("missing producer capabilities withdraw current state and cannot install a replacement", async () => {
	const f = fixture();
	await f.root.reconcile([f.observation()]);
	f.set({ capable: false });
	await f.root.reconcile([f.observation()]);
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(f.sessions).toHaveLength(1);
});
test("ambiguous same-interface inventories revoke existing sources instead of choosing one SIM", async () => {
	const f = fixture();
	await f.root.reconcile([f.observation()]);
	await expect(
		f.root.reconcile([f.observation(), f.observation("b")]),
	).rejects.toThrow("Ambiguous");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
	expect(f.sessions).toHaveLength(1);
});

test("a missing grant on the same physical generation cannot erase carrier failure hysteresis", async () => {
	const f = fixture();
	f.set({ verdict: "failed" });
	await f.root.reconcile([f.observation()]);
	f.set({ now: 1000 });
	const { grant: _grant, ...missing } = f.observation("a", "missing-grant");
	await f.root.reconcile([missing]);
	f.set({ now: 60000 });
	await f.root.reconcile([f.observation()]);
	expect(f.events).not.toContain("reconnect");
	f.set({ now: 120000 });
	await f.root.reconcile([f.observation()]);
	expect(f.events.filter((event) => event === "reconnect")).toHaveLength(1);
});

test("native reconnect cannot run before the retained host and consumer inverse has finished", async () => {
	const f = fixture();
	f.set({ verdict: "failed" });
	await f.root.reconcile([f.observation()]);
	f.set({ now: 30_000 });
	await f.root.reconcile([f.observation()]);
	f.set({ now: 90_000, clean: false });
	await f.root.reconcile([f.observation()]);
	expect(f.events).not.toContain("reconnect");
	f.set({ now: 90_001, clean: true });
	await f.root.reconcile([f.observation()]);
	const reconnect = f.events.indexOf("reconnect");
	expect(reconnect).toBeGreaterThan(-1);
	expect(f.events.slice(0, reconnect).at(-1)).toBe("finish-true");
	expect(cellularSourceReady("wwan0", "192.0.2.2")).toBe(false);
});

test("a quarantined startup slot cannot starve a healthy actor or be reused by it", async () => {
	const f = fixture(() => [1]);
	await f.root.reconcile([f.observation("b", "healthy", "wwan1")]);
	expect(f.events).toContain("retain-b-2");
	expect(f.events).not.toContain("retain-b-1");
	expect(cellularSourceReady("wwan1", "192.0.2.2")).toBe(true);
});
