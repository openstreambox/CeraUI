import { isIPv4 } from "node:net";
import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	TransportEvent,
} from "@ceralive/modem-control/transport";
import type {
	PortalBindingReaders,
	PortalCapture,
} from "./captive-portal-session.ts";
import { captureWifiPortalBinding } from "./wifi-interfaces.ts";

export const PORTAL_READER_LIMITS = Object.freeze({
	transactionMs: 8000,
	connectMs: 1500,
	callMs: 500,
	fileMs: 500,
	ipMs: 1000,
	disposeMs: 1000,
	textBytes: 32768,
	jsonBytes: 65536,
	replyBytes: 65536,
	transactionBytes: 524288,
	replyNodes: 4096,
	replyDepth: 12,
	arrayItems: 128,
});
export interface PortalReaderDeps {
	createTransport(): Promise<DbusTransport>;
	readText(path: string, maxBytes: number): Promise<string>;
	realpath(path: string): Promise<string>;
	runIp(
		args: readonly string[],
		options: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
	): Promise<string>;
	now(): number;
	armTimeout(ms: number, expire: () => void): () => void;
}

/** Explicit opt-in factory only. No I/O, transport or capability is installed at import. */
export function createSystemPortalReaderDeps(): PortalReaderDeps {
	return {
		createTransport: async () => {
			const { createDbusTransport } = await import(
				"@ceralive/modem-control/transport"
			);
			return createDbusTransport({
				busAddress: "unix:path=/run/dbus/system_bus_socket",
				callTimeoutMs: PORTAL_READER_LIMITS.callMs,
				reconnect: { enabled: false },
			});
		},
		readText: async (path, maxBytes) => {
			const bytes = await Bun.file(path)
				.slice(0, maxBytes + 1)
				.arrayBuffer();
			if (bytes.byteLength > maxBytes) throw new Error();
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		},
		realpath: async (path) => (await import("node:fs/promises")).realpath(path),
		runIp: async (args, options) => {
			const { execFileP } = await import("../../helpers/exec.ts");
			return (
				await execFileP("ip", args, {
					timeout: options.timeoutMs,
					maxBuffer: options.maxBytes,
					signal: options.signal,
				})
			).stdout;
		},
		now: () => performance.now(),
		armTimeout: (ms, expire) => {
			const timer = setTimeout(expire, ms);
			return () => clearTimeout(timer);
		},
	};
}

const NM = "org.freedesktop.NetworkManager";
const ROOT = "/org/freedesktop/NetworkManager";
const DBUS = "org.freedesktop.DBus";
const FAIL: PortalCapture = Object.freeze({
	ok: false,
	reason: "identity_unavailable",
});
const unavailable: () => never = () => {
	throw new Error();
};
const text = (v: unknown, max = 4096): string =>
	typeof v === "string" && Buffer.byteLength(v) <= max ? v : unavailable();
const integer = (v: unknown, min = 0): number =>
	typeof v === "number" && Number.isInteger(v) && v >= min && v <= 0xffffffff
		? v
		: unavailable();
const ipv4 = (v: unknown): string => {
	const s = text(v);
	return isIPv4(s) && !s.startsWith("127.") && !s.startsWith("0.")
		? s
		: unavailable();
};
const mac = (v: unknown): string => {
	const s = text(v).trim().toLowerCase();
	return /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(s) && s !== "00:00:00:00:00:00"
		? s
		: unavailable();
};
const array = (v: unknown): unknown[] =>
	Array.isArray(v) && v.length <= PORTAL_READER_LIMITS.arrayItems
		? v
		: unavailable();
const object = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: unavailable();
const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);
const pathFor = (value: unknown, kind: string) => {
	const s = text(value);
	return new RegExp(`^${ROOT}/${kind}/[0-9]+$`).test(s) ? s : unavailable();
};

/** Bound decoded-reply processing. The transport's prior wire allocation is NOT bounded here. */
function checkReply(reply: MethodReply): number {
	let nodes = 0,
		bytes = 0;
	const seen = new Set<object>();
	const visit = (value: unknown, depth: number) => {
		if (
			++nodes > PORTAL_READER_LIMITS.replyNodes ||
			depth > PORTAL_READER_LIMITS.replyDepth
		)
			unavailable();
		if (typeof value === "string") bytes += Buffer.byteLength(text(value));
		else if (typeof value === "number" || typeof value === "boolean")
			bytes += 8;
		else if (value && typeof value === "object") {
			if (seen.has(value)) unavailable();
			seen.add(value);
			if (Array.isArray(value))
				for (const item of array(value)) visit(item, depth + 1);
			else {
				const v = object(value);
				if (Object.keys(v).sort().join(",") !== "signature,value")
					unavailable();
				visit(v.signature, depth + 1);
				visit(v.value, depth + 1);
			}
		} else unavailable();
		if (bytes > PORTAL_READER_LIMITS.replyBytes) unavailable();
	};
	text(reply.signature, 128);
	visit(reply.body, 0);
	return bytes;
}
function variant(value: unknown, signature: string): unknown {
	const v = object(value);
	if (v.signature !== signature) unavailable();
	return v.value;
}
function dict(value: unknown): Map<string, unknown> {
	const result = new Map<string, unknown>();
	for (const entry of array(value)) {
		const pair = array(entry);
		if (pair.length !== 2) unavailable();
		const key = text(pair[0]);
		if (result.has(key)) unavailable();
		result.set(key, pair[1]);
	}
	return result;
}
function json(raw: string): unknown[] {
	if (Buffer.byteLength(raw) > PORTAL_READER_LIMITS.jsonBytes) unavailable();
	return array(JSON.parse(raw));
}
const props: Readonly<Record<string, readonly string[]>> = {
	Device: [
		"Interface",
		"IpInterface",
		"DeviceType",
		"Managed",
		"State",
		"ActiveConnection",
		"Ip4Config",
	],
	"Device.Wireless": [
		"Mode",
		"HwAddress",
		"PermHwAddress",
		"ActiveAccessPoint",
	],
	"Connection.Active": ["Uuid", "State", "Devices"],
	AccessPoint: ["HwAddress"],
	IP4Config: ["AddressData", "Gateway", "NameserverData"],
};

/** Explicit capture only: omitted dependencies refuse; never install a default reader. */
export async function captureWifiPortalBindingFromSystem(
	deviceId: number,
	deps?: PortalReaderDeps,
): Promise<PortalCapture> {
	if (!deps) return FAIL;
	let bus: DbusTransport | undefined,
		poisoned = false,
		finished = false;
	let epoch: { busId: string; nmOwner: string } | undefined;
	let previous: number;
	try {
		previous = deps.now();
	} catch {
		return FAIL;
	}
	if (!Number.isFinite(previous) || previous < 0) return FAIL;
	const deadline = previous + PORTAL_READER_LIMITS.transactionMs;
	const disposed = new WeakSet<DbusTransport>();
	let totalBytes = 0;
	const consume = (bytes: number) => {
		totalBytes += bytes;
		if (totalBytes > PORTAL_READER_LIMITS.transactionBytes) unavailable();
	};
	const poison = () => {
		poisoned = true;
	};
	const events: TransportEvent[] = ["disconnected", "reconnected", "error"];
	const now = () => {
		const n = deps.now();
		if (!Number.isFinite(n) || n < previous) unavailable();
		previous = n;
		return n;
	};
	const bounded = <T>(
		start: () => Promise<T>,
		ms: number,
		cleanup = false,
		abort?: () => void,
	): Promise<T> =>
		new Promise((resolve, reject) => {
			let done = false;
			let disarm: () => void = () => undefined;
			const settle = (ok: boolean, value?: T) => {
				if (done) return;
				done = true;
				try {
					disarm();
				} catch {
					ok = false;
					poisoned = true;
				}
				if (ok) resolve(value as T);
				else reject(new Error());
			};
			try {
				let started: number | undefined;
				if (cleanup) {
					try {
						started = now();
					} catch {
						poisoned = true;
					}
				} else started = now();
				const remaining = cleanup
					? ms
					: Math.min(ms, deadline - (started ?? deadline));
				const operationDeadline =
					started === undefined ? undefined : started + remaining;
				if ((!cleanup && (poisoned || finished)) || remaining <= 0) {
					settle(false);
					return;
				}
				disarm = deps.armTimeout(remaining, () => {
					if (!cleanup) poisoned = true;
					abort?.();
					settle(false);
				});
				Promise.resolve()
					.then(() => {
						if (
							done ||
							(!cleanup &&
								(poisoned ||
									finished ||
									(operationDeadline !== undefined &&
										now() >= operationDeadline)))
						)
							unavailable();
						return start();
					})
					.then(
						(value) => {
							try {
								if (
									(!cleanup && (poisoned || finished)) ||
									(operationDeadline !== undefined &&
										now() >= operationDeadline)
								)
									settle(false);
								else settle(true, value);
							} catch {
								settle(false);
							}
						},
						() => settle(false),
					);
			} catch {
				settle(false);
			}
		});
	const dispose = async (transport: DbusTransport) => {
		if (disposed.has(transport)) return;
		disposed.add(transport);
		try {
			await bounded(
				() => transport.disconnect(),
				PORTAL_READER_LIMITS.disposeMs,
				true,
			);
		} catch {
			poisoned = true;
		} finally {
			for (const event of events) {
				try {
					transport.off(event, poison);
				} catch {
					poisoned = true;
				}
			}
		}
	};
	const call = async (method: MethodCall, signature: string) => {
		const transport = bus;
		if (!transport?.isConnected()) unavailable();
		const reply = await bounded(
			() =>
				transport.callMethod({
					...method,
					timeoutMs: PORTAL_READER_LIMITS.callMs,
				}),
			PORTAL_READER_LIMITS.callMs,
		);
		consume(checkReply(reply));
		if (reply.signature !== signature || reply.body.length !== 1) unavailable();
		return reply.body[0];
	};
	const readEpoch = async () => {
		const base = {
			destination: DBUS,
			path: "/org/freedesktop/DBus",
			interface: DBUS,
		};
		const busId = text(await call({ ...base, member: "GetId" }, "s"));
		const nmOwner = text(
			await call(
				{ ...base, member: "GetNameOwner", signature: "s", args: [NM] },
				"s",
			),
		);
		const again = text(await call({ ...base, member: "GetId" }, "s"));
		if (
			!/^[0-9a-f]{32}$/.test(busId) ||
			!/^:\d+\.\d+$/.test(nmOwner) ||
			busId !== again
		)
			unavailable();
		const current = { busId, nmOwner };
		if (epoch && !same(epoch, current)) {
			poisoned = true;
			unavailable();
		}
		epoch = current;
		return current;
	};
	const prop = async (
		path: string,
		iface: string,
		name: string,
		signature: string,
	) => {
		const authority = epoch;
		if (!authority || !props[iface]?.includes(name)) unavailable();
		const kind =
			iface === "Device.Wireless"
				? "Devices"
				: iface === "Device"
					? "Devices"
					: iface === "Connection.Active"
						? "ActiveConnection"
						: iface === "IP4Config"
							? "IP4Config"
							: "AccessPoint";
		pathFor(path, kind);
		return variant(
			await call(
				{
					destination: authority.nmOwner,
					path,
					interface: "org.freedesktop.DBus.Properties",
					member: "Get",
					signature: "ss",
					args: [`${NM}.${iface}`, name],
				},
				"v",
			),
			signature,
		);
	};
	const snapshot = async (ifname: string) => {
		if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}$/.test(ifname)) unavailable();
		const authority = await readEpoch();
		const device = pathFor(
			await call(
				{
					destination: authority.nmOwner,
					path: ROOT,
					interface: NM,
					member: "GetDeviceByIpIface",
					signature: "s",
					args: [ifname],
				},
				"o",
			),
			"Devices",
		);
		if (
			(await prop(device, "Device", "Interface", "s")) !== ifname ||
			(await prop(device, "Device", "IpInterface", "s")) !== ifname ||
			(await prop(device, "Device", "DeviceType", "u")) !== 2 ||
			(await prop(device, "Device", "Managed", "b")) !== true ||
			(await prop(device, "Device", "State", "u")) !== 100 ||
			(await prop(device, "Device.Wireless", "Mode", "u")) !== 2
		)
			unavailable();
		const activationPath = pathFor(
			await prop(device, "Device", "ActiveConnection", "o"),
			"ActiveConnection",
		);
		const config = pathFor(
			await prop(device, "Device", "Ip4Config", "o"),
			"IP4Config",
		);
		const ap = pathFor(
			await prop(device, "Device.Wireless", "ActiveAccessPoint", "o"),
			"AccessPoint",
		);
		const stationMac = mac(
			await prop(device, "Device.Wireless", "HwAddress", "s"),
		);
		const permanentMac = mac(
			await prop(device, "Device.Wireless", "PermHwAddress", "s"),
		);
		const profileUuid = text(
			await prop(activationPath, "Connection.Active", "Uuid", "s"),
		);
		if (
			(await prop(activationPath, "Connection.Active", "State", "u")) !== 2 ||
			!same(await prop(activationPath, "Connection.Active", "Devices", "ao"), [
				device,
			])
		)
			unavailable();
		const bssid = mac(await prop(ap, "AccessPoint", "HwAddress", "s"));
		const addresses = array(
			await prop(config, "IP4Config", "AddressData", "aa{sv}"),
		);
		if (addresses.length !== 1) unavailable();
		const addressData = dict(addresses[0]);
		const address = ipv4(variant(addressData.get("address"), "s"));
		const prefixLength = integer(variant(addressData.get("prefix"), "u"), 1);
		if (prefixLength > 32) unavailable();
		const gateway = ipv4(await prop(config, "IP4Config", "Gateway", "s"));
		const dnsServers = array(
			await prop(config, "IP4Config", "NameserverData", "aa{sv}"),
		).map((d) => ipv4(variant(dict(d).get("address"), "s")));
		if (!dnsServers.length || dnsServers.length > 8) unavailable();
		await readEpoch();
		return {
			device,
			config,
			ap,
			ifname,
			activationPath,
			profileUuid,
			stationMac,
			permanentMac,
			bssid,
			address,
			prefixLength,
			gateway,
			dnsServers,
		};
	};
	const readText = async (path: string) => {
		const value = await bounded(
			() => deps.readText(path, PORTAL_READER_LIMITS.textBytes),
			PORTAL_READER_LIMITS.fileMs,
		);
		consume(Buffer.byteLength(value));
		return text(value, PORTAL_READER_LIMITS.textBytes).trim();
	};
	const kernelIdentity = async (ifname: string) => {
		const base = `/sys/class/net/${ifname}`;
		const ifindexRaw = await readText(`${base}/ifindex`);
		if (!/^[1-9][0-9]*$/.test(ifindexRaw)) unavailable();
		const ifindex = integer(Number(ifindexRaw), 1);
		const physicalPath = text(
			await bounded(
				() => deps.realpath(`${base}/device`),
				PORTAL_READER_LIMITS.fileMs,
			),
			1024,
		);
		consume(Buffer.byteLength(physicalPath));
		if (
			!/^\/sys\/devices\/[a-zA-Z0-9_./:-]+$/.test(physicalPath) ||
			physicalPath.split("/").includes("..")
		)
			unavailable();
		return {
			ifname,
			ifindex,
			physicalPath,
			stationMac: mac(await readText(`${base}/address`)),
			permanentMac: mac(await readText(`${base}/phy80211/macaddress`)),
		};
	};
	const runIp = async (args: readonly string[]) => {
		const controller = new AbortController();
		const raw = await bounded(
			() =>
				deps.runIp(args, {
					timeoutMs: PORTAL_READER_LIMITS.ipMs,
					maxBytes: PORTAL_READER_LIMITS.jsonBytes,
					signal: controller.signal,
				}),
			PORTAL_READER_LIMITS.ipMs,
			false,
			() => controller.abort(),
		);
		consume(Buffer.byteLength(raw));
		return json(raw);
	};
	const readNetwork = async (
		ifname: string,
		ifindex: number,
		a: Awaited<ReturnType<typeof snapshot>>,
	) => {
		const addresses = await runIp([
			"-j",
			"-4",
			"address",
			"show",
			"dev",
			ifname,
		]);
		if (addresses.length !== 1) unavailable();
		const entry = object(addresses[0]);
		if (entry.ifname !== ifname || entry.ifindex !== ifindex) unavailable();
		const inet = array(entry.addr_info)
			.map(object)
			.filter((x) => x.family === "inet");
		if (
			inet.length !== 1 ||
			inet[0]?.local !== a.address ||
			inet[0]?.prefixlen !== a.prefixLength ||
			inet[0]?.scope !== "global" ||
			inet[0]?.tentative === true ||
			inet[0]?.dadfailed === true ||
			(inet[0]?.flags !== undefined &&
				array(inet[0].flags).some((flag) =>
					["tentative", "dadfailed", "deprecated"].includes(text(flag)),
				)) ||
			inet[0]?.valid_life_time === 0
		)
			unavailable();
		const routes = (
			await runIp(["-j", "-4", "route", "show", "table", "all", "dev", ifname])
		)
			.map(object)
			.filter((r) => r.dst === "default");
		if (routes.length !== 1) unavailable();
		const route = routes[0];
		if (!route) unavailable();
		if (
			(route.dev !== undefined && route.dev !== ifname) ||
			route.gateway !== a.gateway ||
			route.multipath !== undefined ||
			route.nexthops !== undefined ||
			(route.prefsrc !== undefined && route.prefsrc !== a.address) ||
			(route.type !== undefined && route.type !== "unicast")
		)
			unavailable();
		const routeTable = integer(
			route.table === "main"
				? 254
				: route.table === "default"
					? 253
					: route.table === "local"
						? 255
						: route.table,
			1,
		);
		const routeMetric = integer(route.metric);
		return { routeTable, routeMetric };
	};
	const readers: PortalBindingReaders = {
		readEpoch,
		readActivation: async (ifname) => {
			const a = await snapshot(ifname);
			return {
				ifname,
				activationPath: a.activationPath,
				profileUuid: a.profileUuid,
				stationMac: a.stationMac,
				bssid: a.bssid,
			};
		},
		readLink: async (ifname) => {
			const a = await snapshot(ifname),
				first = await kernelIdentity(ifname);
			const route = await readNetwork(ifname, first.ifindex, a);
			const last = await kernelIdentity(ifname),
				b = await snapshot(ifname);
			const routeAgain = await readNetwork(ifname, last.ifindex, b);
			const finalIdentity = await kernelIdentity(ifname);
			if (
				!same(first, last) ||
				!same(last, finalIdentity) ||
				!same(route, routeAgain) ||
				!same(a, b) ||
				first.permanentMac !== a.permanentMac ||
				first.stationMac !== a.stationMac
			)
				unavailable();
			return {
				...first,
				address: a.address,
				prefixLength: a.prefixLength,
				gateway: a.gateway,
				dnsServers: a.dnsServers,
				...route,
			};
		},
	};
	let result: PortalCapture = FAIL;
	try {
		await bounded(
			() =>
				Promise.resolve()
					.then(() => {
						if (poisoned || finished || now() >= deadline) unavailable();
						return deps.createTransport();
					})
					.then((created) => {
						if (finished) void dispose(created);
						else {
							bus = created;
							for (const event of events) bus.on(event, poison);
						}
						return created;
					}),
			PORTAL_READER_LIMITS.connectMs,
		);
		const transport = bus;
		if (!transport) unavailable();
		await bounded(() => transport.connect(), PORTAL_READER_LIMITS.connectMs);
		result = await bounded(
			() => captureWifiPortalBinding(deviceId, readers),
			PORTAL_READER_LIMITS.transactionMs,
		);
	} catch {
		result = FAIL;
	} finally {
		finished = true;
		if (bus) await dispose(bus);
	}
	return poisoned ? FAIL : result;
}
