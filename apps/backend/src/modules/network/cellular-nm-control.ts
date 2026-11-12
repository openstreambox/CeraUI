import {
	type createDbusTransport,
	type DbusTransport,
	type DbusValue,
	type DbusVariant,
	isVariant,
	variant,
} from "@ceralive/modem-control/transport";
import { createCellularSystemTransport } from "../modems/modems.ts";
import type { CellularPhysicalLink } from "./cellular-host-identity.ts";
import { cellularPhysicalState } from "./cellular-host-identity.ts";

const NM = "org.freedesktop.NetworkManager",
	ROOT = "/org/freedesktop/NetworkManager",
	DEVICE = `${NM}.Device`,
	PROPS = "org.freedesktop.DBus.Properties";
export interface CellularNmDevice {
	readonly path: string;
	readonly udi: string;
	readonly iface: string;
	readonly ipIface: string;
	readonly managed: boolean;
}
function properties(value: DbusValue | undefined): Map<string, DbusVariant> {
	if (!Array.isArray(value) || value.length > 256)
		throw new Error("Unknown NM device properties");
	const result = new Map<string, DbusVariant>();
	for (const entry of value) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			!entry[1] ||
			!isVariant(entry[1]) ||
			result.has(entry[0])
		)
			throw new Error("Malformed NM device properties");
		result.set(entry[0], entry[1]);
	}
	return result;
}
export function parseCellularNmDevice(
	path: string,
	body: DbusValue | undefined,
): CellularNmDevice {
	if (!/^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/.test(path))
		throw new Error("Invalid NM device path");
	const props = properties(body);
	const field = (name: string, signature: string) => {
		const item = props.get(name);
		if (item?.signature !== signature)
			throw new Error("Unknown NM property type");
		return item.value;
	};
	const udi = field("Udi", "s"),
		iface = field("Interface", "s"),
		ipIface = field("IpInterface", "s"),
		managed = field("Managed", "b");
	if (
		typeof udi !== "string" ||
		typeof iface !== "string" ||
		typeof ipIface !== "string" ||
		typeof managed !== "boolean"
	)
		throw new Error("Incomplete NM device identity");
	return { path, udi, iface, ipIface, managed };
}
const sameDevice = (a: CellularNmDevice, b: CellularNmDevice) =>
	a.path === b.path &&
	a.udi === b.udi &&
	a.iface === b.iface &&
	(a.ipIface === b.ipIface ||
		(!a.udi.startsWith("/org/freedesktop/ModemManager1/") &&
			["", a.iface].includes(a.ipIface) &&
			["", a.iface].includes(b.ipIface)));
export interface CellularNmControl {
	readonly owner: string;
	readonly devices: readonly CellularNmDevice[];
	readonly valid: () => boolean;
	readonly onRevoked: (callback: () => void) => () => void;
	readonly read: (
		device: CellularNmDevice,
	) => Promise<CellularNmDevice | undefined>;
	readonly setManaged: (
		device: CellularNmDevice,
		expected: boolean,
		desired: boolean,
	) => Promise<boolean>;
	readonly close: () => Promise<void>;
}
export interface CellularNmControlDeps {
	readonly transport: typeof createDbusTransport;
	readonly present: (link: CellularPhysicalLink) => Promise<boolean>;
	readonly revoked: () => void;
}
const defaults: CellularNmControlDeps = {
	transport: createCellularSystemTransport,
	present: async (link) => (await cellularPhysicalState(link)) === "present",
	revoked: () => undefined,
};
/** Direct NM object identity, never a tty alias passed to a shell. Every call
 * addresses the captured unique service owner; a replacement service cannot
 * inherit a setter. The caller holds the modem lifecycle/journal admission.
 */
export async function acquireCellularNmControl(
	link: CellularPhysicalLink,
	modemPath: string,
	deps: CellularNmControlDeps = defaults,
): Promise<CellularNmControl> {
	if (
		!/^\/org\/freedesktop\/ModemManager1\/Modem\/\d+$/.test(modemPath) ||
		!(await deps.present(link))
	)
		throw new Error("NM handoff identity unresolved");
	const transport: DbusTransport = deps.transport({
		reconnect: { enabled: false },
		callTimeoutMs: 5000,
	});
	let revoked = false,
		closed = false;
	const listeners = new Set<() => void>();
	const revoke = () => {
		if (!revoked) {
			revoked = true;
			deps.revoked();
			for (const callback of listeners) callback();
		}
	};
	transport.on("disconnected", revoke);
	const valid = () => !closed && !revoked && transport.isConnected();
	try {
		await transport.connect();
		await transport.subscribeSignal(
			{
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				path: "/org/freedesktop/DBus",
				sender: "org.freedesktop.DBus",
			},
			(event) => {
				if (event.body[0] === NM) revoke();
			},
		);
		const reply = await transport.callMethod({
			destination: "org.freedesktop.DBus",
			path: "/org/freedesktop/DBus",
			interface: "org.freedesktop.DBus",
			member: "GetNameOwner",
			signature: "s",
			args: [NM],
			timeoutMs: 5000,
		});
		const owner = reply.body[0];
		if (
			reply.signature !== "s" ||
			reply.body.length !== 1 ||
			typeof owner !== "string" ||
			!/^:\d+\.\d+$/.test(owner) ||
			!valid()
		)
			throw new Error("NM owner unavailable");
		const read = async (path: string): Promise<CellularNmDevice> => {
			if (!valid() || !(await deps.present(link)))
				throw new Error("NM handoff generation changed");
			const result = await transport.callMethod({
				destination: owner,
				path,
				interface: PROPS,
				member: "GetAll",
				signature: "s",
				args: [DEVICE],
				timeoutMs: 5000,
			});
			if (!valid() || result.signature !== "a{sv}" || result.body.length !== 1)
				throw new Error("Unknown NM device projection");
			return parseCellularNmDevice(path, result.body[0]);
		};
		const selected = await transport.callMethod({
			destination: owner,
			path: ROOT,
			interface: NM,
			member: "GetDeviceByIpIface",
			signature: "s",
			args: [link.ifname],
			timeoutMs: 5000,
		});
		const path = selected.body[0];
		if (
			!valid() ||
			selected.signature !== "o" ||
			selected.body.length !== 1 ||
			typeof path !== "string"
		)
			throw new Error("Unknown NM IP-interface selector");
		const device = await read(path);
		if (
			(device.ipIface !== link.ifname &&
				!(
					device.ipIface === "" &&
					device.iface === link.ifname &&
					!device.udi.startsWith("/org/freedesktop/ModemManager1/")
				)) ||
			(device.udi.startsWith("/org/freedesktop/ModemManager1/Modem/") &&
				device.udi !== modemPath) ||
			!(await deps.present(link))
		)
			throw new Error("NM data link belongs to another device");
		const devices = [device];

		return {
			owner,
			devices,
			valid,
			read: async (device) => {
				if (!devices.some((entry) => sameDevice(entry, device)) || !valid())
					return undefined;
				const value = await read(device.path);
				return sameDevice(value, device) &&
					valid() &&
					(await deps.present(link))
					? value
					: undefined;
			},
			onRevoked: (callback) => {
				listeners.add(callback);
				if (revoked || closed) callback();
				return () => {
					listeners.delete(callback);
				};
			},
			setManaged: async (device, expected, desired) => {
				const selected = devices.find((entry) => sameDevice(entry, device));
				if (!selected || !valid()) return false;
				const current = await read(device.path);
				if (
					!sameDevice(current, device) ||
					(current.managed !== expected && current.managed !== desired)
				)
					return false;
				if (current.managed !== desired) {
					if (!valid() || !(await deps.present(link))) return false;
					const ack = await transport.callMethod({
						destination: owner,
						path: device.path,
						interface: PROPS,
						member: "Set",
						signature: "ssv",
						args: [DEVICE, "Managed", variant("b", desired)],
						timeoutMs: 5000,
					});
					if (!valid() || ack.signature !== "" || ack.body.length) return false;
				}
				const after = await read(device.path);
				return (
					valid() && sameDevice(after, device) && after.managed === desired
				);
			},
			close: async () => {
				if (closed) return;
				closed = true;
				transport.off("disconnected", revoke);
				await transport.disconnect();
			},
		};
	} catch (error) {
		closed = true;
		transport.off("disconnected", revoke);
		await transport.disconnect();
		throw error;
	}
}
