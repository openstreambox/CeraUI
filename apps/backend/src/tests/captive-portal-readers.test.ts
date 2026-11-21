import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as dns from "node:dns";
import * as net from "node:net";
import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	TransportEvent,
} from "@ceralive/modem-control/transport";
import type { PortalReaderDeps } from "../modules/wifi/captive-portal-readers.ts";

const forbidden = mock(() => {
	throw new Error("native portal reader access forbidden");
});
const guards = [
	spyOn(Bun, "spawn").mockImplementation(forbidden),
	spyOn(Bun, "spawnSync").mockImplementation(forbidden),
	spyOn(Bun, "connect").mockImplementation(forbidden),
	spyOn(Bun, "listen").mockImplementation(forbidden),
	spyOn(Bun, "serve").mockImplementation(forbidden),
	spyOn(net, "connect").mockImplementation(forbidden),
	spyOn(net, "createConnection").mockImplementation(forbidden),
	spyOn(dns, "resolve").mockImplementation(forbidden),
	spyOn(globalThis, "fetch").mockImplementation(forbidden),
];
mock.module("@httptoolkit/dbus-native", () => ({
	createClient: forbidden,
	default: {
		createClient: forbidden,
		systemBus: forbidden,
		sessionBus: forbidden,
	},
	systemBus: forbidden,
	sessionBus: forbidden,
}));
const {
	captureWifiPortalBindingFromSystem: capture,
	createSystemPortalReaderDeps,
	PORTAL_READER_LIMITS: LIMITS,
} = await import("../modules/wifi/captive-portal-readers.ts");
const { createCaptivePortalSession } = await import(
	"../modules/wifi/captive-portal-session.ts"
);
const { addWifiInterface } = await import(
	"../modules/wifi/wifi-connections.ts"
);
const { isolateWifiRegistry, restoreWifiRegistry } = await import(
	"./helpers/wifi-registry.ts"
);
const { logger } = await import("../helpers/logger.ts");
const logs = [
	spyOn(logger, "error"),
	spyOn(logger, "warn"),
	spyOn(logger, "debug"),
];
let inherited: ReturnType<typeof isolateWifiRegistry>;
beforeEach(() => {
	inherited = isolateWifiRegistry();
});
afterEach(() => {
	restoreWifiRegistry(inherited);
	expect(forbidden).not.toHaveBeenCalled();
	for (const guard of guards) expect(guard).not.toHaveBeenCalled();
});
afterAll(() => {
	for (const guard of [...guards, ...logs]) guard.mockRestore();
});

const NM = "org.freedesktop.NetworkManager",
	ROOT = "/org/freedesktop/NetworkManager";
const v = (signature: string, value: unknown) => ({ signature, value });
const dictionary = (values: Record<string, unknown>) => Object.entries(values);
const reply = (signature: string, value: unknown) =>
	({ signature, body: [value] }) as MethodReply;
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((a, b) => {
		resolve = a;
		reject = b;
	});
	return { resolve, reject, promise };
}
function fixture(id = 1) {
	const ifname = `wlan${id}`,
		permanentMac = `02:00:00:00:00:0${id}`,
		device = `${ROOT}/Devices/${id}`,
		activation = `${ROOT}/ActiveConnection/${id}`,
		ap = `${ROOT}/AccessPoint/${id}`,
		config = `${ROOT}/IP4Config/${id}`;
	const profile = "00000000-0000-4000-8000-000000000001";
	const state = {
		busId: "0123456789abcdef0123456789abcdef",
		owner: ":1.42",
		time: 0,
		link: {
			ifindex: id + 1,
			physicalPath: `/sys/devices/synthetic/radio${id}`,
			stationMac: permanentMac,
			permanentMac,
		},
		address: {
			ifindex: id + 1,
			ifname,
			addr_info: [
				{ family: "inet", local: "192.0.2.10", prefixlen: 24, scope: "global" },
			],
		} as Record<string, unknown>,
		route: {
			dst: "default",
			dev: ifname,
			gateway: "192.0.2.1",
			table: 100 + id,
			metric: 10,
			prefsrc: "192.0.2.10",
		} as Record<string, unknown>,
	};
	addWifiInterface(permanentMac, {
		id,
		ifname,
		conn: profile,
		activeConn: profile,
		activeMode: "infrastructure",
		hw: "Synthetic radio",
		available: new Map(),
		saved: { venue: profile },
		savedAll: {},
	});
	const properties: Record<string, { signature: string; value: unknown }> = {
		"Device.Interface": v("s", ifname),
		"Device.IpInterface": v("s", ifname),
		"Device.DeviceType": v("u", 2),
		"Device.Managed": v("b", true),
		"Device.State": v("u", 100),
		"Device.ActiveConnection": v("o", activation),
		"Device.Ip4Config": v("o", config),
		"Device.Wireless.Mode": v("u", 2),
		"Device.Wireless.HwAddress": v("s", permanentMac),
		"Device.Wireless.PermHwAddress": v("s", permanentMac),
		"Device.Wireless.ActiveAccessPoint": v("o", ap),
		"Connection.Active.Uuid": v("s", profile),
		"Connection.Active.State": v("u", 2),
		"Connection.Active.Devices": v("ao", [device]),
		"AccessPoint.HwAddress": v("s", "02:00:00:00:01:01"),
		"IP4Config.AddressData": v("aa{sv}", [
			dictionary({ address: v("s", "192.0.2.10"), prefix: v("u", 24) }),
		]),
		"IP4Config.Gateway": v("s", "192.0.2.1"),
		"IP4Config.NameserverData": v("aa{sv}", [
			dictionary({ address: v("s", "192.0.2.1") }),
		]),
	};
	const calls: MethodCall[] = [],
		buses: ReturnType<typeof makeBus>[] = [];
	let onCall:
		| ((call: MethodCall) => Promise<MethodReply | undefined>)
		| undefined;
	const timers = new Set<{ at: number; expire: () => void }>();
	function makeBus() {
		let connected = false;
		const listeners = new Map<
			TransportEvent,
			Set<(payload?: unknown) => void>
		>();
		const bus = {
			connect: mock(async () => {
				connected = true;
			}),
			disconnect: mock(async () => {
				connected = false;
			}),
			isConnected: () => connected,
			callMethod: mock(async (call: MethodCall): Promise<MethodReply> => {
				calls.push(structuredClone(call));
				const override = await onCall?.(call);
				if (override) return override;
				if (call.destination === "org.freedesktop.DBus") {
					if (
						call.path !== "/org/freedesktop/DBus" ||
						call.interface !== "org.freedesktop.DBus"
					)
						throw new Error("unexpected bus destination");
					if (call.member === "GetId") return reply("s", state.busId);
					if (
						call.member === "GetNameOwner" &&
						JSON.stringify(call.args) === JSON.stringify([NM])
					)
						return reply("s", state.owner);
				} else {
					if (call.destination !== ":1.42")
						throw new Error("NM read not pinned to captured owner");
					if (
						call.interface === NM &&
						call.member === "GetDeviceByIpIface" &&
						call.path === ROOT &&
						JSON.stringify(call.args) === JSON.stringify([ifname])
					)
						return reply("o", device);
					if (
						call.interface === "org.freedesktop.DBus.Properties" &&
						call.member === "Get" &&
						call.signature === "ss"
					) {
						const iface = String(call.args?.[0]).slice(NM.length + 1),
							name = String(call.args?.[1]);
						const expected = iface.startsWith("Device")
							? device
							: iface === "Connection.Active"
								? activation
								: iface === "AccessPoint"
									? ap
									: config;
						const property = properties[`${iface}.${name}`];
						if (call.path !== expected || !property)
							throw new Error("unexpected property graph");
						return reply("v", structuredClone(property));
					}
				}
				throw new Error("non-read operation refused by fake bus");
			}),
			on: (event: TransportEvent, listener: (payload?: unknown) => void) => {
				let set = listeners.get(event);
				if (!set) {
					set = new Set();
					listeners.set(event, set);
				}
				set.add(listener);
			},
			off: (event: TransportEvent, listener: (payload?: unknown) => void) => {
				listeners.get(event)?.delete(listener);
			},
			subscribeSignal: mock(async () => {
				throw new Error("subscriptions not admitted");
			}),
			subscriptionCount: () => 0,
			emit: (event: TransportEvent, value?: unknown) => {
				for (const fn of listeners.get(event) ?? []) fn(value);
			},
			listenerCount: () =>
				[...listeners.values()].reduce((count, set) => count + set.size, 0),
		};
		return bus;
	}
	const deps: PortalReaderDeps = {
		createTransport: mock(async () => {
			const bus = makeBus();
			buses.push(bus);
			return bus;
		}),
		now: () => state.time,
		armTimeout: (ms, expire) => {
			const timer = { at: state.time + ms, expire };
			timers.add(timer);
			return () => {
				timers.delete(timer);
			};
		},
		readText: mock(async (path) => {
			const files: Record<string, string> = {
				ifindex: String(state.link.ifindex),
				address: state.link.stationMac,
				"phy80211/macaddress": state.link.permanentMac,
			};
			const key = path.replace(`/sys/class/net/${ifname}/`, "");
			if (!Object.hasOwn(files, key)) throw new Error("unexpected sysfs path");
			return files[key] as string;
		}),
		realpath: mock(async (path) => {
			expect(path).toBe(`/sys/class/net/${ifname}/device`);
			return state.link.physicalPath;
		}),
		runIp: mock(async (args, options) => {
			expect(options.timeoutMs).toBe(LIMITS.ipMs);
			expect(options.maxBytes).toBe(LIMITS.jsonBytes);
			if (
				JSON.stringify(args) ===
				JSON.stringify(["-j", "-4", "address", "show", "dev", ifname])
			)
				return JSON.stringify([state.address]);
			if (
				JSON.stringify(args) ===
				JSON.stringify([
					"-j",
					"-4",
					"route",
					"show",
					"table",
					"all",
					"dev",
					ifname,
				])
			)
				return JSON.stringify([state.route]);
			throw new Error("non-read ip argv refused");
		}),
	};
	return {
		id,
		ifname,
		profile,
		state,
		properties,
		deps,
		calls,
		buses,
		timers,
		makeBus,
		onCall: (fn: typeof onCall) => {
			onCall = fn;
		},
		capture: () => capture(id, deps),
		advance: (ms: number) => {
			state.time += ms;
			for (const timer of [...timers])
				if (timer.at <= state.time) {
					timers.delete(timer);
					timer.expire();
				}
		},
	};
}

describe("explicit bounded system binding reader", () => {
	test("omitted dependencies refuse, and constructing opt-in I/O refs does not execute them", async () => {
		expect(await capture(1)).toEqual({
			ok: false,
			reason: "identity_unavailable",
		});
		expect(typeof createSystemPortalReaderDeps().createTransport).toBe(
			"function",
		);
	});
	test("scripted transport and kernel data produce an immutable portal binding and close once", async () => {
		const f = fixture();
		const result = await f.capture();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("missing fixture binding");
		expect(result.binding.epoch).toEqual({
			busId: f.state.busId,
			nmOwner: f.state.owner,
		});
		expect(result.binding.activation.profileUuid).toBe(f.profile);
		expect(result.binding.link.ifindex).toBe(2);
		expect(Object.isFrozen(result.binding.link.dnsServers)).toBe(true);
		expect(f.buses[0]?.disconnect).toHaveBeenCalledTimes(1);
		expect(f.buses[0]?.listenerCount()).toBe(0);
		expect(f.timers.size).toBe(0);
		for (const call of f.calls) {
			expect(["GetId", "GetNameOwner", "GetDeviceByIpIface", "Get"]).toContain(
				call.member,
			);
			expect(call.timeoutMs).toBe(LIMITS.callMs);
		}
	});
	test("adapter completion requires independent portal verification", async () => {
		const f = fixture();
		const broker = {
			open: mock(async () => "portal-completed" as const),
			stop: mock(async () => true),
		};
		const gate = createCaptivePortalSession({
			capture: f.capture,
			now: f.deps.now,
			ttlMs: 1000,
			armExpiry: () => () => undefined,
			broker,
		});
		const owner = {};
		expect((await gate.prepare(owner)).phase).toBe("prepared");
		expect(await gate.dispatch(owner)).toEqual({
			phase: "verification-required",
		});
		expect(broker.open).toHaveBeenCalledTimes(1);
		expect(f.buses.length).toBeGreaterThan(1);
		for (const bus of f.buses) expect(bus.disconnect).toHaveBeenCalledTimes(1);
	});
	test("overlapping radios remain separate despite identical source/gateway/profile", async () => {
		const a = fixture(1),
			b = fixture(2);
		const aa = await a.capture(),
			bb = await b.capture();
		expect(aa.ok && bb.ok).toBe(true);
		if (!aa.ok || !bb.ok) throw new Error("missing twin binding");
		expect(aa.binding.link.address).toBe(bb.binding.link.address);
		expect(aa.binding.activation.profileUuid).toBe(
			bb.binding.activation.profileUuid,
		);
		expect(aa.binding.radio.ifname).not.toBe(bb.binding.radio.ifname);
		expect(aa.binding.link.physicalPath).not.toBe(bb.binding.link.physicalPath);
	});
	for (const kind of ["owner", "busId"] as const)
		test(`${kind} restart refuses reused activation/profile/source`, async () => {
			const f = fixture();
			let reads = 0;
			f.onCall(async (call) => {
				if (
					call.member === (kind === "owner" ? "GetNameOwner" : "GetId") &&
					++reads === 3
				)
					f.state[kind] =
						kind === "owner" ? ":1.43" : "1123456789abcdef0123456789abcdef";
				return undefined;
			});
			expect((await f.capture()).ok).toBe(false);
			expect(f.buses[0]?.disconnect).toHaveBeenCalledTimes(1);
		});
	for (const event of ["disconnected", "reconnected", "error"] as const)
		test(`${event} poisons even unchanged epoch strings`, async () => {
			const f = fixture();
			f.onCall(async (call) => {
				if (call.member === "GetNameOwner")
					f.buses[0]?.emit(event, new Error("secret event"));
				return undefined;
			});
			expect((await f.capture()).ok).toBe(false);
		});
	for (const key of [
		"Device.ActiveConnection",
		"Device.Ip4Config",
		"Device.Wireless.ActiveAccessPoint",
		"Device.Wireless.PermHwAddress",
		"IP4Config.NameserverData",
	])
		test(`missing ${key} is unavailable without fallback`, async () => {
			const f = fixture();
			delete f.properties[key];
			expect((await f.capture()).ok).toBe(false);
			expect(f.calls.some((call) => call.args?.includes("Nameservers"))).toBe(
				false,
			);
		});
	for (const [key, value] of Object.entries({
		"Device.DeviceType": v("u", 1),
		"Device.State": v("u", 70),
		"Device.Managed": v("b", false),
		"Device.Wireless.Mode": v("u", 3),
		"Device.ActiveConnection": v("o", "/"),
		"Connection.Active.Devices": v("ao", [`${ROOT}/Devices/99`]),
		"Connection.Active.State": v("u", 1),
		"AccessPoint.HwAddress": v("s", ""),
		"IP4Config.Gateway": v("s", "::1"),
	}))
		test(`wrong graph/state ${key} refuses`, async () => {
			const f = fixture();
			f.properties[key] = value;
			expect((await f.capture()).ok).toBe(false);
		});
	test("strict reply and variant signatures, dictionaries and duplicate keys refuse", async () => {
		for (const mutation of ["reply", "variant", "duplicate", "legacy"]) {
			const f = fixture();
			if (mutation === "reply")
				f.onCall(async (call) =>
					call.member === "GetId" ? reply("u", 42) : undefined,
				);
			if (mutation === "variant")
				f.properties["Device.Interface"] = v("o", f.ifname);
			if (mutation === "duplicate")
				f.properties["IP4Config.AddressData"] = v("aa{sv}", [
					[
						["address", v("s", "192.0.2.10")],
						["address", v("s", "192.0.2.11")],
						["prefix", v("u", 24)],
					],
				]);
			if (mutation === "legacy")
				f.properties["IP4Config.NameserverData"] = v("au", [0x010200c0]);
			expect((await f.capture()).ok).toBe(false);
		}
	});
	for (const field of ["table", "metric", "gateway"])
		test(`missing kernel route ${field} is unknown, not defaulted`, async () => {
			const f = fixture();
			delete f.state.route[field];
			expect((await f.capture()).ok).toBe(false);
		});
	test("explicit known table aliases and device-filter omission are accepted", async () => {
		const f = fixture();
		f.state.route.table = "main";
		delete f.state.route.dev;
		const r = await f.capture();
		expect(r.ok && r.binding.link.routeTable).toBe(254);
	});
	test("ambiguous/ECMP/conflicting routes and multiple source addresses refuse", async () => {
		for (const mutation of ["route", "ecmp", "dev", "source", "address"]) {
			const f = fixture();
			if (mutation === "route")
				f.deps.runIp = async (args) =>
					JSON.stringify(
						args.includes("route")
							? [f.state.route, { ...f.state.route, table: 999 }]
							: [f.state.address],
					);
			if (mutation === "ecmp") f.state.route.nexthops = [];
			if (mutation === "dev") f.state.route.dev = "eth0";
			if (mutation === "source") f.state.route.prefsrc = "192.0.2.20";
			if (mutation === "address")
				f.state.address.addr_info = [
					...(f.state.address.addr_info as unknown[]),
					{
						family: "inet",
						local: "192.0.2.20",
						prefixlen: 24,
						scope: "global",
					},
				];
			expect((await f.capture()).ok).toBe(false);
		}
	});
	for (const field of [
		"ifindex",
		"physicalPath",
		"stationMac",
		"permanentMac",
	] as const)
		test(`fresh kernel ${field} drift during awaited read refuses`, async () => {
			const f = fixture();
			const run = f.deps.runIp;
			f.deps.runIp = async (args, options) => {
				const value = await run(args, options);
				if (args.includes("route")) {
					if (field === "ifindex") f.state.link.ifindex++;
					else if (field === "physicalPath")
						f.state.link.physicalPath += "changed";
					else f.state.link[field] = "02:00:00:00:00:09";
				}
				return value;
			};
			expect((await f.capture()).ok).toBe(false);
		});
	test("oversize/malformed text, bus, JSON and unproven paths refuse", async () => {
		for (const mutation of ["text", "bus", "json", "malformed", "path"]) {
			const f = fixture();
			if (mutation === "text")
				f.deps.readText = async () => "9".repeat(LIMITS.textBytes + 1);
			if (mutation === "bus")
				f.onCall(async (call) =>
					call.member === "GetId" ? reply("s", "a".repeat(4097)) : undefined,
				);
			if (mutation === "json")
				f.deps.runIp = async () => " ".repeat(LIMITS.jsonBytes + 1);
			if (mutation === "malformed") f.deps.runIp = async () => "[bad";
			if (mutation === "path") f.state.link.physicalPath = "/tmp/radio";
			expect((await f.capture()).ok).toBe(false);
		}
	});
	test("per-call deadline rejects even if its timer callback was not serviced", async () => {
		const f = fixture();
		f.onCall(async () => {
			f.state.time += LIMITS.callMs + 1;
			return undefined;
		});
		expect((await f.capture()).ok).toBe(false);
	});
	test("whole transaction deadline bounds individually timely calls", async () => {
		const f = fixture();
		f.onCall(async () => {
			f.advance(400);
			return undefined;
		});
		expect((await f.capture()).ok).toBe(false);
		expect(f.calls.length).toBeLessThan(30);
	});
	test("unresolved bus call times out, disposes once and ignores late reply", async () => {
		const f = fixture(),
			pending = deferred<MethodReply>(),
			started = deferred<void>();
		f.onCall(async () => {
			started.resolve();
			return pending.promise;
		});
		const result = f.capture();
		await started.promise;
		f.advance(LIMITS.callMs + 1);
		expect((await result).ok).toBe(false);
		f.onCall(undefined);
		const replacement = await f.capture();
		expect(replacement.ok).toBe(true);
		const count = f.calls.length;
		pending.resolve(reply("s", f.state.busId));
		await Promise.resolve();
		expect(f.calls).toHaveLength(count);
		expect(f.buses).toHaveLength(2);
		for (const bus of f.buses) expect(bus.disconnect).toHaveBeenCalledTimes(1);
	});
	test("factory timeout disposes a transport that arrives late without connecting it", async () => {
		const f = fixture(),
			factory = deferred<DbusTransport>(),
			started = deferred<void>(),
			stopped = deferred<void>();
		const bus = f.makeBus();
		bus.disconnect.mockImplementation(async () => {
			stopped.resolve();
		});
		f.deps.createTransport = async () => {
			started.resolve();
			return factory.promise;
		};
		const result = f.capture();
		await started.promise;
		f.advance(LIMITS.connectMs + 1);
		expect((await result).ok).toBe(false);
		factory.resolve(bus);
		await stopped.promise;
		expect(bus.connect).not.toHaveBeenCalled();
		expect(bus.disconnect).toHaveBeenCalledTimes(1);
	});
	test("sysfs and ip readers have independent deadlines and abort ip on timeout", async () => {
		for (const kind of ["sysfs", "ip"]) {
			const f = fixture(),
				pending = deferred<string>(),
				started = deferred<void>();
			let signal: AbortSignal | undefined;
			if (kind === "sysfs")
				f.deps.readText = async () => {
					started.resolve();
					return pending.promise;
				};
			else
				f.deps.runIp = async (_args, options) => {
					signal = options.signal;
					started.resolve();
					return pending.promise;
				};
			const result = f.capture();
			await started.promise;
			f.advance((kind === "sysfs" ? LIMITS.fileMs : LIMITS.ipMs) + 1);
			expect((await result).ok).toBe(false);
			if (signal) expect(signal.aborted).toBe(true);
			pending.resolve("");
		}
	});
	test("disposal timeout, rejection and swallowed transport teardown error cannot report success", async () => {
		for (const kind of ["timeout", "rejection", "event"]) {
			const f = fixture(),
				started = deferred<void>(),
				blocked = deferred<void>();
			const factory = f.deps.createTransport;
			f.deps.createTransport = async () => {
				const bus = await factory();
				bus.disconnect.mockImplementation(async () => {
					started.resolve();
					if (kind === "timeout") return blocked.promise;
					if (kind === "rejection") throw new Error("secret disposal");
					bus.emit("error", new Error("secret disposal"));
				});
				return bus;
			};
			const result = f.capture();
			await started.promise;
			if (kind === "timeout") f.advance(LIMITS.disposeMs + 1);
			expect((await result).ok).toBe(false);
			blocked.resolve();
			expect(f.buses[0]?.disconnect).toHaveBeenCalledTimes(1);
		}
	});
	test("missing bus identity and NM owner refuse, with no fabricated epoch", async () => {
		for (const field of ["busId", "owner"] as const) {
			const f = fixture();
			f.state[field] = "";
			expect((await f.capture()).ok).toBe(false);
		}
	});
	test("NM BSSID, activation, source and DNS drift across kernel reads refuses", async () => {
		for (const field of ["bssid", "activation", "source", "dns"]) {
			const f = fixture(),
				run = f.deps.runIp;
			f.deps.runIp = async (args, options) => {
				const raw = await run(args, options);
				if (args.includes("route")) {
					if (field === "bssid")
						f.properties["AccessPoint.HwAddress"] = v("s", "02:00:00:00:01:02");
					if (field === "activation")
						f.properties["Device.ActiveConnection"] = v(
							"o",
							`${ROOT}/ActiveConnection/99`,
						);
					if (field === "source")
						f.properties["IP4Config.AddressData"] = v("aa{sv}", [
							dictionary({ address: v("s", "192.0.2.20"), prefix: v("u", 24) }),
						]);
					if (field === "dns")
						f.properties["IP4Config.NameserverData"] = v("aa{sv}", [
							dictionary({ address: v("s", "192.0.2.2") }),
						]);
				}
				return raw;
			};
			expect((await f.capture()).ok).toBe(false);
		}
	});
	test("kernel routes are re-read before accepting the sample", async () => {
		const f = fixture(),
			run = f.deps.runIp;
		let changed = false;
		f.deps.runIp = async (args, options) => {
			const raw = await run(args, options);
			if (args.includes("route") && !changed) {
				changed = true;
				f.state.route.metric = 999;
			}
			return raw;
		};
		expect((await f.capture()).ok).toBe(false);
	});
	test("aggregate reply/reader bytes are bounded even when individual outputs fit", async () => {
		const f = fixture(),
			run = f.deps.runIp;
		const extras = Object.fromEntries(
			Array.from({ length: 10 }, (_, n) => [
				`unused${n}`,
				v("s", "x".repeat(3000)),
			]),
		);
		f.properties["IP4Config.AddressData"] = v("aa{sv}", [
			dictionary({
				address: v("s", "192.0.2.10"),
				prefix: v("u", 24),
				...extras,
			}),
		]);
		f.properties["IP4Config.NameserverData"] = v("aa{sv}", [
			dictionary({ address: v("s", "192.0.2.1"), ...extras }),
		]);
		f.deps.runIp = async (args, options) => {
			const data = JSON.parse(await run(args, options));
			data[0].padding = "x".repeat(60000);
			return JSON.stringify(data);
		};
		expect((await f.capture()).ok).toBe(false);
	});
	test("connect and realpath have bounded independent waits", async () => {
		for (const kind of ["connect", "realpath"]) {
			const f = fixture(),
				blocked = deferred<void>(),
				started = deferred<void>();
			if (kind === "connect") {
				const factory = f.deps.createTransport;
				f.deps.createTransport = async () => {
					const bus = await factory();
					bus.connect.mockImplementation(async () => {
						started.resolve();
						return blocked.promise;
					});
					return bus;
				};
			} else
				f.deps.realpath = async () => {
					started.resolve();
					await blocked.promise;
					return f.state.link.physicalPath;
				};
			const pending = f.capture();
			await started.promise;
			f.advance((kind === "connect" ? LIMITS.connectMs : LIMITS.fileMs) + 1);
			expect((await pending).ok).toBe(false);
			blocked.resolve();
		}
	});
	test("disposal's elapsed deadline cannot be hidden by an unserviced timer", async () => {
		const f = fixture(),
			factory = f.deps.createTransport;
		f.deps.createTransport = async () => {
			const bus = await factory();
			bus.disconnect.mockImplementation(async () => {
				f.state.time += LIMITS.disposeMs + 1;
			});
			return bus;
		};
		expect((await f.capture()).ok).toBe(false);
	});
	test("clock failures and rollback cannot expose raw errors or dispatch after expiry", async () => {
		const f = fixture();
		f.deps.now = () => {
			throw new Error("SECRET_CLOCK");
		};
		expect(await f.capture()).toEqual({
			ok: false,
			reason: "identity_unavailable",
		});
		expect(f.deps.createTransport).not.toHaveBeenCalled();
		const other = fixture(2);
		let calls = 0;
		other.deps.now = () => (calls++ === 0 ? 100 : 90);
		expect((await other.capture()).ok).toBe(false);
	});
	test("credential/cookie/token/secret URL/error sentinels never escape fixed capture results or logger args", async () => {
		const sentinels = [
			"CREDENTIAL_SENTINEL",
			"COOKIE_SENTINEL",
			"TOKEN_SENTINEL",
			"URL_SECRET_SENTINEL",
			"ERROR_SENTINEL",
		];
		const f = fixture();
		f.onCall(async () => {
			throw new Error(
				`${sentinels.join(" ")} https://portal.invalid/?secret=URL_SECRET_SENTINEL`,
			);
		});
		const result = await f.capture();
		expect(result).toEqual({ ok: false, reason: "identity_unavailable" });
		for (const sentinel of sentinels) {
			expect(JSON.stringify(result)).not.toContain(sentinel);
			for (const log of logs)
				expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
		}
	});
});
