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
 */
import { readFile } from "node:fs/promises";
import type {
	DbusTransport,
	DbusValue,
	DbusVariant,
} from "@ceralive/modem-control/transport";
import { isVariant } from "@ceralive/modem-control/transport";
import { argMatch, ID_RE } from "../../../helpers/run.ts";
import { createSystemPortalReaderDeps } from "../../wifi/captive-portal-readers.ts";
import type { ScanRow } from "./policy.ts";

const NM = "org.freedesktop.NetworkManager";
const ROOT = "/org/freedesktop/NetworkManager";
const SETTINGS = `${ROOT}/Settings`;
const DEVICE = `${NM}.Device`;
const WIRELESS = `${DEVICE}.Wireless`;
const ACCESS_POINT = `${NM}.AccessPoint`;
const ACTIVE = `${NM}.Connection.Active`;
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
	/** Activate a profile on this device; the active connection's path. */
	activate(uuid: string): Promise<string | undefined>;
	/** State of an active connection, `undefined` once it is gone. */
	activeState(active: string): Promise<number | undefined>;
	/** The device's active connection, `null` when none, `undefined` unreadable. */
	active(): Promise<
		Readonly<{ path: string; uuid: string }> | null | undefined
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
export async function bindDevice(
	bus: Transport,
	radio: BindTarget,
	readIfindex: IfindexReader = sysfsIfindex,
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

	const safe = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
		try {
			return await work();
		} catch {
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
				await call(owner, device, WIRELESS, "RequestScan", "a{sv}", [[]]);
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
		activate: (uuid) =>
			safe(async () => {
				const conn = str(
					(
						await call(
							owner,
							SETTINGS,
							`${NM}.Settings`,
							"GetConnectionByUuid",
							"s",
							[uuid],
						)
					).body[0],
				);
				if (!conn) return undefined;
				const active = str(
					(
						await call(owner, ROOT, NM, "ActivateConnection", "ooo", [
							conn,
							device,
							"/",
						])
					).body[0],
				);
				return active && OBJECT_PATH_RE.test(active) ? active : undefined;
			}),
		activeState: (active) =>
			safe(async () => num(await get(active, ACTIVE, "State"))),
		active: () =>
			safe(async () => {
				const active = str(await get(device, DEVICE, "ActiveConnection"));
				if (active === undefined) return undefined;
				if (active === "/") return null;
				const uuid = str(await get(active, ACTIVE, "Uuid"));
				return uuid === undefined ? undefined : { path: active, uuid };
			}),
		deactivate: async (active) =>
			(await safe(async () => {
				await call(owner, ROOT, NM, "DeactivateConnection", "o", [active]);
				return true;
			})) ?? false,
	};
}

/** NetworkManager on the system bus; one connection per `withDevice`. */
export function systemNmBus(
	readIfindex: IfindexReader = sysfsIfindex,
	/** The system bus, through the same factory CeraUI's other NM readers use. */
	createTransport: () => Promise<Transport> = () =>
		createSystemPortalReaderDeps().createTransport(),
): NmBus {
	return {
		async withDevice(radio, fn) {
			let bus: Transport | undefined;
			try {
				bus = await createTransport();
				await bus.connect();
				const device = await bindDevice(bus, radio, readIfindex);
				return device ? await fn(device) : undefined;
			} catch {
				return undefined;
			} finally {
				await bus?.disconnect().catch(() => undefined);
			}
		},
	};
}
