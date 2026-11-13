import { expect, test } from "bun:test";
import {
	type DbusTransport,
	type SignalEvent,
	type SignalListener,
	type SignalSpec,
	variant,
} from "@ceralive/modem-control/transport";
import { CellularGrantLifetime } from "./cellular-grant-lifetime.ts";

const NM = "org.freedesktop.NetworkManager",
	MM = "org.freedesktop.ModemManager1";
const paths = [
	`/org/freedesktop/ModemManager1/Modem/1`,
	`/org/freedesktop/ModemManager1/SIM/1`,
	`/org/freedesktop/ModemManager1/Bearer/1`,
	`/org/freedesktop/NetworkManager/IP6Config/1`,
] as const;
function fixture() {
	let connected = false,
		withdrawals = 0,
		duringSubscribe = false;
	let disconnected: () => void = () => {};
	const subscriptions: { spec: SignalSpec; listener: SignalListener }[] = [];
	const bus: DbusTransport = {
		connect: async () => {
			connected = true;
		},
		disconnect: async () => {
			connected = false;
			disconnected();
		},
		isConnected: () => connected,
		on: (event, callback) => {
			if (event === "disconnected") disconnected = callback;
		},
		off: () => {},
		subscriptionCount: () => subscriptions.length,
		subscribeSignal: async (spec, listener) => {
			subscriptions.push({ spec, listener });
			if (duringSubscribe && spec.member === "PropertiesChanged")
				listener({
					path: paths[0],
					sender: ":1.10",
					interface: spec.interface,
					member: spec.member,
					signature: "sa{sv}as",
					body: [`${MM}.Modem`, [["Sim", variant("o", paths[1])]], []],
				});
			return { unsubscribe: async () => {} };
		},
		callMethod: async (call) => {
			if (call.member !== "GetNameOwner") throw new Error("Unexpected write");
			return {
				signature: "s",
				body: [call.args?.[0] === MM ? ":1.10" : ":1.20"],
			};
		},
	};
	const owner = new CellularGrantLifetime(
		() => {
			withdrawals++;
		},
		() => bus,
	);
	const emit = (event: SignalEvent) => {
		for (const { spec, listener } of subscriptions)
			if (
				spec.member === event.member &&
				spec.interface === event.interface &&
				(!spec.sender || spec.sender === event.sender)
			)
				listener(event);
	};
	const properties = (
		iface: string,
		names: string[],
		path = paths[3],
		invalidated = false,
	) =>
		emit({
			path,
			sender: iface.startsWith(NM) ? ":1.20" : ":1.10",
			interface: "org.freedesktop.DBus.Properties",
			member: "PropertiesChanged",
			signature: "sa{sv}as",
			body: [
				iface,
				invalidated
					? []
					: names.map((name) => [name, variant("s", "synthetic")]),
				invalidated ? names : [],
			],
		});
	return {
		owner,
		emit,
		properties,
		withdrawals: () => withdrawals,
		disconnect: () => {
			connected = false;
			disconnected();
		},
		duringSubscribe: () => {
			duringSubscribe = true;
		},
	};
}
test("grant lifetime captures unique owners before selecting exact paths and ignores radio-only updates", async () => {
	const f = fixture();
	await f.owner.start();
	expect(f.owner.select(paths)).toBe(true);
	expect(f.owner.owner(MM)).toBe(":1.10");
	expect(f.owner.owner(NM)).toBe(":1.20");
	f.properties(`${MM}.Modem`, ["SignalQuality"], paths[0]);
	f.properties(`${MM}.Modem.Modem3gpp`, ["OperatorCode"], paths[0]);
	f.properties(
		`${NM}.IP6Config`,
		["AddressData"],
		"/org/freedesktop/NetworkManager/IP6Config/99",
	);
	expect(f.owner.current).toBe(true);
	expect(f.withdrawals()).toBe(0);
	await f.owner.close();
	expect(f.owner.current).toBe(false);
	expect(f.withdrawals()).toBe(1);
});
test("same-path lease, resolver, SIM and bearer changes revoke synchronously and only once", async () => {
	for (const [iface, field, path] of [
		[`${NM}.IP6Config`, "AddressData", paths[3]],
		[`${NM}.IP6Config`, "Nameservers", paths[3]],
		[`${MM}.Modem`, "Sim", paths[0]],
		[`${MM}.Sim`, "Imsi", paths[1]],
		[`${MM}.Bearer`, "Ip6Config", paths[2]],
	] as const) {
		const f = fixture();
		await f.owner.start();
		f.owner.select(paths);
		f.properties(iface, [field], path, true);
		expect(f.owner.current).toBe(false);
		expect(f.withdrawals()).toBe(1);
		f.properties(iface, [field], path);
		expect(f.withdrawals()).toBe(1);
		await f.owner.close();
	}
});
test("service replacement, exact object removal and disconnect invalidate the retained observation", async () => {
	for (const kind of ["service", "object", "disconnect"]) {
		const f = fixture();
		await f.owner.start();
		f.owner.select(paths);
		if (kind === "service")
			f.emit({
				path: "/org/freedesktop/DBus",
				sender: "org.freedesktop.DBus",
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				signature: "sss",
				body: [NM, ":1.20", ":1.21"],
			});
		else if (kind === "object")
			f.emit({
				path: "/org/freedesktop/ModemManager1",
				sender: ":1.10",
				interface: "org.freedesktop.DBus.ObjectManager",
				member: "InterfacesRemoved",
				signature: "oas",
				body: [paths[2], [`${MM}.Bearer`]],
			});
		else f.disconnect();
		expect(f.owner.current).toBe(false);
		expect(f.owner.select(paths)).toBe(false);
		await f.owner.close();
	}
});
test("a change during watcher installation cannot be legitimized by selecting paths afterwards", async () => {
	const f = fixture();
	f.duringSubscribe();
	await expect(f.owner.start()).rejects.toThrow("changed during capture");
	expect(f.owner.select(paths)).toBe(false);
	expect(f.withdrawals()).toBe(1);
});
test("malformed watched property payload refuses authority rather than ignoring an unknown change", async () => {
	const f = fixture();
	await f.owner.start();
	f.owner.select(paths);
	f.emit({
		path: paths[3],
		sender: ":1.20",
		interface: "org.freedesktop.DBus.Properties",
		member: "PropertiesChanged",
		signature: "sa{sv}as",
		body: [`${NM}.IP6Config`, [["Nameservers", "wrong-variant"]], []],
	});
	expect(f.owner.current).toBe(false);
	await f.owner.close();
});
