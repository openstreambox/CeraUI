import {
	type createDbusTransport,
	type DbusValue,
	type DbusVariant,
	isVariant,
} from "@ceralive/modem-control/transport";
import { parseCellularNmDevice } from "../network/cellular-nm-control.ts";
import {
	type CellularNetworkTarget,
	createCellularSystemTransport,
} from "./modems.ts";

const NM = "org.freedesktop.NetworkManager",
	ROOT = "/org/freedesktop/NetworkManager";
function dictionary(raw: DbusValue | undefined): Map<string, DbusVariant> {
	if (!Array.isArray(raw) || raw.length > 256)
		throw new Error("Unknown NM activation dictionary");
	const result = new Map<string, DbusVariant>();
	for (const row of raw) {
		if (
			!Array.isArray(row) ||
			row.length !== 2 ||
			typeof row[0] !== "string" ||
			!row[1] ||
			!isVariant(row[1]) ||
			result.has(row[0])
		)
			throw new Error("Ambiguous NM activation dictionary");
		result.set(row[0], row[1]);
	}
	return result;
}
function field(
	fields: Map<string, DbusVariant>,
	name: string,
	signature: string,
): DbusValue {
	const value = fields.get(name);
	if (value?.signature !== signature)
		throw new Error("Unknown NM activation field");
	return value.value;
}
export interface CellularNmActivation {
	readonly service: string;
	readonly device: string;
	readonly state: "active" | "idle";
}
/** Read the exact MM-backed NM device even after its IP interface disappears on
 * disconnect. Object ownership, device membership and UUID are positively read;
 * an available-profile list or remembered port name is never attribution.
 */
export async function readCellularNmActivation(
	target: Pick<CellularNetworkTarget, "id" | "ifname">,
	uuid: string,
	current: () => Promise<boolean>,
	factory: typeof createDbusTransport = createCellularSystemTransport,
): Promise<CellularNmActivation | undefined> {
	if (!uuid || !(await current())) return undefined;
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
			throw new Error("NM activation owner unavailable");
		const get = async (path: string, iface: string) => {
			if (revoked || !bus.isConnected())
				throw new Error("NM activation owner retired");
			const reply = await bus.callMethod({
				destination: service,
				path,
				interface: "org.freedesktop.DBus.Properties",
				member: "GetAll",
				signature: "s",
				args: [iface],
				timeoutMs: 5000,
			});
			if (revoked || reply.signature !== "a{sv}" || reply.body.length !== 1)
				throw new Error("Unknown NM activation projection");
			return reply.body[0];
		};
		const devices = await bus.callMethod({
				destination: service,
				path: ROOT,
				interface: NM,
				member: "GetDevices",
				signature: "",
				args: [],
				timeoutMs: 5000,
			}),
			paths = devices.body[0];
		if (
			devices.signature !== "ao" ||
			devices.body.length !== 1 ||
			!Array.isArray(paths) ||
			paths.length > 32 ||
			paths.some(
				(path) =>
					typeof path !== "string" ||
					!/^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/.test(path),
			) ||
			new Set(paths).size !== paths.length
		)
			throw new Error("Unknown NM activation inventory");
		const matches: string[] = [];
		for (const path of paths) {
			const device = parseCellularNmDevice(
				String(path),
				await get(String(path), `${NM}.Device`),
			);
			if (device.udi === `/org/freedesktop/ModemManager1/Modem/${target.id}`)
				matches.push(device.path);
		}
		const path = matches.length === 1 ? matches[0] : undefined;
		if (!path) return undefined;
		const snapshot = async (): Promise<CellularNmActivation | undefined> => {
			const raw = await get(path, `${NM}.Device`),
				base = parseCellularNmDevice(path, raw),
				props = dictionary(raw),
				code = field(props, "State", "u"),
				active = field(props, "ActiveConnection", "o");
			if (
				!base.managed ||
				base.udi !== `/org/freedesktop/ModemManager1/Modem/${target.id}`
			)
				return undefined;
			if (
				code === 30 &&
				active === "/" &&
				["", target.ifname].includes(base.ipIface)
			)
				return { service, device: path, state: "idle" };
			if (
				code !== 100 ||
				base.ipIface !== target.ifname ||
				typeof active !== "string" ||
				!/^\/org\/freedesktop\/NetworkManager\/ActiveConnection\/\d+$/.test(
					active,
				)
			)
				return undefined;
			const connection = dictionary(
					await get(active, `${NM}.Connection.Active`),
				),
				members = field(connection, "Devices", "ao");
			if (
				field(connection, "Uuid", "s") !== uuid ||
				field(connection, "State", "u") !== 2 ||
				!Array.isArray(members) ||
				members.length !== 1 ||
				members[0] !== path
			)
				return undefined;
			return { service, device: path, state: "active" };
		};
		const before = await snapshot(),
			after = await snapshot();
		return before &&
			after &&
			JSON.stringify(before) === JSON.stringify(after) &&
			!revoked &&
			bus.isConnected() &&
			(await current()) &&
			!revoked
			? after
			: undefined;
	} finally {
		await bus.disconnect();
	}
}
