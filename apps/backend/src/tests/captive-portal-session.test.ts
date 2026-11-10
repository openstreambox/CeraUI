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
import {
	createCaptivePortalSession,
	type PortalBinding,
	type PortalBindingReaders,
	type PortalCapture,
	type PortalHandle,
} from "../modules/wifi/captive-portal-session.ts";

// Guard imports as well as test calls: no host command, socket, DNS or D-Bus access.
const forbidden = mock(() => {
	throw new Error("native access forbidden in portal tests");
});
const nativeGuards = [
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
	default: { systemBus: forbidden, sessionBus: forbidden },
	systemBus: forbidden,
	sessionBus: forbidden,
}));
const { captureWifiPortalBinding } = await import(
	"../modules/wifi/wifi-interfaces.ts"
);
const { addWifiInterface, removeWifiInterface } = await import(
	"../modules/wifi/wifi-connections.ts"
);
const { isolateWifiRegistry, restoreWifiRegistry } = await import(
	"./helpers/wifi-registry.ts"
);
const { logger } = await import("../helpers/logger.ts");
const loggers = [
	spyOn(logger, "debug"),
	spyOn(logger, "info"),
	spyOn(logger, "warn"),
	spyOn(logger, "error"),
];
let inherited: ReturnType<typeof isolateWifiRegistry>;
beforeEach(() => {
	inherited = isolateWifiRegistry();
});
afterEach(() => {
	restoreWifiRegistry(inherited);
	expect(forbidden).not.toHaveBeenCalled();
	for (const guard of nativeGuards) expect(guard).not.toHaveBeenCalled();
});
afterAll(() => {
	for (const guard of [...nativeGuards, ...loggers]) guard.mockRestore();
});

const PROFILE = "00000000-0000-4000-8000-000000000001";
function fixture(id = 1) {
	const permanentMac = `02:00:00:00:00:0${id}`;
	const ifname = `wlan${id}`;
	const radio = {
		id,
		ifname,
		conn: PROFILE,
		activeConn: PROFILE,
		activeMode: "infrastructure" as const,
		hw: "Synthetic radio",
		available: new Map(),
		saved: { venue: PROFILE },
		savedAll: {},
	};
	addWifiInterface(permanentMac, radio);
	const state = {
		epoch: { busId: "0123456789abcdef0123456789abcdef", nmOwner: ":1.42" },
		activation: {
			ifname,
			profileUuid: PROFILE,
			activationPath: `/org/freedesktop/NetworkManager/ActiveConnection/${id}`,
			stationMac: permanentMac,
			bssid: "02:00:00:00:01:01",
		},
		link: {
			ifname,
			ifindex: id + 1,
			physicalPath: `/sys/devices/synthetic/radio${id}`,
			permanentMac,
			stationMac: permanentMac,
			address: "192.0.2.10",
			gateway: "192.0.2.1",
			dnsServers: ["192.0.2.1"],
			prefixLength: 24,
			routeTable: 100 + id,
			routeMetric: 10,
		},
	};
	const readers: PortalBindingReaders = {
		readEpoch: mock(async () => structuredClone(state.epoch)),
		readActivation: mock(async () => structuredClone(state.activation)),
		readLink: mock(async () => structuredClone(state.link)),
	};
	return {
		state,
		radio,
		readers,
		permanentMac,
		capture: () => captureWifiPortalBinding(id, readers),
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((a, b) => {
		resolve = a;
		reject = b;
	});
	return { resolve, reject, promise };
}
function session(f = fixture()) {
	let time = 100;
	const timers: Array<{ expire: () => void; disarmed: boolean }> = [];
	const broker = {
		open: mock(
			async (_binding: PortalBinding, _handle: PortalHandle) =>
				"portal-completed" as "portal-completed" | "not-completed",
		),
		stop: mock(async () => true),
	};
	const deps = {
		capture: f.capture,
		now: () => time,
		ttlMs: 1000,
		armExpiry: mock((_delay: number, expire: () => void) => {
			const timer = { expire, disarmed: false };
			timers.push(timer);
			return () => {
				timer.disarmed = true;
			};
		}),
		broker,
	};
	return {
		f,
		broker,
		deps,
		gate: createCaptivePortalSession(deps),
		owner: {},
		timers,
		advance: (ms: number) => {
			time += ms;
		},
	};
}

describe("authoritative private Wi-Fi binding capture", () => {
	test("keeps duplicate-address/SSID radios distinct using the actual owner registry", async () => {
		const a = fixture(1),
			b = fixture(2);
		const ca = await a.capture(),
			cb = await b.capture();
		expect(ca.ok && cb.ok).toBe(true);
		if (!ca.ok || !cb.ok) throw new Error("fixture capture unavailable");
		expect(ca.binding.link.address).toBe(cb.binding.link.address);
		expect(ca.binding.radio.permanentMac).not.toBe(
			cb.binding.radio.permanentMac,
		);
		expect(ca.binding.link.ifindex).not.toBe(cb.binding.link.ifindex);
	});
	test("has no native/default authoritative reader", async () => {
		fixture();
		expect(await captureWifiPortalBinding(1)).toEqual({
			ok: false,
			reason: "identity_unavailable",
		});
	});
	for (const missing of ["busId", "nmOwner"] as const)
		test(`refuses missing authoritative ${missing}`, async () => {
			const f = fixture();
			f.readers.readEpoch = async () => ({
				...f.state.epoch,
				[missing]: undefined,
			});
			expect(await f.capture()).toEqual({
				ok: false,
				reason: "identity_unavailable",
			});
		});
	test("refuses AP, removed, unaddressed and ambiguous cached owners before NM reads", async () => {
		const f = fixture();
		for (const changes of [
			{ activeMode: "ap" },
			{ removed: true },
			{ conn: null },
		]) {
			addWifiInterface(f.permanentMac, {
				...f.radio,
				...changes,
			} as typeof f.radio);
			expect((await f.capture()).ok).toBe(false);
		}
		addWifiInterface(f.permanentMac, f.radio);
		addWifiInterface("02:00:00:00:00:09", { ...f.radio });
		expect((await f.capture()).ok).toBe(false);
		expect(f.readers.readEpoch).not.toHaveBeenCalled();
	});
	test("detects NM restart reusing activation path, profile and IP during capture", async () => {
		const f = fixture();
		let reads = 0;
		f.readers.readEpoch = async () => ({
			...f.state.epoch,
			nmOwner: reads++ === 0 ? ":1.42" : ":1.43",
		});
		expect(await f.capture()).toEqual({ ok: false, reason: "binding_changed" });
	});
	test("revalidates registry around a deferred read and refuses removed/reused id", async () => {
		const f = fixture();
		const pending = deferred<unknown>(),
			started = deferred<void>();
		f.readers.readActivation = async () => {
			started.resolve();
			return pending.promise;
		};
		const capture = f.capture();
		await started.promise;
		removeWifiInterface(f.permanentMac);
		fixture(2);
		pending.resolve(f.state.activation);
		expect((await capture).ok).toBe(false);
	});
	test("detects source drift between awaited reads and copies mutable reader snapshots", async () => {
		const f = fixture();
		let reads = 0;
		f.readers.readLink = async () => {
			if (reads++) f.state.link.address = "192.0.2.20";
			return f.state.link;
		};
		expect(await f.capture()).toEqual({ ok: false, reason: "binding_changed" });
	});
	for (const field of [
		"physicalPath",
		"permanentMac",
		"ifindex",
		"stationMac",
		"address",
		"gateway",
		"dnsServers",
		"routeTable",
		"routeMetric",
		"prefixLength",
	])
		test(`refuses missing ${field}`, async () => {
			const f = fixture();
			f.readers.readLink = async () => ({
				...f.state.link,
				[field]: undefined,
			});
			expect((await f.capture()).ok).toBe(false);
		});
	test("refuses missing activation or BSSID rather than using profile UUID", async () => {
		const f = fixture();
		for (const field of ["activationPath", "bssid"]) {
			f.readers.readActivation = async () => ({
				...f.state.activation,
				[field]: undefined,
			});
			expect((await f.capture()).ok).toBe(false);
		}
	});
});

describe("private expiring owner-bound portal gate", () => {
	test("unavailable broker is zero dispatch and zero capture", async () => {
		const s = session();
		const capture = mock(s.f.capture);
		const gate = createCaptivePortalSession({
			...s.deps,
			capture,
			broker: undefined,
		});
		expect(await gate.prepare(s.owner)).toEqual({
			phase: "unavailable",
			reason: "broker_unavailable",
		});
		expect(capture).not.toHaveBeenCalled();
		expect(s.broker.open).not.toHaveBeenCalled();
	});
	test("dispatches the exact frozen current binding once, with verification-required only", async () => {
		const s = session();
		expect(await s.gate.prepare(s.owner)).toEqual({ phase: "prepared" });
		expect(await s.gate.dispatch(s.owner)).toEqual({
			phase: "verification-required",
		});
		expect(await s.gate.dispatch(s.owner)).toEqual({
			phase: "verification-required",
		});
		expect(s.broker.open).toHaveBeenCalledTimes(1);
		const binding = s.broker.open.mock.calls[0]?.[0];
		if (!binding) throw new Error("expected one broker binding");
		expect(binding).toEqual(
			((await s.f.capture()) as { ok: true; binding: unknown }).binding,
		);
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.link.dnsServers)).toBe(true);
		expect(JSON.stringify(s.gate.status(s.owner))).not.toContain("healthy");
	});
	test("duplicate-address radios dispatch through their own immutable bindings", async () => {
		const a = session(fixture(1)),
			b = session(fixture(2));
		await a.gate.prepare(a.owner);
		await b.gate.prepare(b.owner);
		await a.gate.dispatch(a.owner);
		await b.gate.dispatch(b.owner);
		const bindingA = a.broker.open.mock.calls[0]?.[0];
		const bindingB = b.broker.open.mock.calls[0]?.[0];
		expect(bindingA?.link.address).toBe(bindingB?.link.address);
		expect(bindingA?.radio.ifname).toBe("wlan1");
		expect(bindingB?.radio.ifname).toBe("wlan2");
		expect(bindingA?.epoch).toEqual(bindingB?.epoch);
		expect(bindingA?.activation.activationPath).not.toBe(
			bindingB?.activation.activationPath,
		);
	});
	test("a different owner cannot dispatch, cancel or replace the lease", async () => {
		const s = session();
		await s.gate.prepare(s.owner);
		for (const result of [
			s.gate.cancel({}),
			await s.gate.dispatch({}),
			await s.gate.prepare({}),
		])
			expect(result).toEqual({
				phase: "unavailable",
				reason: "owner_mismatch",
			});
		expect(s.gate.status(s.owner)).toEqual({ phase: "prepared" });
		expect(s.broker.stop).not.toHaveBeenCalled();
	});
	const changes = {
		"NM owner restart with reused activation/profile/IP": (
			f: ReturnType<typeof fixture>,
		) => {
			f.state.epoch.nmOwner = ":1.43";
		},
		"bus restart reusing unique owner": (f: ReturnType<typeof fixture>) => {
			f.state.epoch.busId = "1123456789abcdef0123456789abcdef";
		},
		activation: (f: ReturnType<typeof fixture>) => {
			f.state.activation.activationPath += "9";
		},
		bssid: (f: ReturnType<typeof fixture>) => {
			f.state.activation.bssid = "02:00:00:00:01:02";
		},
		address: (f: ReturnType<typeof fixture>) => {
			f.state.link.address = "192.0.2.20";
		},
		gateway: (f: ReturnType<typeof fixture>) => {
			f.state.link.gateway = "192.0.2.2";
		},
		dns: (f: ReturnType<typeof fixture>) => {
			f.state.link.dnsServers = ["192.0.2.2"];
		},
		route: (f: ReturnType<typeof fixture>) => {
			f.state.link.routeTable++;
		},
		ifindex: (f: ReturnType<typeof fixture>) => {
			f.state.link.ifindex++;
		},
		physical: (f: ReturnType<typeof fixture>) => {
			f.state.link.physicalPath += "new";
		},
		mac: (f: ReturnType<typeof fixture>) => {
			f.state.link.stationMac = "02:00:00:00:00:09";
			f.state.activation.stationMac = f.state.link.stationMac;
		},
	};
	for (const [name, change] of Object.entries(changes))
		test(`${name} invalidates before dispatch without fallback`, async () => {
			const s = session();
			await s.gate.prepare(s.owner);
			change(s.f);
			const result = await s.gate.dispatch(s.owner);
			expect(["closing", "closed"]).toContain(result.phase);
			expect(result.reason).toBe("binding_changed");
			expect(s.broker.open).not.toHaveBeenCalled();
		});
	test("cancellation fences an awaited preparation without creating a lease", async () => {
		const s = session(),
			d = deferred<PortalCapture>();
		const capture = await s.f.capture();
		const gate = createCaptivePortalSession({
			...s.deps,
			capture: () => d.promise,
		});
		const pending = gate.prepare(s.owner);
		expect(gate.cancel(s.owner)).toEqual({
			phase: "closed",
			reason: "cancelled",
		});
		d.resolve(capture);
		expect(await pending).toEqual({
			phase: "unavailable",
			reason: "superseded",
		});
		expect(s.broker.open).not.toHaveBeenCalled();
	});
	test("cancel/stop acknowledgement fences A before replacement B; late A cannot settle B", async () => {
		const s = session(),
			opening = deferred<"portal-completed">(),
			started = deferred<void>(),
			stopping = deferred<boolean>();
		s.broker.open.mockImplementationOnce(async () => {
			started.resolve();
			return opening.promise;
		});
		s.broker.stop.mockImplementationOnce(() => stopping.promise);
		await s.gate.prepare(s.owner);
		const pending = s.gate.dispatch(s.owner);
		await started.promise;
		expect(s.gate.cancel(s.owner).phase).toBe("closing");
		expect((await s.gate.prepare(s.owner)).phase).toBe("closing");
		expect(s.broker.stop).toHaveBeenCalledTimes(1);
		stopping.resolve(true);
		await Promise.resolve();
		expect(s.gate.status(s.owner).phase).toBe("closed");
		expect((await s.gate.prepare(s.owner)).phase).toBe("prepared");
		opening.resolve("portal-completed");
		expect(await pending).toEqual({
			phase: "unavailable",
			reason: "superseded",
		});
		expect(s.gate.status(s.owner).phase).toBe("prepared");
		expect((await s.gate.dispatch(s.owner)).phase).toBe(
			"verification-required",
		);
	});
	test("a closed prior owner cannot cancel another owner's pending capture", async () => {
		const s = session(),
			pending = deferred<PortalCapture>();
		let nextCapture = false;
		const gate = createCaptivePortalSession({
			...s.deps,
			capture: () => (nextCapture ? pending.promise : s.f.capture()),
		});
		await gate.prepare(s.owner);
		gate.cancel(s.owner);
		await Promise.resolve();
		nextCapture = true;
		const newOwner = {};
		const preparation = gate.prepare(newOwner);
		gate.cancel(s.owner);
		pending.resolve(await s.f.capture());
		expect(await preparation).toEqual({ phase: "prepared" });
		expect(gate.status(newOwner).phase).toBe("prepared");
	});
	test("expiry fires while open is deferred and cannot become verification-required", async () => {
		const s = session(),
			opening = deferred<"portal-completed">(),
			started = deferred<void>(),
			stopping = deferred<boolean>();
		s.broker.open.mockImplementation(async () => {
			started.resolve();
			return opening.promise;
		});
		s.broker.stop.mockImplementation(() => stopping.promise);
		await s.gate.prepare(s.owner);
		const pending = s.gate.dispatch(s.owner);
		await started.promise;
		s.advance(1000);
		expect(s.timers).toHaveLength(1);
		s.timers[0]?.expire();
		expect(s.gate.status(s.owner)).toEqual({
			phase: "closing",
			reason: "expired",
		});
		opening.resolve("portal-completed");
		expect((await pending).phase).toBe("closing");
	});
	test("failed/negative stop remains closing; only explicit acknowledgement closes", async () => {
		const s = session();
		s.broker.stop
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(new Error("secret stop error"));
		await s.gate.prepare(s.owner);
		s.gate.cancel(s.owner);
		await Promise.resolve();
		expect(s.gate.status(s.owner)).toEqual({
			phase: "closing",
			reason: "cleanup_unknown",
		});
		s.gate.cancel(s.owner);
		await Promise.resolve();
		expect(s.gate.status(s.owner)).toEqual({
			phase: "closing",
			reason: "cleanup_unknown",
		});
		s.gate.cancel(s.owner);
		await Promise.resolve();
		expect(s.gate.status(s.owner).phase).toBe("closed");
	});
	test("binding drift while broker is deferred prevents completion qualification", async () => {
		const s = session(),
			opening = deferred<"portal-completed">(),
			started = deferred<void>();
		s.broker.open.mockImplementation(async () => {
			started.resolve();
			return opening.promise;
		});
		await s.gate.prepare(s.owner);
		const pending = s.gate.dispatch(s.owner);
		await started.promise;
		s.f.state.epoch.nmOwner = ":1.77";
		opening.resolve("portal-completed");
		expect(["closing", "closed"]).toContain((await pending).phase);
		expect(s.gate.status(s.owner).phase).not.toBe("verification-required");
	});
	test("sentinel credentials/cookies/tokens/URLs/errors never reach status or logger arguments", async () => {
		const sentinels = [
			"CREDENTIAL_SENTINEL",
			"COOKIE_SENTINEL",
			"TOKEN_SENTINEL",
			"URL_SECRET_SENTINEL",
			"ERROR_SENTINEL",
		];
		const secret =
			sentinels.join(" ") +
			" https://portal.invalid/login?secret=URL_SECRET_SENTINEL#private";
		const s = session();
		Object.assign(s.owner, { secret });
		const outputs = [await s.gate.prepare(s.owner)];
		// Reader and broker failures are deliberately opaque; no error interpolation.
		s.f.readers.readEpoch = async () => {
			throw new Error(secret);
		};
		outputs.push(await s.gate.dispatch(s.owner));
		const other = session(fixture(2));
		other.broker.open.mockRejectedValue(new Error(secret));
		await other.gate.prepare(other.owner);
		outputs.push(await other.gate.dispatch(other.owner));
		for (const sentinel of sentinels) {
			expect(JSON.stringify(outputs)).not.toContain(sentinel);
			for (const log of loggers)
				expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
		}
	});
});
