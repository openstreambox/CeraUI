/*
  The diversity check acts on a physical radio, under the lock Wi-Fi uses for
  that radio's current owner.

  The adapter lock key is an owner mapping: a radio with a hotspot profile is
  owned by a composite `mac@...` key, and a Limited radio is not keyed by its
  MAC at all. Tracking state and profile matching therefore follow the verified
  physical identity (permanent MAC + sampled lifetime), while every write takes
  the lock the current row resolves to and re-checks the row there. These cases
  run the live registry projection, the real adapter lock and its re-check over
  a fake NetworkManager.
*/

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as credentials from "../modules/wifi/hotspot-credentials.ts";
import { admitWifiAdapter } from "../modules/wifi/wifi-adapter-admission.ts";
import {
	ownsWifiAdapterLock,
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import {
	beginWifiOperatorChoice,
	createLiveWifiNetworkDiversity,
	type DiversityProfile,
	WIFI_CHOSEN_NETWORK_PRIORITY,
	WIFI_DIVERSITY,
	WIFI_DIVERSITY_TICK_MS,
	type WifiNetworkDiversity,
} from "../modules/wifi/wifi-network-diversity.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import {
	type SeedRadio,
	seedWifiRadios,
} from "./helpers/wifi-verified-radios.ts";

const A = "02:00:00:00:a0:01";
const B = "02:00:00:00:b0:02";
const COMPOSITE = `${A}@usb-1`;
const HOTSPOT = "00000000-0000-4000-8000-0000000000c1";
const N1 = "Lab-Net-1";
const N2 = "Lab-Net-2";
const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
const MARK = WIFI_CHOSEN_NETWORK_PRIORITY;
const MIN = 60_000;

const stationA = {
	saved: { [N1]: A1, [N2]: A2 },
	savedAll: { [N1]: [A1], [N2]: [A2] },
};
const stationB = {
	saved: { [N1]: B1, [N2]: B2 },
	savedAll: { [N1]: [B1], [N2]: [B2] },
};
// A also owns a hotspot profile, so its lock is the composite owner.
const ownedA = { ...stationA, hotspot: { conn: HOTSPOT } };

function radios(a: Partial<SeedRadio> = {}): SeedRadio[] {
	return [
		{
			ifname: "wlA",
			mac: A,
			ifindex: 21,
			phy: 1,
			row: ownedA as Partial<WifiInterface>,
			...a,
		},
		{ ifname: "wlB", mac: B, ifindex: 22, phy: 2, row: stationB },
	];
}

/** A fake NetworkManager behind the live registry, lock and re-check. */
class Nm {
	clock = 0;
	links = new Map<string, string | null>([
		["wlA", A2],
		["wlB", B2],
	]);
	profiles = new Map<string, DiversityProfile>([
		[A1, { priority: MARK, mac: A }],
		[A2, { priority: 0, mac: A }],
		[B1, { priority: 0, mac: B }],
		[B2, { priority: MARK, mac: B }],
	]);
	air: Record<string, Record<string, number>> = {
		wlA: { [N1]: 70, [N2]: 70 },
		wlB: { [N1]: 70, [N2]: 70 },
	};
	log: string[] = [];
	/** Whether each write or activation ran holding A's current owner lock. */
	underLock: boolean[] = [];
	afterScan: (ifname: string, count: number) => Promise<void> | void = () => {};
	diversity: WifiNetworkDiversity = createLiveWifiNetworkDiversity({
		readLinks: async () => new Map(this.links),
		readProfile: async (uuid) => this.profiles.get(uuid),
		setPriority: async (uuid, priority) => {
			this.log.push(`priority ${uuid} ${priority}`);
			this.underLock.push(this.holdsOwnerOf(uuid));
			const old = this.profiles.get(uuid);
			if (old) this.profiles.set(uuid, { ...old, priority });
			return true;
		},
		scan: async (ifname) => {
			this.log.push(`scan ${ifname}`);
			const seen = new Map(Object.entries(this.air[ifname] ?? {}));
			await this.afterScan(ifname, this.scans(ifname).length);
			return seen;
		},
		activate: async (uuid, ifname) => {
			this.log.push(`activate ${uuid} ${ifname}`);
			this.underLock.push(this.holdsOwnerOf(uuid));
			this.links.set(ifname, uuid);
			return true;
		},
		listed: () => new Map(),
		now: () => this.clock,
	});

	holdsOwnerOf(uuid: string) {
		const mac = this.profiles.get(uuid)?.mac;
		return mac !== undefined && ownsWifiAdapterLock(wifiAdapterLockKey(mac));
	}

	async run(ms: number) {
		const end = this.clock + ms;
		while (this.clock < end) {
			this.clock += WIFI_DIVERSITY_TICK_MS;
			await this.diversity.tick();
		}
	}

	scans(ifname: string) {
		return this.log.filter((line) => line === `scan ${ifname}`);
	}

	writes() {
		return this.log.filter((line) => line.startsWith("priority"));
	}

	activations() {
		return this.log.filter((line) => line.startsWith("activate"));
	}
}

let seeded: Awaited<ReturnType<typeof seedWifiRadios>>;
let owners: Record<string, string[]> = {};

beforeEach(async () => {
	owners = { [HOTSPOT]: [COMPOSITE] };
	spyOn(credentials, "getHotspotCredentialOwners").mockImplementation(
		(uuid?: string) => [...(owners[uuid ?? ""] ?? [])],
	);
	seeded = await seedWifiRadios();
	await seeded.publish(radios());
});

afterEach(async () => {
	await seeded.restore();
	(
		credentials.getHotspotCredentialOwners as unknown as {
			mockRestore(): void;
		}
	).mockRestore();
});

describe("one resolved lock for operator, move-back and AP reconciliation", () => {
	test("an operator join racing a move-back and an AP reconciliation writes once, under A's owner", async () => {
		const nm = new Nm();
		// Profiles are A's by its permanent MAC; a sole radio's lock is that
		// plain address, whatever port its profile names.
		expect(wifiAdapterLockKey(A)).toBe(A);
		const choice = beginWifiOperatorChoice(A, nm.diversity);
		// The join is in flight: the move-back leaves A alone.
		await nm.run(5 * MIN);
		expect(nm.scans("wlA")).toEqual([]);
		// AP reconciliation takes the same owner lock the registry resolves for A
		// while the join settles and records the operator's choice of N2.
		await withWifiAdapterLock(wifiAdapterLockKey(A), async () => {
			await choice.record(A2);
			choice.release();
			await nm.run(2 * MIN);
			expect(nm.log).toEqual([]);
		});
		// Once the owner is free the deferred choice is written under it.
		await nm.run(WIFI_DIVERSITY_TICK_MS);
		expect(nm.writes().sort()).toEqual(
			[`priority ${A1} 0`, `priority ${A2} ${MARK}`].sort(),
		);
		expect(nm.underLock).toEqual([true, true]);
		// The operator's choice stands: A is not moved back to N1.
		await nm.run(20 * MIN);
		expect(nm.activations()).toEqual([]);
	});

	test("a choice made while the move-back holds the lock stops its move", async () => {
		const nm = new Nm();
		let choice: ReturnType<typeof beginWifiOperatorChoice> | undefined;
		nm.afterScan = async (ifname, count) => {
			// The confirming scan: the move-back holds A's owner lock right now.
			if (ifname !== "wlA" || count !== 2 || choice) return;
			choice = beginWifiOperatorChoice(A, nm.diversity);
			await choice.record(A2);
			choice.release();
		};
		await nm.run(10 * MIN);
		expect(choice).toBeDefined();
		expect(nm.activations()).toEqual([]);
		// The choice could not take the held lock; it landed on the next tick.
		expect(nm.writes().sort()).toEqual(
			[`priority ${A1} 0`, `priority ${A2} ${MARK}`].sort(),
		);
		expect(nm.underLock).toEqual([true, true]);
	});

	test("a deferred choice never overwrites a newer one", async () => {
		const nm = new Nm();
		const first = beginWifiOperatorChoice(A, nm.diversity);
		await withWifiAdapterLock(wifiAdapterLockKey(A), async () => {
			await first.record(A2);
			first.release();
		});
		// The operator changes their mind before the deferred write is retried.
		const second = beginWifiOperatorChoice(A, nm.diversity);
		const recorded = second.record(A1);
		await nm.run(WIFI_DIVERSITY_TICK_MS);
		await recorded;
		second.release();
		await nm.run(WIFI_DIVERSITY_TICK_MS);
		expect(nm.profiles.get(A1)?.priority).toBe(MARK);
		expect(nm.profiles.get(A2)?.priority).toBe(0);
		expect(nm.writes()).toEqual([]);
	});

	test("the move-back itself runs under A's current owner lock", async () => {
		const nm = new Nm();
		await nm.run(5 * MIN);
		expect(nm.activations()).toEqual([`activate ${A1} wlA`]);
		expect(nm.underLock).toEqual([true]);
	});
});

describe("only the current publication of a radio is acted on", () => {
	test("mid-discovery the stale verified sample admits nothing and the tick defers", async () => {
		const nm = new Nm();
		await nm.run(2 * WIFI_DIVERSITY_TICK_MS);
		// A discovery pass invalidated the publication; the old sample remains.
		seeded.invalidate();
		expect(wifiRadioIdentity.state.rows.get("wlA")?.classification).toBe(
			"verified",
		);
		expect(admitWifiAdapter(A)).toBeUndefined();
		// An operator choice made now is deferred, not dropped and not written.
		const choice = beginWifiOperatorChoice(A, nm.diversity);
		await choice.record(A2);
		choice.release();
		await nm.run(5 * MIN);
		expect(nm.log).toEqual([]);
		// Republished: the deferred choice is written under A's owner lock.
		await seeded.republish();
		await nm.run(WIFI_DIVERSITY_TICK_MS);
		expect(nm.writes().sort()).toEqual(
			[`priority ${A1} 0`, `priority ${A2} ${MARK}`].sort(),
		);
		expect(nm.underLock).toEqual([true, true]);
	});

	test("the deferred tick keeps its state and moves once republished", async () => {
		const nm = new Nm();
		seeded.invalidate();
		await nm.run(5 * MIN);
		expect(nm.log).toEqual([]);
		await seeded.republish();
		await nm.run(5 * MIN);
		expect(nm.activations()).toEqual([`activate ${A1} wlA`]);
	});

	test("a netif replugged under the same name before the move is not moved", async () => {
		const nm = new Nm();
		nm.afterScan = (ifname, count) => {
			// Between the confirming scan and the activation; nothing republished.
			if (ifname === "wlA" && count === 2)
				seeded.sysfs(radios({ ifindex: 31 }));
		};
		await nm.run(10 * MIN);
		expect(nm.scans("wlA").length).toBeGreaterThanOrEqual(2);
		expect(nm.activations()).toEqual([]);
	});

	test("a netif replugged under the same name before a choice is written gets no write", async () => {
		const nm = new Nm();
		const choice = beginWifiOperatorChoice(A, nm.diversity);
		seeded.sysfs(radios({ ifindex: 31 }));
		await choice.record(A2);
		choice.release();
		await nm.run(2 * MIN);
		expect(nm.writes()).toEqual([]);
		// Discovery catches up: a new radio, and the choice is not carried over.
		await seeded.publish(radios({ ifindex: 31 }));
		await nm.run(2 * WIFI_DIVERSITY_TICK_MS);
		expect(nm.writes()).toEqual([]);
	});
});

describe("a replacement radio starts over", () => {
	test("a radio replaced during the join receives none of its choice", async () => {
		const nm = new Nm();
		const choice = beginWifiOperatorChoice(A, nm.diversity);
		// Replugged: same name, same MAC, new lifetime and row.
		await seeded.publish(radios({ ifindex: 31 }));
		await choice.record(A2);
		choice.release();
		expect(nm.writes()).toEqual([]);
	});

	test("a deferred choice is dropped when its radio is replaced", async () => {
		const nm = new Nm();
		const choice = beginWifiOperatorChoice(A, nm.diversity);
		await withWifiAdapterLock(wifiAdapterLockKey(A), async () => {
			await choice.record(A2);
			choice.release();
			await seeded.publish(radios({ ifindex: 31 }));
		});
		await nm.run(WIFI_DIVERSITY_TICK_MS);
		expect(nm.writes()).toEqual([]);
	});

	test("a replacement does not inherit its predecessor's parking", async () => {
		const nm = new Nm();
		nm.air.wlA = { [N1]: 50, [N2]: 50 };
		for (let i = 0; i < 400; i++) {
			await nm.run(WIFI_DIVERSITY_TICK_MS);
			// NM drops A from the weak AP1 within a tick and falls back.
			if (nm.links.get("wlA") === A1) nm.links.set("wlA", A2);
		}
		const parked = nm.activations().length;
		expect(parked).toBe(WIFI_DIVERSITY.parkAfterReverts);
		await nm.run(5 * MIN);
		expect(nm.activations()).toHaveLength(parked);
		// Same name and MAC, new lifetime: a different physical radio to track.
		await seeded.publish(radios({ ifindex: 31 }));
		await nm.run(3 * MIN);
		expect(nm.activations()).toHaveLength(parked + 1);
		expect(nm.activations().at(-1)).toBe(`activate ${A1} wlA`);
	});
});

describe("a Limited radio is never tracked or written", () => {
	// A second netdev on A's phy makes both Limited, with a coherent address.
	const limited = (): SeedRadio[] => [
		...radios(),
		{ ifname: "wlA2", mac: A, ifindex: 23, phy: 1 },
	];

	test("no move-back, no migration and no recorded choice", async () => {
		const rows = await seeded.publish(limited());
		const key = Object.keys(rows).find(
			(k) => rows[k]?.ifname === "wlA",
		) as string;
		expect(key).toBe("limited:21:1");
		const nm = new Nm();
		await nm.run(WIFI_DIVERSITY.migrationWindowMs + MIN);
		for (const registryKey of [key, A]) {
			const choice = beginWifiOperatorChoice(registryKey, nm.diversity);
			await choice.record(A2);
			choice.release();
		}
		await nm.run(MIN);
		expect(nm.scans("wlA")).toEqual([]);
		expect(nm.log).toEqual([]);
	});

	test("a choice deferred while verified is not written once the radio is Limited", async () => {
		const nm = new Nm();
		const choice = beginWifiOperatorChoice(A, nm.diversity);
		await withWifiAdapterLock(wifiAdapterLockKey(A), async () => {
			await choice.record(A2);
			choice.release();
			await seeded.publish(limited());
		});
		await nm.run(5 * MIN);
		expect(nm.log).toEqual([]);
	});
});
