/**
 * NetworkManager over D-Bus, addressed to one device incarnation.
 *
 * Every NetworkManager effect of the roaming coordinator goes through here.
 *
 * Binding pins the kernel interface the radio was admitted as: its ifindex
 * (part of the lifetime the round resolved) must be what sysfs shows for the
 * name both before and after NetworkManager's device for that name is looked
 * up, and the device's permanent MAC must be the radio's identity.
 * NetworkManager does not publish an ifindex on D-Bus (1.52), so the name
 * only locates the device; the ifindex reads around the lookup prove that
 * the same kernel interface held the name the whole time. Ifindexes are not
 * reused, so a replug in between shows up as a different one.
 *
 * From then on every call goes to that device's object path at
 * NetworkManager's unique bus name, never to an interface name. A replugged
 * radio gets a new NetworkManager object and a restarted NetworkManager a new
 * unique name; either way the old address is gone and NetworkManager refuses
 * the call ("Object does not exist", "Can not activate an unknown device"),
 * so an effect can only reach the radio that was admitted.
 *
 * A join never creates a stored profile. It hands NetworkManager the source
 * profile's settings and secrets with the overrides (name, BSSID, autoconnect
 * off) in one `AddAndActivateConnection2` call with `persist: "volatile"`: an
 * in-memory profile that NetworkManager deletes by itself as soon as it
 * deactivates or fails. There is nothing to clean up, at runtime or at boot,
 * and no window in which a half-made profile exists.
 *
 * Every call that changes state (scan request, activation, deactivation)
 * reads the caller's `live()` as the very last thing before it is sent.
 */
import { readFile } from "node:fs/promises";
import type {
	DbusTransport,
	DbusValue,
	DbusVariant,
} from "@ceralive/modem-control/transport";
import { isVariant, variant } from "@ceralive/modem-control/transport";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import type { ScanRow } from "./policy.ts";

const NM = "org.freedesktop.NetworkManager";
const ROOT = "/org/freedesktop/NetworkManager";
const SETTINGS = `${ROOT}/Settings`;
const DEVICE = `${NM}.Device`;
const WIRELESS = `${DEVICE}.Wireless`;
const ACCESS_POINT = `${NM}.AccessPoint`;
const ACTIVE = `${NM}.Connection.Active`;
const CONNECTION = `${NM}.Settings.Connection`;
/** NM_SETTINGS_CONNECTION_FLAG_VOLATILE */
const FLAG_VOLATILE = 0x4;
/** Settings that can hold secrets a station profile needs to connect. */
const SECRET_SETTINGS = ["802-11-wireless-security", "802-1x"] as const;
const PROPS = "org.freedesktop.DBus.Properties";
const DEVICE_PATH_RE = /^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/;
const OBJECT_PATH_RE = /^\/org\/freedesktop\/NetworkManager\/[A-Za-z]+\/\d+$/;
const NM_DEVICE_TYPE_WIFI = 2;
const CALL_TIMEOUT_MS = 5_000;
const MAX_ACCESS_POINTS = 256;

/** NetworkManager's active-connection states. */
export const ACTIVE_STATE = {
	activating: 1,
	activated: 2,
	deactivating: 3,
	deactivated: 4,
} as const;

/** One device incarnation, with every operation the coordinator needs. */
export type BoundDevice = Readonly<{
	/** The device's object path, for logs and tests. */
	path: string;
	/** NetworkManager's time of the last finished scan, `undefined` unreadable. */
	lastScan(): Promise<bigint | undefined>;
	/** Ask for a scan; `false` when NetworkManager refused it. */
	requestScan(): Promise<boolean>;
	/** What the last scan found, `undefined` unreadable. */
	accessPoints(): Promise<ScanRow[] | undefined>;
	/**
	 * Activate a volatile copy of the `source` profile on this device, with
	 * `overrides` applied: the new profile's UUID and active connection.
	 */
	addAndActivate(
		source: string,
		overrides: Readonly<{ id: string; bssid: string }>,
	): Promise<Readonly<{ active: string; uuid: string }> | undefined>;
	/** State of an active connection, `undefined` once it is gone. */
	activeState(active: string): Promise<number | undefined>;
	/**
	 * The device's active connection, `null` when none, `undefined`
	 * unreadable. `volatile` and `id` describe its profile.
	 */
	active(): Promise<
		| Readonly<{ path: string; uuid: string; id: string; volatile: boolean }>
		| null
		| undefined
	>;
	/** Deactivate an active connection; `false` when NetworkManager refused. */
	deactivate(active: string): Promise<boolean>;
}>;

export type NmBus = Readonly<{
	/**
	 * Run `fn` against the device with this ifindex and permanent MAC, or
	 * return `undefined` without running it when NetworkManager has no such
	 * device. `fn` never sees the bus connection outlive the call.
	 */
	withDevice<T>(
		radio: BindTarget,
		live: () => boolean,
		fn: (device: BoundDevice) => Promise<T>,
	): Promise<T | undefined>;
}>;

type Transport = Pick<DbusTransport, "connect" | "disconnect" | "callMethod">;

/** The kernel interface to bind: where it is now, and what it must be. */
export type BindTarget = Readonly<{
	ifname: string;
	ifindex: number;
	/** Permanent MAC, the radio's identity. */
	mac: string;
}>;

/** The kernel ifindex behind an interface name, `undefined` when none. */
export type IfindexReader = (ifname: string) => Promise<number | undefined>;

export async function sysfsIfindex(
	ifname: string,
): Promise<number | undefined> {
	try {
		const raw = (
			await readFile(
				`/sys/class/net/${argMatch(ID_RE, ifname)}/ifindex`,
				"utf8",
			)
		).trim();
		const n = Number(raw);
		return /^\d+$/.test(raw) && Number.isSafeInteger(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

function str(v: DbusValue | undefined): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function num(v: DbusValue | undefined): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function props(value: DbusValue | undefined): Map<string, DbusVariant> {
	const out = new Map<string, DbusVariant>();
	if (!Array.isArray(value)) return out;
	for (const entry of value) {
		if (
			Array.isArray(entry) &&
			entry.length === 2 &&
			typeof entry[0] === "string" &&
			entry[1] !== undefined &&
			isVariant(entry[1])
		)
			out.set(entry[0], entry[1]);
	}
	return out;
}

/** The 802.11 channel of a centre frequency in MHz, `null` when unknown. */
export function channelOf(mhz: number): number | null {
	if (mhz === 2484) return 14;
	if (mhz >= 2412 && mhz <= 2472) return (mhz - 2407) / 5;
	if (mhz >= 5160 && mhz <= 5885) return (mhz - 5000) / 5;
	if (mhz >= 5955 && mhz <= 7115) return (mhz - 5950) / 5;
	return null;
}

const ssidText = new TextDecoder("utf-8", { fatal: false });

/**
 * The device API on an open bus. Exported for tests, which pass a fake
 * transport; production uses {@link systemNmBus}.
 */
/** Thrown instead of sending a state change after the caller stopped. */
export class EffectCancelled extends Error {
	constructor() {
		super("effect cancelled before dispatch");
	}
}

/** Bytes of a MAC address, for `802-11-wireless.bssid`. */
function macBytes(mac: string): Uint8Array {
	return Uint8Array.from(mac.split(":").map((h) => Number.parseInt(h, 16)));
}

export type Settings = Map<string, Map<string, DbusVariant>>;

export function settingsOf(value: DbusValue | undefined): Settings {
	const out: Settings = new Map();
	if (!Array.isArray(value)) return out;
	for (const entry of value)
		if (
			Array.isArray(entry) &&
			entry.length === 2 &&
			typeof entry[0] === "string"
		)
			out.set(entry[0], props(entry[1]));
	return out;
}

/**
 * The settings for a volatile copy of a profile: its own settings and
 * secrets, without its UUID, under a new name, locked to `bssid` with
 * autoconnect off.
 */
export function volatileCopy(
	settings: Settings,
	overrides: Readonly<{ id: string; bssid: string }>,
): DbusValue {
	const connection = new Map(settings.get("connection") ?? []);
	connection.delete("uuid");
	connection.delete("timestamp");
	connection.set("id", variant("s", overrides.id));
	connection.set("autoconnect", variant("b", false));
	const wireless = new Map(settings.get("802-11-wireless") ?? []);
	wireless.set("bssid", variant("ay", macBytes(overrides.bssid)));
	const all = new Map(settings);
	all.set("connection", connection);
	all.set("802-11-wireless", wireless);
	return [...all].map(([name, values]) => [name, [...values]]);
}

export async function bindDevice(
	bus: Transport,
	radio: BindTarget,
	readIfindex: IfindexReader = sysfsIfindex,
	live: () => boolean = () => true,
): Promise<BoundDevice | undefined> {
	if ((await readIfindex(radio.ifname)) !== radio.ifindex) return undefined;
	const call = (
		destination: string,
		path: string,
		iface: string,
		member: string,
		signature?: string,
		args?: DbusValue[],
	) =>
		bus.callMethod({
			destination,
			path,
			interface: iface,
			member,
			...(signature ? { signature, args: args ?? [] } : {}),
			timeoutMs: CALL_TIMEOUT_MS,
		});
	const ownerReply = await call(
		"org.freedesktop.DBus",
		"/org/freedesktop/DBus",
		"org.freedesktop.DBus",
		"GetNameOwner",
		"s",
		[NM],
	);
	const owner = str(ownerReply.body[0]);
	if (!owner || !/^:\d+\.\d+$/.test(owner)) return undefined;
	/** A state change: stop is read last, right before it is sent. */
	const dispatch = (
		path: string,
		iface: string,
		member: string,
		signature: string,
		args: DbusValue[],
	) => {
		if (!live()) throw new EffectCancelled();
		return call(owner, path, iface, member, signature, args);
	};
	const get = async (path: string, iface: string, name: string) => {
		const reply = await call(owner, path, PROPS, "Get", "ss", [iface, name]);
		const v = reply.body[0];
		return v !== undefined && isVariant(v) ? v.value : undefined;
	};
	const getAll = async (path: string, iface: string) =>
		props((await call(owner, path, PROPS, "GetAll", "s", [iface])).body[0]);

	const devices = (await call(owner, ROOT, NM, "GetDevices")).body[0];
	if (!Array.isArray(devices)) return undefined;
	const named: string[] = [];
	for (const candidate of devices) {
		if (typeof candidate !== "string" || !DEVICE_PATH_RE.test(candidate))
			continue;
		const p = await getAll(candidate, DEVICE);
		if (
			str(p.get("Interface")?.value) === radio.ifname &&
			num(p.get("DeviceType")?.value) === NM_DEVICE_TYPE_WIFI
		)
			named.push(candidate);
	}
	// Two objects under one name: NetworkManager is mid-replug. Refuse.
	const path = named.length === 1 ? named[0] : undefined;
	if (!path) return undefined;
	const mac = str(await get(path, WIRELESS, "PermHwAddress"))?.toLowerCase();
	if (mac !== radio.mac.toLowerCase()) return undefined;
	// The same kernel interface held the name across the lookup.
	if ((await readIfindex(radio.ifname)) !== radio.ifindex) return undefined;
	const device = path;

	// A refusal from NetworkManager is `undefined`; a cancellation is not
	// swallowed, so the whole effect ends as declined.
	const safe = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
		try {
			return await work();
		} catch (error) {
			if (error instanceof EffectCancelled) throw error;
			return undefined;
		}
	};

	return {
		path: device,
		lastScan: () =>
			safe(async () => {
				const v = await get(device, WIRELESS, "LastScan");
				return typeof v === "bigint"
					? v
					: typeof v === "number"
						? BigInt(v)
						: undefined;
			}),
		requestScan: async () =>
			(await safe(async () => {
				await dispatch(device, WIRELESS, "RequestScan", "a{sv}", [[]]);
				return true;
			})) ?? false,
		accessPoints: () =>
			safe(async () => {
				const list = (await call(owner, device, WIRELESS, "GetAllAccessPoints"))
					.body[0];
				if (!Array.isArray(list)) return undefined;
				const rows: ScanRow[] = [];
				for (const ap of list.slice(0, MAX_ACCESS_POINTS)) {
					if (typeof ap !== "string" || !OBJECT_PATH_RE.test(ap)) continue;
					const p = await getAll(ap, ACCESS_POINT);
					const bssid = str(p.get("HwAddress")?.value)?.toLowerCase();
					const strength = num(p.get("Strength")?.value);
					const raw = p.get("Ssid")?.value;
					const freq = num(p.get("Frequency")?.value);
					if (!bssid || strength === undefined) continue;
					rows.push({
						bssid,
						ssid: raw instanceof Uint8Array ? ssidText.decode(raw) : "",
						quality: strength,
						channel: freq === undefined ? null : channelOf(freq),
					});
				}
				return rows;
			}),
		addAndActivate: (source, overrides) =>
			safe(async () => {
				const conn = str(
					(
						await call(
							owner,
							SETTINGS,
							`${NM}.Settings`,
							"GetConnectionByUuid",
							"s",
							[source],
						)
					).body[0],
				);
				if (!conn || !OBJECT_PATH_RE.test(conn)) return undefined;
				const settings = settingsOf(
					(await call(owner, conn, CONNECTION, "GetSettings")).body[0],
				);
				for (const name of SECRET_SETTINGS) {
					if (!settings.has(name)) continue;
					const secrets = settingsOf(
						(await call(owner, conn, CONNECTION, "GetSecrets", "s", [name]))
							.body[0],
					);
					for (const [setting, values] of secrets)
						settings.set(
							setting,
							new Map([...(settings.get(setting) ?? []), ...values]),
						);
				}
				const reply = await dispatch(
					ROOT,
					NM,
					"AddAndActivateConnection2",
					"a{sa{sv}}ooa{sv}",
					[
						volatileCopy(settings, overrides),
						device,
						"/",
						[
							["persist", variant("s", "volatile")],
							// Not tied to this bus connection, which closes after the call.
							["bind-activation", variant("s", "none")],
						],
					],
				);
				const active = str(reply.body[1]);
				if (!active || !OBJECT_PATH_RE.test(active)) return undefined;
				const uuid = str(await get(active, ACTIVE, "Uuid"));
				return uuid ? { active, uuid } : undefined;
			}),
		activeState: (active) =>
			safe(async () => num(await get(active, ACTIVE, "State"))),
		active: () =>
			safe(async () => {
				const active = str(await get(device, DEVICE, "ActiveConnection"));
				if (active === undefined) return undefined;
				if (active === "/") return null;
				const a = await getAll(active, ACTIVE);
				const uuid = str(a.get("Uuid")?.value);
				const id = str(a.get("Id")?.value);
				const profile = str(a.get("Connection")?.value);
				if (uuid === undefined || id === undefined || !profile)
					return undefined;
				const flags = num(await get(profile, CONNECTION, "Flags"));
				if (flags === undefined) return undefined;
				return {
					path: active,
					uuid,
					id,
					volatile: (flags & FLAG_VOLATILE) !== 0,
				};
			}),
		deactivate: async (active) =>
			(await safe(async () => {
				await dispatch(ROOT, NM, "DeactivateConnection", "o", [active]);
				return true;
			})) ?? false,
	};
}

/** NetworkManager on the system bus; one connection per `withDevice`. */
export function systemNmBus(
	readIfindex: IfindexReader = sysfsIfindex,
	/** The system bus, through the same factory CeraUI's other NM readers use. */
	createTransport: () => Promise<Transport> = async () =>
		(await import("../../wifi/captive-portal-readers.ts"))
			.createSystemPortalReaderDeps()
			.createTransport(),
): NmBus {
	return {
		async withDevice(radio, live, fn) {
			let bus: Transport | undefined;
			try {
				bus = await createTransport();
				await bus.connect();
				const device = await bindDevice(bus, radio, readIfindex, live);
				return device ? await fn(device) : undefined;
			} catch {
				return undefined;
			} finally {
				await bus?.disconnect().catch(() => undefined);
			}
		},
	};
}
