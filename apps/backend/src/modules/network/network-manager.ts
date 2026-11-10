/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project
    

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/* NetworkManager / nmcli helpers */

import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import {
	handleNmcliCommand,
	shouldMockWifi,
} from "../../mocks/providers/wifi.ts";
import {
	describeCliError,
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";

export type ConnectionUUID = string;
export type MacAddress = string;

export type NetworkManagerConnectionModemConfig = {
	"gsm.apn": string;
	"gsm.username": string;
	"gsm.password": string;
	"gsm.password-flags": string;
	"gsm.home-only": string;
	"gsm.network-id": string;
	"gsm.auto-config": "yes" | "no";
};

export type NetworkManagerConnection = {
	type: string;
	ifname: string;
	autoconnect: "yes" | "no";
	"connection.autoconnect-retries": number;
	"ipv6.method": string;
	"gsm.device-id": string;
	"gsm.sim-id": string;
	"gsm.sim-operator-id"?: string;
} & NetworkManagerConnectionModemConfig;

export async function nmConnAdd(
	connection: NetworkManagerConnection | Record<string, string>,
) {
	const fields = connection as Record<string, string | number>;
	try {
		// In mock mode, return a fake UUID for new connections
		if (shouldMockWifi()) {
			const fakeUuid = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
			logger.info(`🎭 Mock: Created fake connection ${fakeUuid}`);
			return fakeUuid;
		}

		const args = ["connection", "add"];
		for (const field in fields) {
			const value = fields[field];
			if (value === undefined) continue;

			args.push(field);
			args.push(String(value));
		}
		const stdout = await run("nmcli", args);
		const parsed = parseNmConnAddUuid(stdout);
		if (parsed.ok) return parsed.value;
		logParseError(parsed);
	} catch (err) {
		// argv carries gsm.password — keep the redacted-by-logger message, never
		// surface stderr/argv which could echo the secret.
		if (err instanceof Error) {
			logger.error(`nmConnNew err: ${err.message}`);
		}
	}
	return undefined;
}

export type EthernetActiveConnection =
	| { kind: "active"; uuid: string }
	| { kind: "absent" }
	| { kind: "unavailable" };
export type EthernetOwnedProfile =
	| { kind: "present" }
	| { kind: "absent" }
	| { kind: "unavailable" };
export type EthernetSharedProfile = Readonly<{ ifname: string; uuid: string }>;

const ETHERNET_IFNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}$/;
const CONNECTION_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Closed Ethernet operations, using the ordinary bounded argv runner. */
export function createEthernetNm(
	runner: (bin: string, args: string[]) => Promise<string> = run,
) {
	const execute = (args: string[]) => {
		// This surface has no synthetic ownership database. A mock cannot claim
		// that a reserved UUID exists, and must never fall through to the host.
		if (runner === run && shouldMockWifi()) throw new Error("unavailable");
		return runner("nmcli", args);
	};
	return {
		async active(ifname: string): Promise<EthernetActiveConnection> {
			try {
				const value = (
					await execute([
						"--terse",
						"--escape",
						"no",
						"--get-values",
						"GENERAL.CON-UUID",
						"device",
						"show",
						argMatch(ETHERNET_IFNAME, ifname),
					])
				).trim();
				if (value === "") return { kind: "absent" };
				return CONNECTION_UUID.test(value)
					? { kind: "active", uuid: value.toLowerCase() }
					: { kind: "unavailable" };
			} catch {
				return { kind: "unavailable" };
			}
		},
		async profile(uuid: string, ifname: string): Promise<EthernetOwnedProfile> {
			try {
				const canonicalUuid = argMatch(CONNECTION_UUID, uuid).toLowerCase();
				argMatch(ETHERNET_IFNAME, ifname);
				const output = (
					await execute([
						"--terse",
						"--escape",
						"no",
						"--get-values",
						"UUID",
						"connection",
						"show",
					])
				).trim();
				const uuids =
					output === ""
						? []
						: output.split(/\r?\n/).map((id) => id.toLowerCase());
				if (
					uuids.some((id) => !CONNECTION_UUID.test(id)) ||
					new Set(uuids).size !== uuids.length
				)
					return { kind: "unavailable" };
				if (!uuids.includes(canonicalUuid)) return { kind: "absent" };
				const fields = (
					await execute([
						"--terse",
						"--escape",
						"no",
						"--get-values",
						"connection.uuid,connection.type,connection.interface-name",
						"connection",
						"show",
						canonicalUuid,
					])
				)
					.trim()
					.split(/\r?\n/);
				return fields.length === 3 &&
					fields[0]?.toLowerCase() === canonicalUuid &&
					fields[1] === "802-3-ethernet" &&
					fields[2] === ifname
					? { kind: "present" }
					: { kind: "unavailable" };
			} catch {
				return { kind: "unavailable" };
			}
		},
		async addShared(profile: EthernetSharedProfile): Promise<boolean> {
			try {
				const ifname = argMatch(ETHERNET_IFNAME, profile.ifname);
				const uuid = argMatch(CONNECTION_UUID, profile.uuid).toLowerCase();
				const output = await execute([
					"connection",
					"add",
					"type",
					"ethernet",
					"ifname",
					ifname,
					"con-name",
					`Shared LAN ${ifname}`,
					"connection.uuid",
					uuid,
					"connection.autoconnect",
					"no",
					"ipv4.method",
					"shared",
				]);
				const result = parseNmConnAddUuid(output);
				return result.ok && result.value.toLowerCase() === uuid;
			} catch {
				// A lost reply may follow a successful add. The durable reservation
				// remains the only UUID a later explicit retry may inspect or add.
				return false;
			}
		},
	};
}

export async function nmConnsGet(fields: string) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--fields",
				fields,
				"connection",
				"show",
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n");
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--fields",
			fields,
			"connection",
			"show",
		]);
		return stdout.split("\n");
	} catch (err) {
		logger.error(`nmConnsGet err: ${describeCliError(err)}`);
	}
	return undefined;
}

export async function nmConnGetFields<Tupel extends Readonly<Array<string>>>(
	uuid: ConnectionUUID,
	fields: Tupel,
) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--escape",
				"no",
				"--show-secrets",
				"--get-values",
				fields.join(","),
				"connection",
				"show",
				uuid,
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n") as {
					[K in keyof Tupel]: string;
				};
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--escape",
			"no",
			"--show-secrets",
			"--get-values",
			fields.join(","),
			"connection",
			"show",
			argMatch(ID_RE, uuid),
		]);
		return stdout.split("\n") as {
			[K in keyof Tupel]: string;
		};
	} catch (err) {
		logger.error(`nmConnGetFields err: ${describeCliError(err)}`);
	}
	return undefined;
}

export async function nmConnSetFields(
	uuid: ConnectionUUID,
	fields: Record<string, string>,
) {
	try {
		// In mock mode, simulate successful modification
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Modified connection ${uuid}`);
			return true;
		}

		const args = ["con", "modify", argMatch(ID_RE, uuid)];
		for (const field in fields) {
			const value = fields[field];
			if (value === undefined) continue;

			args.push(field);
			args.push(value);
		}
		const stdout = await run("nmcli", args);
		return stdout === "";
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnSetFields err: ${err.message}`);
		}
	}
	return false;
}

export async function nmConnSetWifiMacAddress(
	uuid: ConnectionUUID,
	macAddress: MacAddress,
) {
	if (!macAddress) return false;

	// In mock mode, simulate successful MAC address update
	if (shouldMockWifi()) {
		logger.info(`🎭 Mock: Set MAC address ${macAddress} for ${uuid}`);
		return true;
	}

	return nmConnSetFields(uuid, {
		"connection.interface-name": "",
		"802-11-wireless.mac-address": macAddress,
	});
}

export async function nmConnDelete(uuid: ConnectionUUID) {
	try {
		// In mock mode, simulate successful deletion
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Deleted connection ${uuid}`);
			return true;
		}

		const stdout = await run("nmcli", ["conn", "del", argMatch(ID_RE, uuid)]);
		return parseNmConnDeleted(stdout);
	} catch (err) {
		logger.error(`nmConnDelete err: ${describeCliError(err)}`);
	}
	return false;
}

export async function nmConnect(uuid: ConnectionUUID, timeout?: number) {
	try {
		// In mock mode, simulate successful connection
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Activated connection ${uuid}`);
			return true;
		}

		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const stdout = await run(
			"nmcli",
			timeoutArgs.concat(["conn", "up", argMatch(ID_RE, uuid)]),
		);
		return parseNmConnActivated(stdout);
	} catch (err) {
		logger.error(`nmConnect err: ${describeCliError(err)}`);
	}
	return false;
}

export async function nmDisconnect(uuid: ConnectionUUID) {
	try {
		// In mock mode, simulate successful disconnection
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Disconnected ${uuid}`);
			return true;
		}

		const stdout = await run("nmcli", ["conn", "down", argMatch(ID_RE, uuid)]);
		return parseNmConnDeactivated(stdout);
	} catch (err) {
		logger.error(`nmDisconnect err: ${describeCliError(err)}`);
	}
	return false;
}

export async function nmDevices(fields: string) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--fields",
				fields,
				"device",
				"status",
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n");
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--fields",
			fields,
			"device",
			"status",
		]);
		return stdout.split("\n");
	} catch (err) {
		logger.error(`nmDevices err: ${describeCliError(err)}`);
	}
	return undefined;
}

export async function nmDeviceProp(device: string, fields: string) {
	try {
		// In mock mode, return mock device properties
		if (shouldMockWifi()) {
			const fieldList = fields.split(",");
			return fieldList.map((f) => {
				switch (f.trim()) {
					case "GENERAL.HWADDR":
						return "dc:a6:32:12:34:57";
					case "GENERAL.STATE":
						return "100 (connected)";
					case "GENERAL.CONNECTION":
						return "HomeNetwork";
					default:
						return "";
				}
			});
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--escape",
			"no",
			"--get-values",
			fields,
			"device",
			"show",
			argMatch(ID_RE, device),
		]);
		return stdout.split("\n");
	} catch (err) {
		logger.error(`nmDeviceProp err: ${describeCliError(err)}`);
	}
	return undefined;
}

export async function nmRescan(device?: string) {
	try {
		const args = ["device", "wifi", "rescan"];
		if (device) {
			args.push("ifname");
			args.push(argMatch(ID_RE, device));
		}

		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand(args);
			if (mockOutput !== null) {
				return true;
			}
		}

		const stdout = await run("nmcli", args);
		return stdout === "";
	} catch (err) {
		logger.error(`nmRescan err: ${describeCliError(err)}`);
	}
	return false;
}

export async function nmScanResults(fields: string) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--fields",
				fields,
				"device",
				"wifi",
				"list",
				"--rescan",
				"no",
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n");
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--fields",
			fields,
			"device",
			"wifi",
			"list",
			"--rescan",
			"no",
		]);
		return stdout.split("\n");
	} catch (err) {
		logger.error(`nmScanResults err: ${describeCliError(err)}`);
	}
	return undefined;
}

export async function nmHotspot(
	device: string,
	ssid: string,
	password: string,
	timeout?: number,
) {
	try {
		// In mock mode, return a fake hotspot UUID
		if (shouldMockWifi()) {
			const fakeUuid = `hotspot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
			logger.info(
				`🎭 Mock: Started hotspot ${ssid} on ${device} with UUID ${fakeUuid}`,
			);
			return fakeUuid;
		}

		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const stdout = await run(
			"nmcli",
			timeoutArgs.concat([
				"device",
				"wifi",
				"hotspot",
				"ssid",
				ssid,
				"password",
				password,
				"ifname",
				argMatch(ID_RE, device),
			]),
		);

		const parsed = parseNmHotspotUuid(stdout);
		if (parsed.ok) return parsed.value;
		logParseError(parsed);
		return null;
	} catch (err) {
		// argv carries the hotspot password — keep the redacted-by-logger
		// message, never surface stderr/argv which could echo the secret.
		if (err instanceof Error) {
			logger.error(`nmHotspot err: ${err.message}`);
		}
	}
	return undefined;
}

// parses : separated values, with automatic \ escape detection and stripping
export function nmcliParseSep(value: string) {
	return value.split(/(?<!\\):/).map((a) => a.replace(/\\:/g, ":"));
}

// ─── named result parsers (fail-loud on nmcli output drift) ──────────────────

// Regex: nmcli's "Connection '<name>' (<uuid>) successfully added." line.
const NM_CONN_ADD_RE = /Connection '.+' \((.+)\) successfully added\./;
// Regex: nmcli's "...successfully activated with '<uuid>'" hotspot line.
const NM_HOTSPOT_UUID_RE = /successfully activated with '(.+)'/;

/**
 * Extract the new connection UUID from `nmcli connection add` output. A missing
 * "successfully added" line is drift — the caller treats it as a failed add
 * rather than returning a bogus/empty UUID.
 */
export function parseNmConnAddUuid(stdout: string): ParseResult<string> {
	const m = stdout.match(NM_CONN_ADD_RE);
	if (m?.[1] === undefined) {
		return parseFail(
			"parseNmConnAddUuid",
			"no 'successfully added' confirmation line",
			stdout,
		);
	}
	return parseOk(m[1]);
}

/** Extract the hotspot connection UUID from `nmcli device wifi hotspot` output. */
export function parseNmHotspotUuid(stdout: string): ParseResult<string> {
	const m = stdout.match(NM_HOTSPOT_UUID_RE);
	if (m?.[1] === undefined) {
		return parseFail(
			"parseNmHotspotUuid",
			"no 'successfully activated with' confirmation line",
			stdout,
		);
	}
	return parseOk(m[1]);
}

/** True when nmcli confirmed a connection deletion. */
export function parseNmConnDeleted(stdout: string): boolean {
	return /successfully deleted/.test(stdout);
}

/** True when nmcli confirmed a connection activation. */
export function parseNmConnActivated(stdout: string): boolean {
	return /^Connection successfully activated/.test(stdout);
}

/** True when nmcli confirmed a connection deactivation. */
export function parseNmConnDeactivated(stdout: string): boolean {
	return /successfully deactivated/.test(stdout);
}
