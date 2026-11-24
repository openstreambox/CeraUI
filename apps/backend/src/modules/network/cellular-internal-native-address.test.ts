import { expect, test } from "bun:test";
import {
	DurableInverse,
	type DurableInverseRecord,
} from "../../helpers/durable-inverse.ts";
import {
	createInternalNativeAddressEffects,
	type InternalNativeAddressPlan,
} from "./cellular-internal-native-address.ts";

function fixture() {
	const plan: InternalNativeAddressPlan = {
		input: { iface: "wwan0", ipv4: "192.0.2.10" },
		ifindex: 17,
		bootId: "11111111-1111-4111-8111-111111111111",
		ownedAddress: {
			ifname: "wwan0",
			ifindex: "17",
			usbDevice: "usb",
			netDevice: "net",
			generation: "one",
		},
	};
	let present: "present" | "absent" | "foreign" | "unknown" = "present",
		installed = false,
		owned = true,
		ack = true,
		lostReply = false;
	let disk: DurableInverseRecord<InternalNativeAddressPlan> | undefined;
	const events: string[] = [];
	const address = createInternalNativeAddressEffects(
		plan,
		plan.bootId,
		() => owned,
		{
			identity: async () => present,
			read: async () =>
				JSON.stringify([
					{
						ifname: "wwan0",
						ifindex: 17,
						addr_info: installed
							? [
									{
										family: "inet",
										local: "192.0.2.10",
										prefixlen: 32,
										scope: "global",
										noprefixroute: true,
										valid_life_time: 0xffffffff,
										preferred_life_time: 0xffffffff,
									},
								]
							: [],
					},
				]),
			write: async (index, effect, operation) => {
				expect(index).toBe(17);
				expect(effect).toEqual({
					kind: "address",
					family: 4,
					address: "192.0.2.10",
					prefix: 32,
				});
				expect(disk?.cursor).toBe(1);
				events.push(operation);
				installed = operation === "add";
				if (lostReply) {
					lostReply = false;
					throw new Error("reply lost");
				}
				return true;
			},
		},
	);
	if (!address) throw new Error("Missing synthetic address adapter");
	const deps = {
		read: async () => structuredClone(disk),
		write: async (value: typeof disk) => {
			events.push("durable");
			disk = structuredClone(value);
		},
		parsePlan: () => plan,
		steps: () => ["address"],
		current: async () => present === "present",
		inspect: async () => address.inspect(),
		apply: async () => address.apply(),
		remove: async () => {
			if (!(await address.remove())) throw new Error("not removed");
		},
		withdraw: () => {
			events.push("withdraw");
		},
		fence: async () => {
			events.push("fence");
		},
		consumersReleased: async () => ack,
	};
	return {
		plan,
		events,
		owner: new DurableInverse(deps),
		replay: () => new DurableInverse(deps),
		disk: () => disk,
		installed: () => installed,
		set: (values: {
			owned?: boolean;
			present?: typeof present;
			installed?: boolean;
			ack?: boolean;
			lostReply?: boolean;
		}) => {
			if (values.owned !== undefined) owned = values.owned;
			if (values.present) present = values.present;
			if (values.installed !== undefined) installed = values.installed;
			if (values.ack !== undefined) ack = values.ack;
			if (values.lostReply !== undefined) lostReply = values.lostReply;
		},
	};
}
const owner = "a".repeat(64);
test("internal IPv4 uses a durable /32 step and waits for consumer withdrawal before deletion", async () => {
	const f = fixture();
	await f.owner.create(owner, "one", f.plan);
	expect(f.events.slice(0, 3)).toEqual(["durable", "durable", "add"]);
	f.set({ ack: false });
	expect(await f.owner.cleanup(owner, "one")).toBe(false);
	expect(f.installed()).toBe(true);
	f.set({ ack: true });
	expect(await f.replay().cleanup(owner, "one")).toBe(true);
	expect(f.disk()).toBeUndefined();
	expect(f.installed()).toBe(false);
});
test("power loss after address dispatch replays the inverse, never the call", async () => {
	const f = fixture();
	f.set({ lostReply: true });
	await expect(f.owner.create(owner, "one", f.plan)).rejects.toThrow(
		"reply lost",
	);
	expect(f.disk()?.cursor).toBe(1);
	expect(await f.replay().cleanup(owner, "one")).toBe(true);
	expect(f.events.filter((e) => e === "add")).toHaveLength(1);
});
test("foreign matching addresses and reused interface names are never adopted or removed", async () => {
	const f = fixture();
	f.set({ installed: true });
	await expect(f.owner.create(owner, "one", f.plan)).rejects.toThrow(
		"occupied",
	);
	expect(f.disk()).toBeUndefined();
	const g = fixture();
	await g.owner.create(owner, "one", g.plan);
	g.set({ present: "foreign" });
	expect(await g.replay().cleanup(owner, "one")).toBe(false);
	expect(g.installed()).toBe(true);
	expect(g.events).not.toContain("del");
});
test("NetworkManager observations own no address and contradictory internal selectors refuse", () => {
	const f = fixture();
	const { ownedAddress, ...native } = f.plan;
	expect(
		createInternalNativeAddressEffects(native, f.plan.bootId, () => true),
	).toBeUndefined();
	expect(() =>
		createInternalNativeAddressEffects(
			{ ...f.plan, ifindex: 18 },
			f.plan.bootId,
			() => true,
		),
	).toThrow("Contradictory");
});

test("a released owner cannot remove its address even if an injected writer would allow it", async () => {
	const f = fixture();
	await f.owner.create(owner, "one", f.plan);
	f.set({ owned: false });
	expect(await f.replay().cleanup(owner, "one")).toBe(false);
	expect(f.events).not.toContain("del");
	expect(f.installed()).toBe(true);
});
