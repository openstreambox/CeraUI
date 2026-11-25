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

/**
 * RESTART MODEM: one operator-requested restart of one qualified modem.
 *
 * The method per model and the expected downtime come from
 * `MODEM_RESTART_MODELS` (`@ceraui/rpc`), which only lists models a bench run
 * qualified. The order of everything below is deliberate:
 *
 * 1. Pure checks first (known modem, qualified model, one restart at a time,
 *    cooldown), so a doomed request never contends for the modem's lease.
 * 2. The only-link guard: while a stream runs, a restart of the modem that is
 *    the only connection in the bond stops the stream from sending until it is
 *    back. That is refused unless the operator confirmed exactly that cost.
 *    Missing link telemetry while streaming counts as "only link".
 * 3. The restart runs under {@link withModemRestartLease}: same-modem exclusion
 *    that never refuses a Stream Start.
 * 4. ModemManager's reset first. Only when ModemManager definitively REFUSES it
 *    (mmcli exits with "couldn't reset the modem") is the modem's own USB device
 *    unbound and bound once, after the admission and only-link checks are run
 *    again and the device's USB ids are checked against the model. A timeout or
 *    a transport failure may still have delivered the reset, so it is treated as
 *    sent and only observed. A modem that accepted the reset and did not come
 *    back gets no second action: there is no retry loop anywhere in this module.
 * 5. The modem comes back under a NEW ModemManager index every time (measured on
 *    both models, after a reset and after a USB rebind), so it is found again by
 *    its `stable_key`, the ID_PATH-derived key of the USB port it sits on. The
 *    port, the network interface name and the key stayed the same across every
 *    bench restart.
 *
 * Nothing is persisted: a restart changes no setting, so there is nothing to
 * roll back, and the cooldown deliberately resets with the backend.
 */

import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
	MODEM_RESTART_COOLDOWN_SECONDS,
	type ModemRestartQualification,
	modemRestartQualification,
	type RestartModemInput,
	type RestartModemMethod,
	type RestartModemOutput,
	type RestartModemRefusal,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { buildLinkTelemetry } from "../streaming/link-telemetry.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { resolveModemIndex } from "./five-g-apply.ts";
import { getModems, type Modem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import {
	modemRestartAdmissionRefusal,
	withModemRestartLease,
} from "./mutation-lease.ts";

/** A USB device's kernel name, e.g. `2-1.4` or `9-1`; never an interface (`9-1:1.4`). */
const USB_DEVICE_NAME = /^\d+-\d+(?:\.\d+)*$/;

/**
 * What became of ModemManager's reset (`mmResetModem` in the ModemManager
 * transport module, injected by the RPC procedure so this module stays outside
 * the transport boundary):
 *   accepted  mmcli confirmed it.
 *   refused   ModemManager answered that it could not reset the modem.
 *   unknown   a timeout, a transport failure or anything else: the reset may
 *             have been delivered, so it is observed, never followed by a rebind.
 */
export type MmResetResult = "accepted" | "refused" | "unknown";

export type ModemRestartDeps = {
	readonly modems: () => Readonly<Record<number, Modem>>;
	readonly stableKeyForId: (id: number) => string | undefined;
	readonly mmReset: (id: number) => Promise<MmResetResult>;
	/**
	 * Unbind and bind the USB device behind `ifname` once, but only when that
	 * device carries one of `usbIds`; true when both writes landed.
	 */
	readonly usbRebind: (
		ifname: string,
		usbIds: readonly string[],
	) => Promise<boolean>;
	readonly isStreaming: () => boolean;
	/**
	 * Whether a bond link that is positively another uplink than `ifname` (another
	 * modem's interface, Ethernet, Wi-Fi or a USB network device; never a CLAT
	 * alias or an unresolved row) is live and has carried data. `undefined` when
	 * there is no telemetry to judge by.
	 */
	readonly otherLinkLive: (
		ifname: string,
		otherModemIfnames: readonly string[],
	) => boolean | undefined;
	/** Admission rules the lease applies, re-run before a USB rebind. */
	readonly admissionRefusal: (
		stableKey: string,
	) => RestartModemRefusal | undefined;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly pollMs: number;
};

/**
 * The USB device a network interface belongs to: `/sys/class/net/<if>/device`
 * resolves to the USB INTERFACE (`.../9-1/9-1:1.4`), whose parent is the device.
 * Anything that does not resolve to a USB device name under `/sys/devices` is
 * refused rather than guessed.
 */
export async function usbDeviceForInterface(
	ifname: string,
	resolve: (path: string) => Promise<string> = realpath,
): Promise<string | undefined> {
	if (!/^[A-Za-z0-9_.-]{1,15}$/.test(ifname)) return undefined;
	let target: string;
	try {
		target = await resolve(`/sys/class/net/${ifname}/device`);
	} catch {
		return undefined;
	}
	if (!target.startsWith("/sys/devices/")) return undefined;
	const device = basename(dirname(target));
	return USB_DEVICE_NAME.test(device) ? device : undefined;
}

/** The `vendor:product` of a USB device by kernel name, or undefined when unreadable. */
export async function usbIdsOf(
	device: string,
	read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string | undefined> {
	if (!USB_DEVICE_NAME.test(device)) return undefined;
	try {
		const vendor = (
			await read(`/sys/bus/usb/devices/${device}/idVendor`)
		).trim();
		const product = (
			await read(`/sys/bus/usb/devices/${device}/idProduct`)
		).trim();
		return /^[0-9a-f]{4}$/.test(vendor) && /^[0-9a-f]{4}$/.test(product)
			? `${vendor}:${product}`
			: undefined;
	} catch {
		return undefined;
	}
}

async function usbRebindInterface(
	ifname: string,
	usbIds: readonly string[],
): Promise<boolean> {
	// Re-resolved now, not trusted from the roster: the interface must still sit
	// on a USB device of this model.
	const device = await usbDeviceForInterface(ifname);
	if (device === undefined) return false;
	const ids = await usbIdsOf(device);
	if (ids === undefined || !usbIds.includes(ids)) return false;
	try {
		await writeFile("/sys/bus/usb/drivers/usb/unbind", device);
	} catch {
		return false;
	}
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	try {
		await writeFile("/sys/bus/usb/drivers/usb/bind", device);
		return true;
	} catch {
		// The device is left unbound; a replug or reboot brings it back. Say so
		// rather than claiming a restart.
		return false;
	}
}

/** Kernel names of uplinks that can never be an alias of a cellular modem's link. */
const NON_CELLULAR_UPLINK = /^(?:eth|en|wl|usb)[A-Za-z0-9_.-]*$/;

/**
 * Pure rule behind `otherLinkLive`: a row counts only when its interface is
 * positively a different uplink, it is fresh, and it has carried data.
 */
export function otherBondLinkLiveIn(
	links: readonly {
		readonly iface: string;
		readonly stale: boolean;
		readonly bytes_sent_total?: number | undefined;
		readonly bitrate_bps?: number | undefined;
		readonly identity_state?: string | undefined;
	}[],
	ifname: string,
	otherModemIfnames: readonly string[],
): boolean {
	return links.some(
		(link) =>
			link.iface !== ifname &&
			!link.stale &&
			link.identity_state !== "unmappable" &&
			!link.iface.startsWith("clat") &&
			(otherModemIfnames.includes(link.iface) ||
				NON_CELLULAR_UPLINK.test(link.iface)) &&
			((link.bytes_sent_total ?? 0) > 0 || (link.bitrate_bps ?? 0) > 0),
	);
}

function otherBondLinkLive(
	ifname: string,
	otherModemIfnames: readonly string[],
): boolean | undefined {
	const telemetry = buildLinkTelemetry();
	if (telemetry === null) return undefined;
	return otherBondLinkLiveIn(telemetry.links, ifname, otherModemIfnames);
}

/** Everything but the reset transport, which the caller supplies. */
export const defaultModemRestartDeps: Omit<ModemRestartDeps, "mmReset"> = {
	modems: getModems,
	stableKeyForId: modemStableKeyForId,
	usbRebind: usbRebindInterface,
	isStreaming: getIsStreaming,
	otherLinkLive: otherBondLinkLive,
	admissionRefusal: modemRestartAdmissionRefusal,
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	pollMs: 2_000,
};

/** Forget the one-at-a-time claim and every cooldown (tests). */
export function resetModemRestartDeps(): void {
	restarting = undefined;
	lastAttemptEnded.clear();
}

/** The stable key of the modem restarting right now; one at a time, device-wide. */
let restarting: string | undefined;
/** When each modem's last attempt ended, for the cooldown. */
const lastAttemptEnded = new Map<string, number>();

function findByStableKey(
	stableKey: string,
	deps: ModemRestartDeps,
): { id: number; modem: Modem } | undefined {
	for (const [key, modem] of Object.entries(deps.modems())) {
		const id = Number(key);
		if (deps.stableKeyForId(id) === stableKey) return { id, modem };
	}
	return undefined;
}

function otherModemIfnames(id: number, deps: ModemRestartDeps): string[] {
	return Object.entries(deps.modems())
		.filter(([key, modem]) => Number(key) !== id && modem.ifname !== "")
		.map(([, modem]) => modem.ifname);
}

/** Every refusal goes through here, so each one leaves the same warning line. */
function refuse(
	refusal: RestartModemRefusal,
	family: string | undefined,
	extra: { retryAfterSeconds?: number } = {},
): RestartModemOutput {
	logger.warn("modem restart refused", {
		module: "modems",
		restartRefusal: refusal,
		...(family ? { restartFamily: family } : {}),
		...(extra.retryAfterSeconds !== undefined
			? { retryAfterSeconds: extra.retryAfterSeconds }
			: {}),
	});
	return { started: false, refusal, ...extra };
}

/** Whether the only-link guard stops this restart. */
function onlyLinkBlocks(
	id: number,
	ifname: string,
	input: RestartModemInput,
	deps: ModemRestartDeps,
): boolean {
	return (
		deps.isStreaming() &&
		deps.otherLinkLive(ifname, otherModemIfnames(id, deps)) !== true &&
		input.onlyLinkConfirmed !== true
	);
}

export async function restartModem(
	input: RestartModemInput,
	deps: ModemRestartDeps,
): Promise<RestartModemOutput> {
	const id = resolveModemIndex(input.device);
	const modem = id === undefined ? undefined : deps.modems()[id];
	if (id === undefined || modem === undefined)
		return refuse("unknown_modem", undefined);

	const qualification = modemRestartQualification(modem.model);
	if (qualification === undefined) return refuse("not_qualified", undefined);
	const family = qualification.family;

	const stableKey = deps.stableKeyForId(id);
	if (!stableKey) return refuse("identity_unresolved", family);
	// The index the operator confirmed must still be the modem they confirmed.
	if (stableKey !== input.stableKey) return refuse("unknown_modem", family);

	if (restarting !== undefined) return refuse("restart_in_progress", family);

	const ended = lastAttemptEnded.get(stableKey);
	if (ended !== undefined) {
		const left = Math.ceil(
			(ended + MODEM_RESTART_COOLDOWN_SECONDS * 1000 - deps.now()) / 1000,
		);
		if (left > 0)
			return refuse("cooldown", family, { retryAfterSeconds: left });
	}

	if (onlyLinkBlocks(id, modem.ifname, input, deps))
		return refuse("only_link_live", family);

	// Claimed synchronously, before the first await, so two requests in the same
	// tick cannot both pass the one-at-a-time check.
	restarting = stableKey;
	try {
		const outcome = await withModemRestartLease(stableKey, () =>
			runRestart(id, modem, stableKey, qualification, input, deps),
		);
		if (!outcome.ok) return refuse(outcome.refusal, family);
		if (outcome.value.started) lastAttemptEnded.set(stableKey, deps.now());
		return outcome.value;
	} finally {
		restarting = undefined;
	}
}

async function runRestart(
	id: number,
	modem: Modem,
	stableKey: string,
	qualification: ModemRestartQualification,
	input: RestartModemInput,
	deps: ModemRestartDeps,
): Promise<RestartModemOutput> {
	const ifname = modem.ifname;
	const family = qualification.family;
	const startedAt = deps.now();
	const elapsed = () => Math.round((deps.now() - startedAt) / 100) / 10;
	logger.info("modem restart started", {
		module: "modems",
		restartFamily: family,
		oldDevice: id,
		streaming: deps.isStreaming(),
	});

	let method: RestartModemMethod = "mm-reset";
	const reset = await deps.mmReset(id);
	if (reset === "refused") {
		// Nothing has happened to the modem yet. Before acting on the USB device,
		// apply the same admission and only-link rules again: the reset took time.
		const late = deps.admissionRefusal(stableKey);
		if (late) return refuse(late, family);
		if (onlyLinkBlocks(id, ifname, input, deps))
			return refuse("only_link_live", family);
		method = "usb-rebind";
		if (!(await deps.usbRebind(ifname, qualification.usbIds))) {
			const result: RestartModemOutput = {
				started: true,
				outcome: "failed",
				method,
				elapsedSeconds: elapsed(),
			};
			logModemRestartOutcome(family, id, result);
			return result;
		}
	}

	// Wait for the modem to leave and come back on the same port. "Left" is seen
	// as no modem on this key, or the key under a different index; a modem that is
	// still listed under its old index has not restarted yet. The verdict comes
	// from the LAST observation, so a modem that came back and went again is
	// reported as gone.
	let left = false;
	let last: { id: number; modem: Modem } | undefined;
	while (deps.now() - startedAt < qualification.boundSeconds * 1000) {
		await deps.sleep(deps.pollMs);
		last = findByStableKey(stableKey, deps);
		if (last === undefined || last.id !== id) left = true;
		if (left && last?.modem.status?.connection === "connected") {
			const result: RestartModemOutput = {
				started: true,
				outcome: "back_connected",
				method,
				elapsedSeconds: elapsed(),
				device: String(last.id),
			};
			logModemRestartOutcome(family, id, result);
			return result;
		}
	}
	const result: RestartModemOutput = !left
		? { started: true, outcome: "unchanged", method, elapsedSeconds: elapsed() }
		: last === undefined
			? {
					started: true,
					outcome: "not_back",
					method,
					elapsedSeconds: elapsed(),
				}
			: {
					started: true,
					outcome: "back_not_connected",
					method,
					elapsedSeconds: elapsed(),
					device: String(last.id),
					...(last.modem.status?.connection
						? { connection: last.modem.status.connection }
						: {}),
				};
	logModemRestartOutcome(family, id, result);
	return result;
}

function logModemRestartOutcome(
	family: string,
	oldId: number,
	result: RestartModemOutput,
): void {
	const meta = {
		module: "modems",
		restartFamily: family,
		restartMethod: result.method,
		restartOutcome: result.outcome,
		oldDevice: oldId,
		...(result.device !== undefined
			? { newDevice: Number(result.device) }
			: {}),
		elapsedSeconds: result.elapsedSeconds,
	};
	if (result.outcome === "back_connected")
		logger.info("modem restart finished", meta);
	else logger.warn("modem restart finished without a connection", meta);
}
