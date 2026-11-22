import { createHash } from "node:crypto";
import {
	createDbusTransport,
	type DbusValue,
	variant,
} from "@ceralive/modem-control/transport";
import type { CompanionWifiNetwork } from "./companion-wifi-input.ts";

const NM = "org.freedesktop.NetworkManager";
const WIFI = "802-11-wireless";

// The same SSID cannot create a second companion profile on retry, including
// after a lost reply. A password change must go through Forget and re-import.
function profileUuid(ssid: string): string {
	const hash = createHash("sha256")
		.update("ceraui-companion-wifi:")
		.update(ssid)
		.digest("hex");
	const variantNibble = (
		(Number.parseInt(hash.slice(16, 17), 16) & 3) |
		8
	).toString(16);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variantNibble}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function saveCompanionWifiProfile(
	network: CompanionWifiNetwork,
): Promise<string> {
	const uuid = profileUuid(network.ssid);
	const settings: DbusValue[] = [
		[
			"connection",
			[
				["id", variant("s", network.ssid)],
				["uuid", variant("s", uuid)],
				["type", variant("s", WIFI)],
				["autoconnect", variant("b", false)],
			],
		],
		[
			WIFI,
			[
				["ssid", variant("ay", new TextEncoder().encode(network.ssid))],
				["mode", variant("s", "infrastructure")],
				["hidden", variant("b", network.hidden ?? false)],
			],
		],
	];
	if (network.security !== "open") {
		settings.push([
			`${WIFI}-security`,
			[
				["key-mgmt", variant("s", network.security)],
				["psk", variant("s", network.password ?? "")],
			],
		]);
	}

	const bus = createDbusTransport({
		busAddress: "unix:path=/run/dbus/system_bus_socket",
		callTimeoutMs: 3000,
		reconnect: { enabled: false },
	});
	// The transport may emit an error when the bus drops. The RPC reports only
	// a fixed status, since errors can include parts of the D-Bus message.
	bus.on("error", () => {
		// The pending method reports the failure to the caller.
	});
	try {
		await bus.connect();
		const reply = await bus.callMethod({
			destination: NM,
			path: "/org/freedesktop/NetworkManager/Settings",
			interface: `${NM}.Settings`,
			member: "AddConnection",
			signature: "a{sa{sv}}",
			args: [settings],
		});
		if (
			reply.signature !== "o" ||
			reply.body.length !== 1 ||
			typeof reply.body[0] !== "string" ||
			!/^\/org\/freedesktop\/NetworkManager\/Settings\/\d+$/.test(reply.body[0])
		) {
			throw Error("Unexpected NetworkManager reply");
		}
		return uuid;
	} finally {
		await bus.disconnect();
	}
}
