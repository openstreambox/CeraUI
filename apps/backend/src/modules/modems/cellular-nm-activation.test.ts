import { expect, test } from "bun:test";
import {
	type DbusTransport,
	type DbusValue,
	type MethodCall,
	type SignalListener,
	variant,
} from "@ceralive/modem-control/transport";
import { readCellularNmActivation } from "./cellular-nm-activation.ts";

const device = "/org/freedesktop/NetworkManager/Devices/7",
	active = "/org/freedesktop/NetworkManager/ActiveConnection/4",
	target = { id: 2, ifname: "wwan0" };
function fixture() {
	let connected = false,
		state = 100,
		uuid = "synthetic-profile",
		managed = true,
		udi = "/org/freedesktop/ModemManager1/Modem/2",
		duplicate = false,
		current = true,
		changeOwner = false,
		changeState = false,
		reads = 0;
	let listener: SignalListener = () => {};
	const calls: MethodCall[] = [];
	const transport: DbusTransport = {
		connect: async () => {
			connected = true;
		},
		disconnect: async () => {
			connected = false;
		},
		isConnected: () => connected,
		on: () => {},
		off: () => {},
		subscriptionCount: () => 1,
		subscribeSignal: async (_match, callback) => {
			listener = callback;
			return { unsubscribe: async () => {} };
		},
		callMethod: async (call) => {
			calls.push(call);
			if (call.member === "GetNameOwner")
				return { signature: "s", body: [":1.17"] };
			if (call.member === "GetDevices")
				return {
					signature: "ao",
					body: [
						[
							device,
							...(duplicate
								? ["/org/freedesktop/NetworkManager/Devices/8"]
								: []),
						],
					],
				};
			if (call.member !== "GetAll") throw new Error("Unexpected mutation");
			if (call.path === active)
				return {
					signature: "a{sv}",
					body: [
						[
							["Uuid", variant("s", uuid)],
							["State", variant("u", 2)],
							["Devices", variant("ao", [device])],
						],
					],
				};
			reads++;
			if (changeOwner && reads === 2)
				listener({
					sender: "org.freedesktop.DBus",
					path: "/org/freedesktop/DBus",
					interface: "org.freedesktop.DBus",
					member: "NameOwnerChanged",
					signature: "sss",
					body: ["org.freedesktop.NetworkManager", ":1.17", ":1.18"],
				});
			if (changeState && reads === 3) state = 30;
			const props: DbusValue = [
				["Udi", variant("s", udi)],
				["Interface", variant("s", "cdc-wdm0")],
				["IpInterface", variant("s", state === 30 ? "" : "wwan0")],
				["Managed", variant("b", managed)],
				["State", variant("u", state)],
				["ActiveConnection", variant("o", state === 30 ? "/" : active)],
			];
			return { signature: "a{sv}", body: [props] };
		},
	};
	return {
		calls,
		read: () =>
			readCellularNmActivation(
				target,
				"synthetic-profile",
				async () => current,
				() => transport,
			),
		set: (value: {
			state?: number;
			uuid?: string;
			managed?: boolean;
			udi?: string;
			duplicate?: boolean;
			current?: boolean;
			changeOwner?: boolean;
			changeState?: boolean;
		}) => {
			if (value.state !== undefined) state = value.state;
			if (value.uuid !== undefined) uuid = value.uuid;
			if (value.managed !== undefined) managed = value.managed;
			if (value.udi !== undefined) udi = value.udi;
			if (value.duplicate !== undefined) duplicate = value.duplicate;
			if (value.current !== undefined) current = value.current;
			if (value.changeOwner !== undefined) changeOwner = value.changeOwner;
			if (value.changeState !== undefined) changeState = value.changeState;
		},
	};
}
test("activation read identifies the actual modem-backed NM device and exact active UUID", async () => {
	const f = fixture();
	expect(await f.read()).toEqual({ service: ":1.17", device, state: "active" });
	expect(new Set(f.calls.map((call) => call.member))).toEqual(
		new Set(["GetNameOwner", "GetDevices", "GetAll"]),
	);
	expect(
		f.calls
			.filter((call) => call.member !== "GetNameOwner")
			.every((call) => call.destination === ":1.17"),
	).toBe(true);
});
test("a positively disconnected modem remains readable with an empty IP interface", async () => {
	const f = fixture();
	f.set({ state: 30 });
	expect(await f.read()).toEqual({ service: ":1.17", device, state: "idle" });
	expect(f.calls.some((call) => call.path === active)).toBe(false);
});
test("unknown, foreign, ambiguous and changing activations grant no state authority", async () => {
	for (const value of [
		{ state: 40 },
		{ state: 110 },
		{ uuid: "other-profile" },
		{ managed: false },
		{ udi: "/org/freedesktop/ModemManager1/Modem/9" },
		{ duplicate: true },
		{ current: false },
		{ changeState: true },
	]) {
		const f = fixture();
		f.set(value);
		expect(await f.read()).toBeUndefined();
	}
	const owner = fixture();
	owner.set({ changeOwner: true });
	await expect(owner.read()).rejects.toThrow(
		"Unknown NM activation projection",
	);
});
