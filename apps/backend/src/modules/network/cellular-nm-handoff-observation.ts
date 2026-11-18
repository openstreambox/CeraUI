import {
	type createDbusTransport,
	type DbusTransport,
	isVariant,
	type MethodCall,
} from "@ceralive/modem-control/transport";
import { createCellularSystemTransport } from "../modems/modems.ts";
import {
	type CellularNmDevice,
	parseCellularNmDevice,
} from "./cellular-nm-control.ts";
import { isSafeIfname } from "./safe-ifname.ts";

const NM = "org.freedesktop.NetworkManager",
	ROOT = "/org/freedesktop/NetworkManager",
	DEVICE = `${NM}.Device`,
	DBUS = "org.freedesktop.DBus";
export interface CellularNmHandoffObservationDeps {
	readonly transport: typeof createDbusTransport;
	readonly now: () => number;
}
/** Read-only retirement evidence, not a replacement setter or NM owner. Two
 * complete censuses of one captured service must find the old UDI absent, or
 * its managed flag restored. Reused names/paths never grant a write here.
 */
export async function cellularNmHandoffRestored(
	expected: CellularNmDevice,
	deps: CellularNmHandoffObservationDeps = {
		transport: createCellularSystemTransport,
		now: () => performance.now(),
	},
): Promise<boolean> {
	const baseline = Object.freeze({ ...expected });
	if (
		!baseline.udi ||
		baseline.iface === "lo" ||
		typeof baseline.managed !== "boolean"
	)
		return false;
	const transport: DbusTransport = deps.transport({
		reconnect: { enabled: false },
		callTimeoutMs: 1500,
	});
	let revoked = false;
	const revoke = () => {
			revoked = true;
		},
		deadline = deps.now() + 8000;
	transport.on("disconnected", revoke);
	const valid = () =>
		!revoked && transport.isConnected() && deps.now() < deadline;
	const call = async (request: MethodCall) => {
		if (!valid()) throw new Error("NM restoration observation expired");
		const result = await transport.callMethod({
			...request,
			timeoutMs: Math.min(1500, Math.max(1, Math.floor(deadline - deps.now()))),
		});
		if (!valid()) throw new Error("NM restoration observation changed");
		return result;
	};
	try {
		await transport.connect();
		await transport.subscribeSignal(
			{
				path: "/org/freedesktop/DBus",
				interface: DBUS,
				member: "NameOwnerChanged",
				sender: DBUS,
			},
			(event) => {
				if (event.body[0] === NM) revoke();
			},
		);
		const ownerReply = await call({
			destination: DBUS,
			path: "/org/freedesktop/DBus",
			interface: DBUS,
			member: "GetNameOwner",
			signature: "s",
			args: [NM],
		});
		const owner = ownerReply.body[0];
		if (
			ownerReply.signature !== "s" ||
			ownerReply.body.length !== 1 ||
			typeof owner !== "string" ||
			!/^:\d+\.\d+$/.test(owner)
		)
			return false;
		for (const member of ["DeviceAdded", "DeviceRemoved"]) {
			await transport.subscribeSignal(
				{ path: ROOT, interface: NM, member, sender: owner },
				revoke,
			);
		}
		await transport.subscribeSignal(
			{
				interface: "org.freedesktop.DBus.Properties",
				member: "PropertiesChanged",
				sender: owner,
			},
			(event) => {
				if (event.body[0] === DEVICE) revoke();
			},
		);
		for (let pass = 0; pass < 2; pass++) {
			const list = await call({
				destination: owner,
				path: ROOT,
				interface: NM,
				member: "GetDevices",
				signature: "",
				args: [],
			});
			const paths = list.body[0];
			if (
				list.signature !== "ao" ||
				list.body.length !== 1 ||
				!Array.isArray(paths) ||
				paths.length > 32 ||
				paths.some(
					(path) =>
						typeof path !== "string" ||
						!/^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/.test(path),
				) ||
				new Set(paths).size !== paths.length
			)
				return false;
			const devices: CellularNmDevice[] = [];
			for (const path of paths) {
				if (typeof path !== "string") return false;
				const reply = await call({
					destination: owner,
					path,
					interface: "org.freedesktop.DBus.Properties",
					member: "GetAll",
					signature: "s",
					args: [DEVICE],
				});
				if (reply.signature !== "a{sv}" || reply.body.length !== 1)
					return false;
				const device = parseCellularNmDevice(path, reply.body[0]);
				const kind = Array.isArray(reply.body[0])
					? reply.body[0].find(
							(item) => Array.isArray(item) && item[0] === "DeviceType",
						)
					: undefined;
				// NM_DEVICE_TYPE_LOOPBACK=32, NM's public D-Bus enum. Loopback has
				// no physical UDI; a generic empty-UDI row remains unknown.
				if (
					device.udi === "" &&
					device.iface === "lo" &&
					Array.isArray(kind) &&
					kind[1] &&
					isVariant(kind[1]) &&
					kind[1].signature === "u" &&
					kind[1].value === 32
				)
					continue;
				if (
					!device.udi ||
					device.udi.length > 4096 ||
					!isSafeIfname(device.iface) ||
					(device.ipIface !== "" && !isSafeIfname(device.ipIface))
				)
					return false;
				devices.push(device);
			}
			const matches = devices.filter((device) => device.udi === baseline.udi);
			if (
				matches.length > 1 ||
				matches.some((device) => device.managed !== baseline.managed)
			)
				return false;
		}
		const last = await call({
			destination: DBUS,
			path: "/org/freedesktop/DBus",
			interface: DBUS,
			member: "GetNameOwner",
			signature: "s",
			args: [NM],
		});
		return (
			last.signature === "s" &&
			last.body.length === 1 &&
			last.body[0] === owner &&
			valid()
		);
	} catch {
		return false;
	} finally {
		revoked = true;
		transport.off("disconnected", revoke);
		await transport.disconnect();
	}
}
