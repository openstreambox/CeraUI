/*
    CeraUI - web UI for the CeraLive project
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

/*
  ModemManager / NetworkManager based modem management
*/

import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	createDbusTransport,
	type DbusTransport,
	type DbusTransportOptions,
} from "@ceralive/modem-control/transport";
import {
	decideModemReactivation,
	diffModemConnectionFields,
	type ModemConnectionHold,
	normalizeModemConnectionFields,
} from "@ceraui/rpc/schemas";
import type WebSocket from "ws";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { extractMessage } from "../../helpers/types.ts";
import {
	exchangeUsbSerial,
	identifyUsbSerial,
	type UsbSerialIdentity,
	usbGeneration,
} from "../../helpers/usb-serial.ts";
import {
	type ConnectionUUID,
	nmConnGetFields,
	nmConnSetFields,
	nmDisconnect,
} from "../network/network-manager.ts";
import {
	newCarrierIntent,
	newPendingCarrierIntent,
	readCarrierIntent,
	writeCarrierIntent,
} from "./automatic-carrier-intent.ts";
import { observeCellularNativeBearer } from "./cellular-network-observation.ts";
import { automaticProfileConnectionFlags } from "./cellular-preparation.ts";
import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import { getGsmConnections, resetGsmConnections } from "./gsm-connections.ts";
import { reconcileDuplicateGsmProfiles } from "./gsm-duplicate-reconcile.ts";
import { setGsmOperatorName } from "./gsm-operators-cache.ts";
import { mmcliBinary, mmList, mmSetNetworkTypes } from "./mmcli.ts";
import { modemNetworkScan } from "./modem-network-scan.ts";
import {
	isModemPairAtStableKey,
	type ReadyModemSim,
	readReadyModemSim,
	sanitizeModemConfigForNetworkManager,
} from "./modem-registration.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem, type ModemConfig } from "./modems-state.ts";
import { readNativeBearer } from "./native-bearer.ts";
import type { RequestedFamily } from "./subscription-policy.ts";
import type { InitialEpsSettings } from "./transport-policy.ts";
import {
	type InternalContext,
	type InternalGrant,
	type InternalRegistration,
	internalContextCommand,
	type ModemTransportIdentity,
	parseInternalContext,
	parseInternalContextActive,
	parseInternalContextDns,
	parseInternalGrant,
	parseInternalIpv4Grant,
	parseInternalRegistration,
	parseQmapAutoConnect,
	resolveTransportQuirk,
} from "./transport-policy.ts";

/** System-bus sessions for the retained cellular owners. Address selection lives
 * at this facade, rather than depending on the package's session-bus default.
 */
export function createCellularSystemTransport(
	options: Pick<DbusTransportOptions, "reconnect" | "callTimeoutMs"> = {},
	factory: typeof createDbusTransport = createDbusTransport,
): DbusTransport {
	return factory({
		...(options.reconnect !== undefined
			? { reconnect: options.reconnect }
			: {}),
		...(options.callTimeoutMs !== undefined
			? { callTimeoutMs: options.callTimeoutMs }
			: {}),
		busAddress:
			process.env.DBUS_SYSTEM_BUS_ADDRESS ??
			"unix:path=/run/dbus/system_bus_socket",
	});
}

type ModemConfigMessage = {
	config: {
		device: number;
		roaming?: boolean;
		autoconfig?: boolean;
		apn?: unknown;
		username?: unknown;
		password?: unknown;
		network?: unknown;
		network_type?: unknown;
	};
};

type ModemScanMessage = {
	scan: {
		device: string;
	};
};

export type ModemsMessage = {
	modems: ModemConfigMessage | ModemScanMessage;
};

async function updateModemConnection(
	connectionUuid: ConnectionUUID,
	config: ModemConfig,
) {
	// The profile write already runs under the caller's lifecycle lease/journal.
	const connections = await getGsmConnections();
	if (!connections) return false;
	const selected = connections.byUuid[connectionUuid];
	if (!selected) return false;
	const identity =
		selected?.deviceId && selected.simId
			? {
					uuid: connectionUuid,
					deviceId: selected.deviceId,
					simId: selected.simId,
				}
			: undefined;
	const before = identity ? await readCarrierIntent(identity) : undefined;
	const nmConfig = {
		...sanitizeModemConfigForNetworkManager(config),
		...(identity
			? await automaticProfileConnectionFlags(identity, config.autoconfig)
			: {}),
	};
	if (identity)
		await writeCarrierIntent(
			identity,
			config.autoconfig
				? newPendingCarrierIntent(identity, "")
				: newCarrierIntent(identity, "manual"),
		);
	try {
		const written = await nmConnSetFields(connectionUuid, nmConfig);
		if (!written && identity) await writeCarrierIntent(identity, before);
		return written;
	} catch (error) {
		if (identity) await writeCarrierIntent(identity, before);
		throw error;
	}
}

/**
 * Make the operator's answer true on EVERY profile bound to this modem's SIM.
 *
 * Writing only the selected profile leaves the operator's choice hostage to
 * NetworkManager's own activation logic. `gsm.home-only` is the case that makes
 * this a safety defect rather than a tidiness one: it becomes the bearer's
 * allow-roaming flag at `Simple.Connect`, so a duplicate still carrying `no`
 * registers a roaming session for an operator who disabled roaming — silently,
 * with the UI still reporting the value the written profile holds.
 *
 * The identity is read from the profile itself (`byUuid`), never from `Modem`:
 * `gsm.device-id`/`gsm.sim-id` are what NetworkManager matches on, so they are
 * the only keys that name the same set of profiles NM would choose among.
 */
async function enforceModemConfigAcrossProfiles(
	connectionUuid: ConnectionUUID,
	config: ModemConfig,
): Promise<number> {
	const selected = (await getGsmConnections())?.byUuid[connectionUuid];
	if (!selected?.deviceId || !selected.simId) return 0;

	const result = await reconcileDuplicateGsmProfiles(
		selected.deviceId,
		selected.simId,
		connectionUuid,
		sanitizeModemConfigForNetworkManager({ ...config }),
	);
	if (result.pruned > 0) resetGsmConnections();
	return result.duplicates;
}

/**
 * Is NetworkManager holding this profile right now?
 *
 * `nmcli --get-values GENERAL.STATE connection show <uuid>` prints the state for
 * a profile NM has attached to a device and NOTHING AT ALL for a detached one —
 * measured on the board: `activated` for the live ethernet profile, EMPTY output
 * for the idle gsm one. So a non-empty answer is positive evidence NM has the
 * profile in hand (including `activating`, where a bearer is being built from
 * the values we are about to replace), and an empty answer is positive evidence
 * it does not. A failed read proves neither, so it stays `unknown` and is
 * treated as held — see `decideModemReactivation`.
 */
async function readModemConnectionHold(
	connectionUuid: ConnectionUUID,
): Promise<ModemConnectionHold> {
	const fields = await nmConnGetFields(connectionUuid, [
		"GENERAL.STATE",
	] as const);
	if (!fields) return "unknown";
	return (fields[0] ?? "").trim() === "" ? "idle" : "held";
}

/** Injected so the reactivation DECISION is provable without an nmcli on the host. */
export type ModemApplyDeps = {
	readonly writeConnection: (
		connectionUuid: ConnectionUUID,
		config: ModemConfig,
	) => Promise<boolean>;
	readonly readConnectionHold: (
		connectionUuid: ConnectionUUID,
	) => Promise<ModemConnectionHold>;
	readonly enforceAcrossProfiles: (
		connectionUuid: ConnectionUUID,
		config: ModemConfig,
	) => Promise<number>;
	readonly disconnect: (connectionUuid: ConnectionUUID) => Promise<unknown>;
	readonly setNetworkTypes: (
		id: number,
		allowed: string,
		preferred: string,
	) => Promise<unknown>;
	readonly autoconfigSupported: () => boolean;
};

export const defaultModemApplyDeps: ModemApplyDeps = {
	writeConnection: updateModemConnection,
	readConnectionHold: readModemConnectionHold,
	enforceAcrossProfiles: enforceModemConfigAcrossProfiles,
	disconnect: nmDisconnect,
	setNetworkTypes: mmSetNetworkTypes,
	autoconfigSupported: resolveGsmAutoconfigSupport,
};

/**
 * Why a modem-config write was refused. Wire-stable tokens: the RPC returns
 * them verbatim and the dialog keys operator copy off them, so they are renamed
 * only alongside the schema and all ten locales.
 */
export type ModemConfigRefusal =
	| "device_busy"
	| "unknown_modem"
	| "unconfigured_modem"
	| "invalid_config"
	| "unsupported_network_type"
	| "unavailable_network"
	| "write_failed";

export type ModemConfigOutcome =
	| { ok: true; reconnected: boolean }
	| { ok: false; reason: ModemConfigRefusal };

/**
 * Apply a modem configuration, and SAY whether it landed.
 *
 * Every early return below used to be a silent one — the caller dispatched this
 * with `void` and answered `{success: true}` regardless — so a save the device
 * refused outright was reported to the operator as saved. That is the same
 * class of defect todo 47 found in the interface-address field, and it is why
 * this returns an outcome rather than `void`.
 */
export async function applyModemConfig(
	msg: ModemConfigMessage["config"],
	deps: ModemApplyDeps = defaultModemApplyDeps,
): Promise<ModemConfigOutcome> {
	// `!msg.device` would also reject mmcli id 0, which is a perfectly ordinary
	// modem index — the check is about a MISSING id, not a falsy one.
	if (msg.device === undefined || !Number.isFinite(msg.device)) {
		logger.info("Ignoring modem config for unknown modem (no id)");
		return { ok: false, reason: "unknown_modem" };
	}

	const modem = getModem(msg.device);
	if (!modem) {
		logger.info(`Ignoring modem config for unknown modem ${msg.device}`);
		return { ok: false, reason: "unknown_modem" };
	}

	const connUuid = modem.config?.conn;
	if (!connUuid || !modem.config) {
		logger.warn(`Ignoring modem config for unconfigured modem ${msg.device}`);
		logger.debug("Modem config", modem.config);
		return { ok: false, reason: "unconfigured_modem" };
	}

	// Ensure the configuration message has all the required fields
	if (
		(msg.roaming !== true && msg.roaming !== false) ||
		(msg.autoconfig !== true && msg.autoconfig !== false) ||
		typeof msg.apn !== "string" ||
		typeof msg.username !== "string" ||
		typeof msg.password !== "string" ||
		typeof msg.network !== "string" ||
		typeof msg.network_type !== "string"
	) {
		logger.error(`Received invalid configuration for modem ${msg.device}`);
		logger.debug("Invalid configuration message", msg);
		return { ok: false, reason: "invalid_config" };
	}

	// Ensure the selected network type is supported
	const networkType = modem.network_type.supported[msg.network_type];
	if (!networkType) {
		logger.error(
			`Received invalid network type ${msg.network_type} for modem ${msg.device}`,
		);
		return { ok: false, reason: "unsupported_network_type" };
	}

	// Only allow automatic network selection, the network previously saved, or a network included in the scan results
	if (
		msg.network &&
		msg.network !== "" &&
		msg.network !== modem.config.network &&
		!modem.available_networks?.[msg.network]
	) {
		logger.warn(
			`Received unavailable network ${msg.network} for modem ${msg.device}`,
		);
		return { ok: false, reason: "unavailable_network" };
	}

	// If a new network is selected, write it to the GSM operators cache
	const newNetwork =
		msg.network &&
		msg.network !== "" &&
		modem.available_networks?.[msg.network];
	if (newNetwork) {
		void setGsmOperatorName(msg.network, newNetwork.name);
	}

	// Captured BEFORE the write, because `sanitizeModemConfigForNetworkManager`
	// normalizes `modem.config` in place on its way through.
	const autoconfigSupported = deps.autoconfigSupported();
	const previousFields = normalizeModemConnectionFields(
		modem.config,
		autoconfigSupported,
	);

	// Temporary config that we'll attempt to write
	const updatedConfig: ModemConfig = {
		autoconfig: msg.autoconfig,
		apn: msg.apn,
		username: msg.username,
		password: msg.password,
		roaming: msg.roaming,
		network: msg.network,
	};
	const nextFields = normalizeModemConnectionFields(
		updatedConfig,
		autoconfigSupported,
	);
	const written = await deps.writeConnection(connUuid, updatedConfig);
	if (written) {
		// This preserves the 'conn' UUID value
		Object.assign(modem.config, updatedConfig);
		// Ahead of any reconnect below, so the profile NetworkManager brings back
		// up already agrees with the operator whichever one it picks.
		await deps.enforceAcrossProfiles(connUuid, updatedConfig);
	} else {
		logger.error(
			`Failed to update NM connection ${connUuid} for modem ${msg.device}`,
		);
		logger.debug("Failed modem config update", updatedConfig);
	}

	// Every gsm connect-time value is baked into the bearer, so a change to one
	// can only be applied by re-establishing it — but this used to run
	// UNCONDITIONALLY, so re-saving an untouched dialog, or toggling roaming and
	// putting it back, tore the bearer down for nothing. A write that failed is
	// likewise nothing to reactivate for.
	// The hold is read only once a change is established, so an untouched save
	// costs no nmcli spawn either.
	const changed =
		written && diffModemConnectionFields(previousFields, nextFields).length > 0;
	const decision = changed
		? decideModemReactivation({
				previous: previousFields,
				next: nextFields,
				hold: await deps.readConnectionHold(connUuid),
			})
		: ({ reactivate: false, reason: "unchanged" } as const);

	modem.inhibit = true;
	if (decision.reactivate) {
		logger.info(
			`Reconnecting modem ${msg.device} to apply ${decision.changed.join(", ")}`,
		);
		await deps.disconnect(connUuid);
	}

	// A refused radio-mode write is a FAILED save, not a footnote. This used to
	// be swallowed on the theory that the configure-echo reported it — but the
	// echo parrots the REQUEST, so a mode the modem rejected reached the operator
	// as "Saved" with the requested value locked into the dialog.
	let networkTypeWritten = true;
	if (msg.network_type !== modem.network_type.active) {
		const result = await deps.setNetworkTypes(
			msg.device,
			networkType.allowed,
			networkType.preferred,
		);
		if (result) {
			modem.network_type.active = msg.network_type;
		} else {
			networkTypeWritten = false;
			logger.error(
				`Failed to set network type ${msg.network_type} on modem ${msg.device}`,
			);
		}
	}
	delete modem.inhibit;

	// Send the updated settings to the clients
	broadcastModems({ [msg.device]: true });

	if (!written || !networkTypeWritten) {
		return { ok: false, reason: "write_failed" };
	}
	return { ok: true, reconnected: decision.reactivate };
}

async function handleModemScan(
	_conn: WebSocket,
	msg: ModemScanMessage["scan"],
) {
	const modemId = Number.parseInt(msg.device, 10);
	if (!msg || !getModem(modemId)) return;

	await modemNetworkScan(modemId);
}

export function handleModems(conn: WebSocket, msg: ModemsMessage["modems"]) {
	for (const type in msg) {
		switch (type) {
			case "config":
				void applyModemConfig(
					extractMessage<ModemConfigMessage, typeof type>(msg, type),
				);
				break;
			case "scan":
				void handleModemScan(
					conn,
					extractMessage<ModemScanMessage, typeof type>(msg, type),
				);
				break;
		}
	}
}

/** Private transport projection. Subscriber identifiers never enter the wire roster. */
export interface CellularNetworkTarget {
	readonly id: number;
	readonly key: string;
	readonly deviceId: string;
	readonly simId: string;
	readonly subscriber: string;
	readonly equipment: string;
	readonly ifname: string;
	readonly netDevice: string;
	readonly ifindex: string;
	readonly usbDevice: string;
	readonly generation: string;
	readonly identity: ModemTransportIdentity;
	readonly sim: ReadyModemSim;
}
export interface CellularControlTarget extends CellularNetworkTarget {
	readonly serial?: UsbSerialIdentity;
	readonly initialEps?: InitialEpsSettings;
}
/** Read-only physical/subscription observation; no vendor quirk grants writes. */
export async function readCellularNetworkTarget(
	id: number,
	key: string,
): Promise<CellularNetworkTarget | undefined> {
	const sim = await readReadyModemSim(id);
	if (!sim || sim === "unreadable") return undefined;
	const info = sim.modemInfo;
	const net = info["modem.generic.ports"].filter((p) => p.endsWith(" (net)"));
	if (net.length !== 1) return undefined;
	const ifname = net[0]?.slice(0, -6);
	if (!ifname || !/^[a-zA-Z0-9_-]{1,15}$/.test(ifname)) return undefined;
	const netDevice = await realpath(`/sys/class/net/${ifname}/device`);
	let usbDevice = netDevice;
	while (usbDevice !== dirname(usbDevice)) {
		try {
			await readFile(join(usbDevice, "devnum"));
			break;
		} catch {
			usbDevice = dirname(usbDevice);
		}
	}
	if (usbDevice === dirname(usbDevice)) return undefined;
	const mode = info["modem.generic.ports"].some((p) => p.endsWith(" (qmi)"))
		? "qmi"
		: info["modem.generic.ports"].some((p) => p.endsWith(" (mbim)"))
			? "mbim"
			: "rndis";
	const driver = basename(await realpath(join(netDevice, "driver")));
	if (
		(mode === "qmi" && driver !== "qmi_wwan") ||
		(mode === "mbim" && driver !== "cdc_mbim") ||
		(mode === "rndis" && driver !== "rndis_host")
	)
		return undefined;
	if (mode === "rndis") {
		const descriptor = await Promise.all(
			["bInterfaceClass", "bInterfaceSubClass", "bInterfaceProtocol"].map(
				(name) => readFile(join(netDevice, name), "utf8"),
			),
		);
		if (
			descriptor.map((value) => value.trim().toLowerCase()).join("/") !==
			"e0/01/03"
		)
			return undefined;
	}
	const identity = {
		model: info["modem.generic.model"],
		firmware: info["modem.generic.revision"] ?? "",
		mode,
	} as const;
	const deviceId = info["modem.generic.device-identifier"],
		simId = sim.simInfo["sim.properties.iccid"];
	if (!(await isModemPairAtStableKey(key, { deviceId, simId })))
		return undefined;
	return {
		id,
		key,
		deviceId,
		simId,
		subscriber: sim.simInfo["sim.properties.imsi"] ?? "",
		equipment: info["modem.generic.equipment-identifier"],
		ifname,
		netDevice,
		usbDevice,
		ifindex: (
			await readFile(`/sys/class/net/${ifname}/ifindex`, "utf8")
		).trim(),
		generation: await usbGeneration(usbDevice),
		identity,
		sim,
	};
}
/** Re-find the exact device+SIM through fresh enumeration after MM renumbers.
 * Raw transport reads stay in this existing facade. Duplicate or incomplete
 * inventories never select the first remembered index or port.
 */
export async function findCellularNetworkTarget(
	key: string,
	pair: { readonly deviceId: string; readonly simId: string },
	deps: {
		readonly list: () => Promise<readonly number[] | undefined>;
		readonly sim: typeof readReadyModemSim;
		readonly target: typeof readCellularNetworkTarget;
	} = {
		list: mmList,
		sim: readReadyModemSim,
		target: readCellularNetworkTarget,
	},
): Promise<CellularNetworkTarget | undefined> {
	const ids = await deps.list();
	if (!ids || ids.length > 32 || new Set(ids).size !== ids.length)
		return undefined;
	const matches: CellularNetworkTarget[] = [];
	for (const id of ids) {
		const sim = await deps.sim(id);
		if (
			!sim ||
			sim === "unreadable" ||
			sim.modemInfo["modem.generic.device-identifier"] !== pair.deviceId ||
			sim.simInfo["sim.properties.iccid"] !== pair.simId
		)
			continue;
		const target = await deps.target(id, key);
		if (
			target?.key === key &&
			target.id === id &&
			target.deviceId === pair.deviceId &&
			target.simId === pair.simId
		)
			matches.push(target);
	}
	return matches.length === 1 ? matches[0] : undefined;
}
export async function readCellularControlTarget(
	id: number,
	key: string,
): Promise<CellularControlTarget | undefined> {
	const target = await readCellularNetworkTarget(id, key);
	if (!target || !resolveTransportQuirk(target.identity)) return undefined;
	const { usbDevice } = target,
		info = target.sim.modemInfo;
	const candidates: UsbSerialIdentity[] = [];
	const primaryCandidates: UsbSerialIdentity[] = [];
	for (const port of info["modem.generic.ports"].filter((p) =>
		p.endsWith(" (at)"),
	)) {
		const candidate = await identifyUsbSerial(port.slice(0, -5), usbDevice);
		if (
			candidate &&
			!candidates.some((c) => c.usbInterface === candidate.usbInterface)
		) {
			candidates.push(candidate);
			const name = port.slice(0, -5);
			const dev = (await readFile(`/sys/class/tty/${name}/dev`, "utf8")).trim();
			if (/^\d+:\d+$/.test(dev)) {
				try {
					const data = await readFile(`/run/udev/data/c${dev}`, "utf8");
					if (/^E:ID_MM_PORT_TYPE_AT_PRIMARY=1$/m.test(data))
						primaryCandidates.push(candidate);
				} catch {
					/* Missing udev authority cannot select between AT interfaces. */
				}
			}
		}
	}
	const family = info["modem.3gpp.eps.initial-bearer.settings.ip-type"];
	const apn = info["modem.3gpp.eps.initial-bearer.settings.apn"];
	if (!(await cellularTargetPresent(target))) return undefined;
	return {
		...target,
		...(primaryCandidates.length === 1 && primaryCandidates[0]
			? { serial: primaryCandidates[0] }
			: primaryCandidates.length === 0 &&
					candidates.length === 1 &&
					candidates[0]
				? { serial: candidates[0] }
				: {}),
		...(apn !== undefined &&
		(family === "ipv4" || family === "ipv6" || family === "ipv4v6")
			? { initialEps: { apn, family } }
			: {}),
	};
}
export async function cellularTargetPresent(
	target: CellularNetworkTarget,
): Promise<boolean> {
	try {
		return (
			(await usbGeneration(target.usbDevice)) === target.generation &&
			(await realpath(`/sys/class/net/${target.ifname}/device`)) ===
				target.netDevice &&
			(
				await readFile(`/sys/class/net/${target.ifname}/ifindex`, "utf8")
			).trim() === target.ifindex
		);
	} catch {
		return false;
	}
}
/** Named read-only facade for native data-plane consumers. */
export function readCellularNativeBearer(target: CellularNetworkTarget) {
	return observeCellularNativeBearer(target, {
		target: readCellularNetworkTarget,
		bearer: readNativeBearer,
	});
}
export function parseCellularSubscriber(reply: string): string | undefined {
	const lines = reply
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line && line !== "AT+CIMI" && line !== "OK");
	return lines.length === 1 && /^\d{14,16}$/.test(lines[0] ?? "")
		? lines[0]
		: undefined;
}
export interface CellularControl {
	readonly valid: () => Promise<boolean>;
	/** Positive digit-only observation; unreadable is not a different SIM. */
	readonly readSubscriber: () => Promise<string | undefined>;
	readonly verifySubscriber: () => Promise<boolean>;
	readonly readAutoConnect: () => Promise<number | undefined>;
	readonly disableAutoConnect: () => Promise<boolean>;
	readonly reset: () => Promise<void>;
	readonly registration: () => Promise<boolean>;
	readonly registrationState: () => Promise<InternalRegistration>;
	readonly readContext: (cid: number) => Promise<InternalContext | undefined>;
	readonly contextActive: (cid: number) => Promise<boolean | undefined>;
	readonly readGrant: (cid: number) => Promise<InternalGrant | undefined>;
	readonly readContextDns: (
		cid: number,
	) => Promise<readonly string[] | undefined>;
	readonly onRevoked: (callback: () => void) => () => void;
	readonly defineContext: (
		cid: number,
		apn: string,
		family: RequestedFamily,
		settings?: readonly string[],
	) => Promise<void>;
	readonly activateContext: (cid: number, active: boolean) => Promise<void>;
	readonly readIpv4Grant: (cid: number) => Promise<string | undefined>;
	readonly close: () => Promise<void>;
}
const MM_DEST = "org.freedesktop.ModemManager1";
async function inhibitControl(
	transport: DbusTransport,
	uid: string,
	inhibit: boolean,
) {
	const reply = await transport.callMethod({
		destination: MM_DEST,
		path: "/org/freedesktop/ModemManager1",
		interface: MM_DEST,
		member: "InhibitDevice",
		signature: "sb",
		args: [uid, inhibit],
		timeoutMs: inhibit ? 300_000 : 10_000,
	});
	if (reply.signature !== "" || reply.body.length)
		throw new Error("Invalid inhibition acknowledgement");
}
export interface CellularControlAcquireDeps {
	readonly present: typeof cellularTargetPresent;
	readonly pair: typeof isModemPairAtStableKey;
	readonly resolveUid: (path: string) => Promise<string>;
	readonly transport: typeof createDbusTransport;
	readonly exchange: typeof exchangeUsbSerial;
}
const defaultCellularControlAcquireDeps: CellularControlAcquireDeps = {
	present: cellularTargetPresent,
	pair: isModemPairAtStableKey,
	resolveUid: realpath,
	transport: createCellularSystemTransport,
	exchange: exchangeUsbSerial,
};
/** Own a dedicated, non-reconnecting bus connection for the inhibition lifetime. */
export async function acquireCellularControl(
	target: CellularControlTarget,
	signal?: AbortSignal,
	deps: CellularControlAcquireDeps = defaultCellularControlAcquireDeps,
): Promise<CellularControl> {
	if (
		!target.serial ||
		!/^\d{14,16}$/.test(target.subscriber) ||
		!(await deps.present(target)) ||
		!(await deps.pair(target.key, target))
	)
		throw new Error("Cellular control identity unresolved");
	const uid = target.sim.modemInfo["modem.generic.device"];
	if (!uid || (await deps.resolveUid(uid)) !== target.usbDevice)
		throw new Error("Inhibition identity unresolved");
	const serial = target.serial;
	const transport = deps.transport({
		reconnect: { enabled: false },
		callTimeoutMs: 300_000,
	});
	let held = false,
		closed = false,
		revoked = false;
	const revocationListeners = new Set<() => void>();
	const revoke = () => {
		if (revoked) return;
		revoked = true;
		for (const callback of revocationListeners) callback();
	};
	transport.on("disconnected", revoke);
	signal?.addEventListener("abort", revoke, { once: true });
	const valid = async () =>
		held &&
		!closed &&
		!revoked &&
		!signal?.aborted &&
		transport.isConnected() &&
		(await deps.present(target));
	const exchange = async (command: string) =>
		deps.exchange(serial, command, valid, signal);
	const readSubscriber = async () =>
		parseCellularSubscriber(await exchange("AT+CIMI"));
	const verifySubscriber = async () =>
		(await readSubscriber()) === target.subscriber;
	const requireSubscriber = async () => {
		if (!(await verifySubscriber()))
			throw new Error("Cellular subscription changed");
	};
	const cidArg = (cid: number) => {
		if (!Number.isInteger(cid) || cid < 1 || cid > 16)
			throw new Error("Invalid context");
		return cid;
	};
	const close = async () => {
		if (closed) return;
		closed = true;
		try {
			if (held && !revoked && transport.isConnected())
				await inhibitControl(transport, uid, false);
		} finally {
			held = false;
			signal?.removeEventListener("abort", revoke);
			await transport.disconnect();
		}
	};
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
				if (event.body[0] === MM_DEST) revoke();
			},
		);
		await inhibitControl(transport, uid, true);
		held = true;
		// A successful call is the ownership acknowledgement; the dedicated connection
		// must remain alive. A disconnected/replaced bus never regains ownership.
		if (!(await valid()) || !(await verifySubscriber()))
			throw new Error("Cellular control not verified");
		const quirk = resolveTransportQuirk(target.identity);
		const requireQmap = () => {
			if (!quirk?.qmapReadback)
				throw new Error("Transport operation not admitted");
		};
		const requireInternal = () => {
			if (quirk?.owner !== "internal-call")
				throw new Error("Transport operation not admitted");
		};
		return {
			valid,
			readSubscriber,
			verifySubscriber,
			onRevoked: (callback) => {
				revocationListeners.add(callback);
				if (revoked || closed || signal?.aborted) callback();
				return () => {
					revocationListeners.delete(callback);
				};
			},
			registrationState: async () =>
				parseInternalRegistration(await exchange("AT+CEREG?")),
			readContext: async (cid) => {
				requireInternal();
				return parseInternalContext(await exchange("AT+CGDCONT?"), cidArg(cid));
			},
			contextActive: async (cid) => {
				requireInternal();
				return parseInternalContextActive(
					await exchange("AT+CGACT?"),
					cidArg(cid),
				);
			},
			readGrant: async (cid) => {
				requireInternal();
				return parseInternalGrant(
					await exchange(`AT+CGPADDR=${cidArg(cid)}`),
					cid,
				);
			},
			readContextDns: async (cid) => {
				requireInternal();
				return parseInternalContextDns(
					await exchange(`AT+CGCONTRDP=${cidArg(cid)}`),
					cid,
				);
			},
			readAutoConnect: async () => {
				requireQmap();
				return parseQmapAutoConnect(await exchange('AT+QMAP="auto_connect"'));
			},
			disableAutoConnect: async () => {
				requireQmap();
				await requireSubscriber();
				await exchange('AT+QMAP="auto_connect",0,0');
				return (
					parseQmapAutoConnect(await exchange('AT+QMAP="auto_connect"')) === 0
				);
			},
			reset: async () => {
				await requireSubscriber();
				await exchange("AT+CFUN=1,1");
			},
			registration: async () => {
				const reply = await exchange("AT+CEREG?");
				return ["home", "roaming"].includes(parseInternalRegistration(reply));
			},
			defineContext: async (cid, apn, family, settings) => {
				requireInternal();
				const command = internalContextCommand(
					cidArg(cid),
					apn,
					family,
					settings,
				);
				await requireSubscriber();
				await exchange(command);
			},
			activateContext: async (cid, active) => {
				requireInternal();
				await requireSubscriber();
				await exchange(`AT+CGACT=${active ? 1 : 0},${cidArg(cid)}`);
			},
			readIpv4Grant: async (cid) => {
				requireInternal();
				return parseInternalIpv4Grant(
					await exchange(`AT+CGPADDR=${cidArg(cid)}`),
					cid,
				);
			},
			close,
		};
	} catch (error) {
		await close().catch(() => undefined);
		throw error;
	}
}
export async function setCellularInitialEps(
	target: CellularControlTarget,
	settings: InitialEpsSettings,
): Promise<boolean> {
	if (
		!/^[a-zA-Z0-9._-]{1,100}$/.test(settings.apn) ||
		!(await cellularTargetPresent(target)) ||
		!(await isModemPairAtStableKey(target.key, target))
	)
		return false;
	try {
		await run(
			mmcliBinary,
			[
				"-m",
				String(target.id),
				`--3gpp-set-initial-eps-bearer-settings=apn=${settings.apn},ip-type=${settings.family}`,
			],
			{ timeout: 60_000, maxBuffer: 16384 },
		);
		return true;
	} catch {
		return false;
	}
}
export async function resetCellularTarget(
	target: CellularControlTarget,
): Promise<boolean> {
	if (
		!(await cellularTargetPresent(target)) ||
		!(await isModemPairAtStableKey(target.key, target))
	)
		return false;
	try {
		await run(mmcliBinary, ["-m", String(target.id), "--reset"], {
			timeout: 60_000,
			maxBuffer: 16384,
		});
		return true;
	} catch {
		return false;
	}
}
export async function readCellularRawIp(
	target: CellularControlTarget,
): Promise<"Y" | "N" | undefined> {
	if (!(await cellularTargetPresent(target))) return undefined;
	const value = (
		await readFile(`/sys/class/net/${target.ifname}/qmi/raw_ip`, "utf8")
	).trim();
	return value === "Y" || value === "N" ? value : undefined;
}

export async function writeCellularRawIp(
	target: CellularControlTarget,
	wanted: "Y" | "N",
): Promise<boolean> {
	if (
		!resolveTransportQuirk(target.identity)?.rawIpBeforeCall ||
		!(await cellularTargetPresent(target))
	)
		return false;
	const state: unknown = JSON.parse(
		await run("ip", ["-j", "address", "show", "dev", target.ifname], {
			timeout: 5000,
			maxBuffer: 65536,
		}),
	);
	if (!Array.isArray(state) || state.length !== 1) return false;
	const row = state[0] as { ifindex?: unknown; addr_info?: unknown };
	if (
		String(row.ifindex) !== target.ifindex ||
		!Array.isArray(row.addr_info) ||
		row.addr_info.some(
			(address: unknown) =>
				!address ||
				typeof address !== "object" ||
				!("scope" in address) ||
				address.scope === "global",
		)
	)
		return false;
	const handle = await open(
		`/sys/class/net/${target.ifname}/qmi/raw_ip`,
		constants.O_WRONLY | constants.O_NOFOLLOW,
	);
	try {
		if (!(await cellularTargetPresent(target))) return false;
		await run("ip", ["link", "set", "dev", target.ifname, "down"], {
			timeout: 5000,
			maxBuffer: 4096,
		});
		if (!(await cellularTargetPresent(target))) return false;
		await handle.writeFile(wanted);
	} finally {
		await handle.close();
	}
	return (
		(await cellularTargetPresent(target)) &&
		(await readCellularRawIp(target)) === wanted
	);
}
