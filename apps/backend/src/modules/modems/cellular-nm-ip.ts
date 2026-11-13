import { isIPv4, isIPv6 } from "node:net";
import {
	type createDbusTransport,
	type DbusValue,
	type DbusVariant,
	isVariant,
} from "@ceralive/modem-control/transport";
import { parseCellularNmDevice } from "../network/cellular-nm-control.ts";
import { formatIpv6, parseIpv6 } from "../network/nat64.ts";
import type { CellularNetworkTarget } from "./modems.ts";
import { createCellularSystemTransport } from "./modems.ts";

export interface CellularNmIpFamily {
	readonly addresses: readonly {
		readonly address: string;
		readonly prefix: number;
	}[];
	readonly gateway?: string;
	readonly dns: readonly string[];
}
export interface CellularNmIpSnapshot {
	readonly service: string;
	readonly device: string;
	readonly active: string;
	readonly ipv4Path: string;
	readonly ipv6Path: string;
	readonly ipv4?: CellularNmIpFamily;
	readonly ipv6?: CellularNmIpFamily;
}
const NM = "org.freedesktop.NetworkManager",
	ROOT = "/org/freedesktop/NetworkManager",
	PROPS = "org.freedesktop.DBus.Properties";
function dictionary(raw: DbusValue | undefined): Map<string, DbusVariant> {
	if (!Array.isArray(raw) || raw.length > 256)
		throw new Error("Unknown NM IP dictionary");
	const fields = new Map<string, DbusVariant>();
	for (const entry of raw) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			!entry[1] ||
			!isVariant(entry[1]) ||
			fields.has(entry[0])
		)
			throw new Error("Ambiguous NM IP field");
		fields.set(entry[0], entry[1]);
	}
	return fields;
}
function field(
	fields: Map<string, DbusVariant>,
	name: string,
	signature: string,
): DbusValue {
	const value = fields.get(name);
	if (!value || value.signature !== signature)
		throw new Error("Unknown NM IP field type");
	return value.value;
}
function address(raw: DbusValue, family: 4 | 6): string {
	if (
		typeof raw !== "string" ||
		raw.includes("%") ||
		!(family === 4 ? isIPv4(raw) : isIPv6(raw))
	)
		throw new Error("Invalid NM IP address");
	if (family === 4) return raw;
	const bytes = parseIpv6(raw);
	if (!bytes) throw new Error("Invalid NM IPv6 address");
	return formatIpv6(bytes);
}
export function parseCellularNmIpFamily(
	raw: DbusValue | undefined,
	family: 4 | 6,
): CellularNmIpFamily {
	const fields = dictionary(raw),
		values = field(fields, "AddressData", "aa{sv}"),
		resolvers =
			family === 4
				? field(fields, "NameserverData", "aa{sv}")
				: field(fields, "Nameservers", "aay"),
		gateway = field(fields, "Gateway", "s");
	if (
		!Array.isArray(values) ||
		values.length > 32 ||
		!Array.isArray(resolvers) ||
		resolvers.length > 8 ||
		typeof gateway !== "string"
	)
		throw new Error("Unknown NM IP projection");
	const addresses = values.map((raw) => {
			const row = dictionary(raw),
				value = address(field(row, "address", "s"), family),
				prefix = field(row, "prefix", "u");
			if (
				typeof prefix !== "number" ||
				!Number.isInteger(prefix) ||
				prefix < 1 ||
				prefix > (family === 4 ? 32 : 128)
			)
				throw new Error("Unknown NM IP prefix");
			return { address: value, prefix };
		}),
		dns = resolvers.map((raw) => {
			if (family === 4)
				return address(field(dictionary(raw), "address", "s"), 4);
			// The transport preserves ay as Uint8Array, and also accepts a
			// decoded scalar array. IP6Config has no NameserverData property.
			if (
				!(raw instanceof Uint8Array || Array.isArray(raw)) ||
				raw.length !== 16 ||
				!Array.from(raw).every(
					(byte) =>
						typeof byte === "number" &&
						Number.isInteger(byte) &&
						byte >= 0 &&
						byte <= 255,
				)
			)
				throw new Error("Invalid NM IPv6 resolver bytes");
			return formatIpv6(Uint8Array.from(raw as number[] | Uint8Array));
		});
	if (
		new Set(addresses.map((row) => row.address)).size !== addresses.length ||
		new Set(dns).size !== dns.length
	)
		throw new Error("Ambiguous NM IP addresses");
	return {
		addresses,
		dns,
		...(gateway !== "" ? { gateway: address(gateway, family) } : {}),
	};
}
/** Positive activated-profile observation, including DHCP/RA results. Neither
 * a kernel address alone nor an MM connected bearer can attribute DNS or an IP
 * lease to the saved device+SIM profile. A changed NM owner or IP projection
 * invalidates the whole read, including same-path lease renumbering.
 */
export async function readCellularNmIp(
	target: Pick<CellularNetworkTarget, "id" | "ifname">,
	uuid: string,
	current: () => Promise<boolean>,
	factory: typeof createDbusTransport = createCellularSystemTransport,
): Promise<CellularNmIpSnapshot | undefined> {
	if (!uuid || uuid.length > 128 || !(await current())) return undefined;
	const bus = factory({ reconnect: { enabled: false }, callTimeoutMs: 5000 });
	let revoked = false;
	bus.on("disconnected", () => {
		revoked = true;
	});
	try {
		await bus.connect();
		await bus.subscribeSignal(
			{
				sender: "org.freedesktop.DBus",
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
			},
			(event) => {
				if (event.body[0] === NM) revoked = true;
			},
		);
		const owner = await bus.callMethod({
				destination: "org.freedesktop.DBus",
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "GetNameOwner",
				signature: "s",
				args: [NM],
				timeoutMs: 5000,
			}),
			service = owner.body[0];
		if (
			owner.signature !== "s" ||
			owner.body.length !== 1 ||
			typeof service !== "string" ||
			!/^:\d+\.\d+$/.test(service)
		)
			throw new Error("NM IP owner unavailable");
		const get = async (path: string, iface: string) => {
			if (revoked || !bus.isConnected())
				throw new Error("NM IP observation retired");
			const reply = await bus.callMethod({
				destination: service,
				path,
				interface: PROPS,
				member: "GetAll",
				signature: "s",
				args: [iface],
				timeoutMs: 5000,
			});
			if (revoked) throw new Error("NM IP observation retired");
			if (reply.signature !== "a{sv}" || reply.body.length !== 1)
				throw new Error("Unknown NM IP properties");
			return reply.body[0];
		};
		const selected = await bus.callMethod({
				destination: service,
				path: ROOT,
				interface: NM,
				member: "GetDeviceByIpIface",
				signature: "s",
				args: [target.ifname],
				timeoutMs: 5000,
			}),
			device = selected.body[0];
		if (
			selected.signature !== "o" ||
			selected.body.length !== 1 ||
			typeof device !== "string" ||
			!/^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/.test(device)
		)
			throw new Error("NM IP device unavailable");
		const snapshot = async (): Promise<CellularNmIpSnapshot> => {
			const rawDevice = await get(device, `${NM}.Device`),
				base = parseCellularNmDevice(device, rawDevice),
				deviceFields = dictionary(rawDevice),
				active = field(deviceFields, "ActiveConnection", "o"),
				ipv4Path = field(deviceFields, "Ip4Config", "o"),
				ipv6Path = field(deviceFields, "Ip6Config", "o");
			if (
				!base.managed ||
				base.ipIface !== target.ifname ||
				field(deviceFields, "State", "u") !== 100 ||
				(base.udi.startsWith("/org/freedesktop/ModemManager1/") &&
					base.udi !== `/org/freedesktop/ModemManager1/Modem/${target.id}`) ||
				typeof active !== "string" ||
				!/^\/org\/freedesktop\/NetworkManager\/ActiveConnection\/\d+$/.test(
					active,
				) ||
				typeof ipv4Path !== "string" ||
				!/^(?:\/|\/org\/freedesktop\/NetworkManager\/IP4Config\/\d+)$/.test(
					ipv4Path,
				) ||
				typeof ipv6Path !== "string" ||
				!/^(?:\/|\/org\/freedesktop\/NetworkManager\/IP6Config\/\d+)$/.test(
					ipv6Path,
				)
			)
				throw new Error("NM IP profile is not active on this device");
			const connection = dictionary(
					await get(active, `${NM}.Connection.Active`),
				),
				devices = field(connection, "Devices", "ao");
			if (
				field(connection, "Uuid", "s") !== uuid ||
				field(connection, "State", "u") !== 2 ||
				!Array.isArray(devices) ||
				devices.length !== 1 ||
				devices[0] !== device
			)
				throw new Error("NM IP activation belongs to another profile");
			const ipv4 =
					ipv4Path === "/"
						? undefined
						: parseCellularNmIpFamily(
								await get(ipv4Path, `${NM}.IP4Config`),
								4,
							),
				ipv6 =
					ipv6Path === "/"
						? undefined
						: parseCellularNmIpFamily(
								await get(ipv6Path, `${NM}.IP6Config`),
								6,
							);
			return {
				service,
				device,
				active,
				ipv4Path,
				ipv6Path,
				...(ipv4 ? { ipv4 } : {}),
				...(ipv6 ? { ipv6 } : {}),
			};
		};
		const first = await snapshot(),
			second = await snapshot();
		return !revoked &&
			bus.isConnected() &&
			(await current()) &&
			!revoked &&
			JSON.stringify(first) === JSON.stringify(second)
			? second
			: undefined;
	} finally {
		await bus.disconnect();
	}
}
