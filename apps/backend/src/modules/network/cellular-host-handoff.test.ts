import { expect, test } from "bun:test";
import {
	type CellularHandoffHooks,
	type CellularHandoffIO,
	CellularHostHandoff,
} from "./cellular-host-handoff.ts";
import type { CellularNmDevice } from "./cellular-nm-control.ts";

const owner = "a".repeat(64),
	link = {
		ifname: "wwan0",
		ifindex: "17",
		usbDevice: "synthetic-usb",
		netDevice: "synthetic-net",
		generation: "one",
	};
function fixture(
	original = { ra: "1" as "0" | "1", managed: true, up: false },
) {
	let ra: "0" | "1" | undefined = original.ra,
		managed = original.managed,
		up = original.up,
		disk: unknown,
		current = true,
		ack = true,
		failWrite = false,
		present = true;
	const events: string[] = [];
	const device: CellularNmDevice = {
		path: "/org/freedesktop/NetworkManager/Devices/1",
		iface: "wwan0",
		ipIface: "wwan0",
		udi: "synthetic-net",
		managed,
	};
	const io: CellularHandoffIO = {
		present: async () => present,
		readRaDefault: async () => ra,
		setRaDefault: async (_expected, value) => {
			events.push(`ra-${value}`);
			ra = value;
			return true;
		},
		readUp: async () => up,
		setUp: async (_expected, value) => {
			events.push(`up-${value}`);
			up = value;
			return true;
		},
		nm: {
			owner: ":1.17",
			devices: [device],
			valid: () => true,
			read: async () => ({ ...device, managed }),
			onRevoked: () => () => {},
			setManaged: async (_device, _expected, value) => {
				events.push(`managed-${value}`);
				managed = value;
				return true;
			},
			close: async () => {},
		},
	};
	const hooks: CellularHandoffHooks = {
		read: async () => disk,
		write: async (value) => {
			if (failWrite) throw new Error("durability failed");
			events.push(value ? `durable-${value.cursor}` : "retire");
			disk = structuredClone(value);
		},
		current: async () => current,
		withdraw: () => {
			events.push("withdraw");
		},
		fence: async () => {
			events.push("fence");
		},
		consumersReleased: async () => ack,
	};
	return {
		handoff: new CellularHostHandoff(owner, "one", link, io, hooks),
		events,
		io,
		hooks,
		disk: () => disk,
		set: (state: {
			current?: boolean;
			ack?: boolean;
			failWrite?: boolean;
			unknownRa?: boolean;
			present?: boolean;
		}) => {
			if (state.current !== undefined) current = state.current;
			if (state.ack !== undefined) ack = state.ack;
			if (state.failWrite !== undefined) failWrite = state.failWrite;
			if (state.unknownRa) ra = undefined;
			if (state.present !== undefined) present = state.present;
		},
	};
}
test("durable RA/NM handoff precedes link-up and exact inverse waits for consumer withdrawal", async () => {
	const f = fixture();
	await f.handoff.prepare();
	expect(f.events).toEqual([
		"durable-0",
		"durable-1",
		"ra-0",
		"durable-2",
		"managed-false",
	]);
	await f.handoff.prepareCall();
	expect(f.events.slice(-3)).toEqual(["durable-3", "up-true", "durable-3"]);
	f.set({ ack: false });
	const before = f.events.length;
	expect(await f.handoff.cleanup()).toBe(false);
	expect(f.events.slice(before)).toEqual(["withdraw", "durable-3", "fence"]);
	f.set({ ack: true, current: false });
	expect(await f.handoff.cleanup()).toBe(true);
	expect(f.events.filter((event) => /^(ra|up|managed)-/.test(event))).toEqual([
		"ra-0",
		"managed-false",
		"up-true",
		"up-false",
		"managed-true",
		"ra-1",
	]);
	expect(f.disk()).toBeUndefined();
});
test("an already guarded baseline stays unchanged; failed persistence and foreign state retain authority", async () => {
	const guarded = fixture({ ra: "0", managed: false, up: true });
	await guarded.handoff.prepare();
	await guarded.handoff.prepareCall();
	expect(await guarded.handoff.cleanup()).toBe(true);
	expect(guarded.events.some((event) => /^(ra|up|managed)-/.test(event))).toBe(
		false,
	);
	const f = fixture();
	f.set({ failWrite: true });
	await expect(f.handoff.prepare()).rejects.toThrow("durability failed");
	expect(f.events).toEqual([]);
	f.set({ failWrite: false });
	await f.handoff.prepare();
	f.set({ unknownRa: true });
	expect(await f.handoff.cleanup()).toBe(false);
	expect(f.disk()).toBeDefined();
	const g = fixture();
	await g.handoff.prepare();
	g.set({ present: false });
	expect(await g.handoff.cleanup()).toBe(false);
	expect(g.events).not.toContain("managed-true");
});
test("new physical generations and NM services cannot inherit old handoff setters", async () => {
	const f = fixture();
	await f.handoff.prepare();
	const other = new CellularHostHandoff(
		owner,
		"one",
		{ ...link, generation: "two" },
		f.io,
		f.hooks,
	);
	await expect(other.cleanup()).rejects.toThrow("another device");
	const replaced = new CellularHostHandoff(
		owner,
		"one",
		link,
		{ ...f.io, nm: { ...f.io.nm, owner: ":1.18" } },
		f.hooks,
	);
	expect(await replaced.cleanup()).toBe(false);
	expect(f.events).not.toContain("managed-true");
});
