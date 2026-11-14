import { isIPv4, isIPv6 } from "node:net";
import {
	type createDbusTransport,
	type DbusValue,
	type DbusVariant,
	isVariant,
} from "@ceralive/modem-control/transport";
import { isSafeIfname } from "../network/safe-ifname.ts";
import { createCellularSystemTransport } from "./modems.ts";

/** Private data-plane observation, never a replacement for the published modem
 * roster or a carrier-policy input. DNS remains attributable to this bearer.
 */
export interface NativeBearerIp {
	readonly family: 4 | 6;
	readonly method: "static" | "dhcp";
	readonly address?: string;
	readonly prefix?: number;
	readonly gateway?: string;
	readonly dns: readonly string[];
	readonly mtu?: number;
}
export interface NativeBearerSnapshot {
	readonly path: string;
	readonly iface: string;
	readonly ipv4?: NativeBearerIp;
	readonly ipv6?: NativeBearerIp;
}
function dictionary(value: DbusValue | undefined): Map<string, DbusVariant> {
	if (!Array.isArray(value) || value.length > 128)
		throw new Error("Invalid bearer dictionary");
	const result = new Map<string, DbusVariant>();
	for (const row of value) {
		if (
			!Array.isArray(row) ||
			row.length !== 2 ||
			typeof row[0] !== "string" ||
			!row[1] ||
			!isVariant(row[1]) ||
			result.has(row[0])
		)
			throw new Error("Ambiguous bearer property");
		result.set(row[0], row[1]);
	}
	return result;
}
function field(
	properties: Map<string, DbusVariant>,
	name: string,
	signature: string,
): DbusValue | undefined {
	const item = properties.get(name);
	if (!item) return undefined;
	if (item.signature !== signature)
		throw new Error("Unknown bearer property type");
	return item.value;
}
export function parseNativeBearerIp(
	value: DbusValue | undefined,
	family: 4 | 6,
): NativeBearerIp | undefined {
	const properties = dictionary(value),
		method = field(properties, "method", "u");
	if (method === undefined || method === 0) return undefined;
	if (method !== 2 && method !== 3)
		throw new Error("Unsupported native bearer method");
	const validAddress = (address: string) =>
		!address.includes("%") &&
		(family === 4 ? isIPv4(address) : isIPv6(address));
	const address = field(properties, "address", "s"),
		gateway = field(properties, "gateway", "s"),
		prefix = field(properties, "prefix", "u"),
		mtu = field(properties, "mtu", "u"),
		dns = field(properties, "dns", "as");
	for (const candidate of [address, gateway])
		if (
			candidate !== undefined &&
			(typeof candidate !== "string" ||
				(candidate !== "" && !validAddress(candidate)))
		)
			throw new Error("Malformed native bearer address");
	if (
		prefix !== undefined &&
		(typeof prefix !== "number" ||
			!Number.isInteger(prefix) ||
			prefix < 0 ||
			prefix > (family === 4 ? 32 : 128))
	)
		throw new Error("Malformed native bearer prefix");
	if (
		mtu !== undefined &&
		(typeof mtu !== "number" || !Number.isInteger(mtu) || mtu < 0 || mtu > 9000)
	)
		throw new Error("Malformed native bearer MTU");
	if (
		dns !== undefined &&
		(!Array.isArray(dns) ||
			dns.length > 8 ||
			dns.some(
				(address) =>
					typeof address !== "string" ||
					address.includes("%") ||
					(!isIPv4(address) && !isIPv6(address)),
			))
	)
		throw new Error("Malformed native bearer DNS");
	const usable = (text: DbusValue | undefined): text is string =>
		typeof text === "string" &&
		text !== "" &&
		text !== "0.0.0.0" &&
		text !== "::";
	return {
		family,
		method: method === 2 ? "static" : "dhcp",
		dns: Array.isArray(dns) ? dns.filter(usable) : [],
		...(usable(address) ? { address } : {}),
		...(usable(gateway) ? { gateway } : {}),
		...(typeof prefix === "number" ? { prefix } : {}),
		...(typeof mtu === "number" && mtu > 0 ? { mtu } : {}),
	};
}
const MM = "org.freedesktop.ModemManager1",
	PROPS = "org.freedesktop.DBus.Properties";
/** A pure read. The caller's guard binds MM index to the current physical
 * device/SIM/USB generation before and after the entire observation.
 */
export async function readNativeBearer(
	modem: number,
	iface: string,
	current: () => Promise<boolean>,
	factory: typeof createDbusTransport = createCellularSystemTransport,
): Promise<NativeBearerSnapshot | undefined> {
	if (
		!Number.isSafeInteger(modem) ||
		modem < 0 ||
		!isSafeIfname(iface) ||
		!(await current())
	)
		return undefined;
	const bus = factory({
		reconnect: { enabled: false },
		callTimeoutMs: 5000,
	});
	let revoked = false;
	bus.on("disconnected", () => {
		revoked = true;
	});
	try {
		await bus.connect();
		await bus.subscribeSignal(
			{
				sender: "org.freedesktop.DBus",
				interface: "org.freedesktop.DBus",
				path: "/org/freedesktop/DBus",
				member: "NameOwnerChanged",
			},
			(event) => {
				if (event.body[0] === MM) revoked = true;
			},
		);
		const service = await bus.callMethod({
			destination: "org.freedesktop.DBus",
			path: "/org/freedesktop/DBus",
			interface: "org.freedesktop.DBus",
			member: "GetNameOwner",
			signature: "s",
			args: [MM],
			timeoutMs: 5000,
		});
		const owner = service.body[0];
		if (
			revoked ||
			service.signature !== "s" ||
			service.body.length !== 1 ||
			typeof owner !== "string" ||
			!/^:\d+\.\d+$/.test(owner)
		)
			throw new Error("Native bearer service unavailable");
		const list = await bus.callMethod({
			destination: owner,
			path: `/org/freedesktop/ModemManager1/Modem/${modem}`,
			interface: PROPS,
			member: "Get",
			signature: "ss",
			args: [`${MM}.Modem`, "Bearers"],
			timeoutMs: 5000,
		});
		const item = list.body[0];
		if (
			revoked ||
			list.signature !== "v" ||
			list.body.length !== 1 ||
			!item ||
			!isVariant(item) ||
			item.signature !== "ao" ||
			!Array.isArray(item.value) ||
			item.value.length > 8 ||
			new Set(item.value).size !== item.value.length
		)
			throw new Error("Invalid native bearer inventory");
		let selected: NativeBearerSnapshot | undefined;
		for (const path of item.value) {
			if (
				typeof path !== "string" ||
				!/^\/org\/freedesktop\/ModemManager1\/Bearer\/\d+$/.test(path)
			)
				throw new Error("Invalid native bearer path");
			if (revoked) return undefined;
			const result = await bus.callMethod({
				destination: owner,
				path,
				interface: PROPS,
				member: "GetAll",
				signature: "s",
				args: [`${MM}.Bearer`],
				timeoutMs: 5000,
			});
			if (result.signature !== "a{sv}" || result.body.length !== 1)
				throw new Error("Unknown native bearer projection");
			const properties = dictionary(result.body[0]),
				connected = field(properties, "Connected", "b"),
				name = field(properties, "Interface", "s");
			if (typeof connected !== "boolean" || typeof name !== "string")
				throw new Error("Incomplete native bearer identity");
			if (!connected || name !== iface) continue;
			if (selected) throw new Error("Ambiguous connected native bearer");
			const ipv4 = parseNativeBearerIp(
					field(properties, "Ip4Config", "a{sv}") ?? [],
					4,
				),
				ipv6 = parseNativeBearerIp(
					field(properties, "Ip6Config", "a{sv}") ?? [],
					6,
				);
			selected = {
				path,
				iface,
				...(ipv4 ? { ipv4 } : {}),
				...(ipv6 ? { ipv6 } : {}),
			};
		}
		return !revoked && bus.isConnected() && (await current())
			? selected
			: undefined;
	} finally {
		await bus.disconnect();
	}
}
