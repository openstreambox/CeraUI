/*
  Regression tests from the boot-wiring review: a replacement radio never
  inherits a join, stop() fences the last await, a publication gap keeps state,
  the runtime never writes after stop, and one radio cannot pass as two.
*/
import { afterEach, expect, test } from "bun:test";
import {
	type CoordinatorPorts,
	type RadioObservation,
	RoamingCoordinator,
} from "./coordinator.ts";
import { roamingBlocker, startRoaming } from "./runtime.ts";
import { protectRadiosFromScans, setScanGateModeReader } from "./scan-gate.ts";

afterEach(() => {
	protectRadiosFromScans([]);
	setScanGateModeReader(null);
});

const anchor = "02:00:00:00:00:01";
const target = "02:00:00:00:00:02";
const config = { enabled: true, radios: [{ id: "a" }, { id: "b" }] };

function fakeWorld() {
	const names = new Map([
		["a", { ifname: "wlan0", lifetime: "one" }],
		["b", { ifname: "wlan1", lifetime: "two" }],
	]);
	const held = new Set<string>();
	const scans: string[] = [];
	const joined: string[] = [];
	const ownerOf = (name: string) =>
		[...names].find(([, entry]) => entry.ifname === name)?.[0];
	const ports: CoordinatorPorts = {
		now: () => 0,
		resolve: (id) => names.get(id),
		observe: async (name): Promise<RadioObservation> => ({
			ifname: name,
			bssid: name === "wlan0" ? anchor : null,
			ssid: name === "wlan0" ? "venue" : null,
			signalDbm: name === "wlan0" ? -55 : null,
			address: name === "wlan0" ? "192.0.2.2/24" : null,
			gateway: name === "wlan0" ? "192.0.2.1" : null,
			routed: name === "wlan0",
			activation: null,
			activationRead: true,
			bssidLocked: false,
			phy: name,
			apOnPhy: false,
		}),
		scan: async (name) => {
			scans.push(name);
			return [{ ssid: "venue", bssid: target, quality: 95, channel: 36 }];
		},
		savedSsids: async () => new Set(["venue"]),
		join: async (name, _ssid, _bssid, mayActivate) => {
			if (!(await mayActivate())) return "refused";
			joined.push(ownerOf(name) ?? "unknown");
			return { activation: "owned-clone" };
		},
		abandon: async () => true,
		uplinkOf: async () => ({
			gateway: "192.0.2.1",
			gatewayMac: null,
			subnet: "192.0.2.0/24",
			egress: null,
		}),
		holderHealth: () => ({
			signalDbm: -55,
			attributedBps: null,
			encoderBps: null,
			nakRatio: null,
		}),
		otherUplinks: () => 0,
		radioMode: async (name) => ({ phy: name, apOnPhy: false }),
		// Like the production lock: the radio answering to the name must be the
		// identity the round meant.
		withRadioLock: async (name, expected, act) => {
			const documentedOwner = ownerOf(name);
			if (!documentedOwner) return { ok: false };
			if (expected && expected.id !== documentedOwner) return { ok: false };
			return {
				ok: true,
				value: await act(async () => ownerOf(name) === documentedOwner),
			};
		},
		holdOutOfBond: (name) => {
			held.add(name);
		},
		releaseBondHold: (name) => {
			held.delete(name);
		},
	};
	return { names, held, scans, joined, ports };
}

test("boot requires two distinct configured radios", () => {
	expect(
		roamingBlocker(
			{
				enabled: true,
				radios: [{ id: "00:11:22:33:44:55" }, { id: "00:11:22:33:44:55" }],
			},
			false,
		),
	).toBe("needs-two-client-radios");
});

test("one radio listed as a client and as the hotspot is refused", () => {
	expect(
		roamingBlocker(
			{
				enabled: true,
				radios: [
					{ id: "00:11:22:33:44:55" },
					{ id: "00:11:22:33:44:66" },
					{ id: "00:11:22:33:44:55", reserved: "hotspot" },
				],
			},
			false,
		),
	).toBe("duplicate-radio-ids");
});

test("a join still belongs to the radio that scanned when wlan1 is reused", async () => {
	const world = fakeWorld();
	const coordinator = new RoamingCoordinator(
		{
			...world.ports,
			savedSsids: async () => {
				world.names.set("b", { ifname: "wlan2", lifetime: "two" });
				world.names.set("new-radio", { ifname: "wlan1", lifetime: "three" });
				return new Set(["venue"]);
			},
		},
		config,
	);
	await coordinator.step();
	await coordinator.stop();
	expect(world.scans).toEqual(["wlan1"]);
	expect(world.joined).toEqual([]);
});

test("stop fences a scan whose final mode read is pending", async () => {
	const world = fakeWorld();
	const reachedModeRead = Promise.withResolvers<void>();
	const modeRead = Promise.withResolvers<{ phy: string; apOnPhy: boolean }>();
	const coordinator = new RoamingCoordinator(
		{
			...world.ports,
			radioMode: async () => {
				reachedModeRead.resolve();
				return modeRead.promise;
			},
		},
		config,
	);
	const round = coordinator.step();
	await reachedModeRead.promise;
	const stop = coordinator.stop();
	modeRead.resolve({ phy: "wlan1", apOnPhy: false });
	await Promise.all([round, stop]);
	expect(world.scans).toEqual([]);
});

test("a temporary publication gap preserves the join and its verification hold", async () => {
	const world = fakeWorld();
	let publishing = false;
	const coordinator = new RoamingCoordinator(
		{
			...world.ports,
			resolve: (id) => (publishing ? undefined : world.names.get(id)),
		},
		config,
	);
	await coordinator.step();
	expect(world.held.has("wlan1")).toBe(true);
	publishing = true;
	await coordinator.step();
	publishing = false;
	await coordinator.step();
	const stillHeld = world.held.has("wlan1");
	const ownedJoin = coordinator
		.status()
		.radios.find((radio) => radio.id === "b")?.joined;
	await coordinator.stop();
	expect(stillHeld).toBe(true);
	expect(ownedJoin).not.toBeNull();
});

test("stop drains a runtime round still polling before writing status", async () => {
	const world = fakeWorld();
	const poll = Promise.withResolvers<void>();
	const events: string[] = [];
	const runtime = startRoaming(
		config,
		() => ({
			ports: world.ports,
			sender: {
				poll: () => poll.promise,
				close: () => {
					events.push("close");
				},
			},
		}),
		{
			writeStatus: async () => {
				events.push("status");
			},
			appendJournal: async () => {},
		},
		() => ({ cancel: () => {} }),
	);
	const round = runtime.round();
	await runtime.stop();
	events.push("stopped");
	poll.resolve();
	await round;
	expect(events).toEqual(["close", "stopped"]);
});

test("a radio replaced during the mode read, after lock admission, is never scanned", async () => {
	const world = fakeWorld();
	const coordinator = new RoamingCoordinator(
		{
			...world.ports,
			radioMode: async (name) => {
				// The replug lands while the coordinator reads the mode.
				world.names.set("b", { ifname: "wlan2", lifetime: "two" });
				world.names.set("new-radio", { ifname: "wlan1", lifetime: "three" });
				return { phy: name, apOnPhy: false };
			},
		},
		config,
	);
	await coordinator.step();
	await coordinator.stop();
	expect(world.scans).toEqual([]);
	expect(coordinator.status().lastOutcome).toBe("radio-replaced");
});

test("a scan the lock does not admit never takes the radio out of the bond", async () => {
	const world = fakeWorld();
	const holds: string[] = [];
	const coordinator = new RoamingCoordinator(
		{
			...world.ports,
			withRadioLock: async () => ({ ok: false }),
			holdOutOfBond: (name) => {
				holds.push(name);
				world.ports.holdOutOfBond(name);
			},
		},
		config,
	);
	await coordinator.step();
	await coordinator.stop();
	expect(world.scans).toEqual([]);
	expect(holds).toEqual([]);
});
