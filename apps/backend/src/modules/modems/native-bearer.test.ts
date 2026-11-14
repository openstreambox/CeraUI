import { expect, test } from "bun:test";
import {
	type DbusTransport,
	type DbusValue,
	type MethodCall,
	variant,
} from "@ceralive/modem-control/transport";
import { parseNativeBearerIp, readNativeBearer } from "./native-bearer.ts";

const ipv6: DbusValue = [
	["method", variant("u", 2)],
	["address", variant("s", "2001:db8:1::2")],
	["prefix", variant("u", 64)],
	["gateway", variant("s", "fe80::1")],
	["dns", variant("as", ["2001:db8::53"])],
	["mtu", variant("u", 1428)],
];
test("native IP configuration retains the actual family, DNS, gateway and MTU", () => {
	expect(parseNativeBearerIp(ipv6, 6)).toEqual({
		family: 6,
		method: "static",
		address: "2001:db8:1::2",
		prefix: 64,
		gateway: "fe80::1",
		dns: ["2001:db8::53"],
		mtu: 1428,
	});
	expect(parseNativeBearerIp([], 4)).toBeUndefined();
	expect(() => parseNativeBearerIp(ipv6, 4)).toThrow();
	expect(() => parseNativeBearerIp([["method", variant("s", 2)]], 6)).toThrow(
		"property type",
	);
	expect(() =>
		parseNativeBearerIp(
			[
				["method", variant("u", 2)],
				["dns", variant("as", ["resolver.example"])],
			],
			6,
		),
	).toThrow("DNS");
});
test("only one connected bearer on the exact interface is observed; a new SIM cannot inherit it", async () => {
	let connected = false,
		current = true,
		count = 0;
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
		subscribeSignal: async () => ({ unsubscribe: async () => {} }),
		callMethod: async (call) => {
			calls.push(call);
			if (call.member === "GetNameOwner")
				return { signature: "s", body: [":1.19"] };
			if (call.member === "Get")
				return {
					signature: "v",
					body: [variant("ao", ["/org/freedesktop/ModemManager1/Bearer/1"])],
				};
			return {
				signature: "a{sv}",
				body: [
					[
						["Connected", variant("b", true)],
						["Interface", variant("s", "wwan0")],
						["Ip6Config", variant("a{sv}", ipv6)],
					],
				],
			};
		},
	};
	const guard = async () => {
		count++;
		return current;
	};
	const first = await readNativeBearer(3, "wwan0", guard, () => transport);
	expect(first?.ipv4).toBeUndefined();
	expect(first?.ipv6?.dns).toEqual(["2001:db8::53"]);
	expect(count).toBe(2);
	expect(connected).toBe(false);
	expect(
		calls
			.filter((call) => call.member !== "GetNameOwner")
			.every((call) => call.destination === ":1.19"),
	).toBe(true);
	current = false;
	calls.length = 0;
	expect(
		await readNativeBearer(3, "wwan0", guard, () => transport),
	).toBeUndefined();
	expect(calls).toEqual([]);
	count = 0;
	expect(
		await readNativeBearer(
			3,
			"wwan0",
			async () => ++count === 1,
			() => transport,
		),
	).toBeUndefined();
	expect(connected).toBe(false);
});
