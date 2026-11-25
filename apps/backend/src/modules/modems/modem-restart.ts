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
 * 4. ModemManager's reset first. Only when ModemManager REFUSES it (an error,
 *    not a slow return) is the modem's own USB device unbound and bound once.
 *    A modem that accepted the reset and did not come back gets no second
 *    action: there is no retry loop anywhere in this module.
 * 5. The modem comes back under a NEW ModemManager index every time (measured on
 *    both models, after a reset and after a USB rebind), so it is found again by
 *    its `stable_key`, the ID_PATH-derived key of the USB port it sits on. The
 *    port, the network interface name and the key stayed the same across every
 *    bench restart.
 *
 * Nothing is persisted: a restart changes no setting, so there is nothing to
 * roll back, and the cooldown deliberately resets with the backend.
 */

import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
	MODEM_RESTART_COOLDOWN_SECONDS,
	modemRestartQualification,
	type RestartModemInput,
	type RestartModemMethod,
	type RestartModemOutput,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { buildLinkTelemetry } from "../streaming/link-telemetry.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { describeCliError } from "../system/cli-parse.ts";
import { resolveModemIndex } from "./five-g-apply.ts";
import { mmcliBinary } from "./mmcli.ts";
import { getModems, type Modem } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withModemRestartLease } from "./mutation-lease.ts";

/** A USB device's kernel name, e.g. `2-1.4` or `9-1`; never an interface (`9-1:1.4`). */
const USB_DEVICE_NAME = /^\d+-\d+(?:\.\d+)*$/;

export type ModemRestartDeps = {
	readonly modems: () => Readonly<Record<number, Modem>>;
	readonly stableKeyForId: (id: number) => string | undefined;
	/** `mmcli -m <id> --reset`; true when ModemManager accepted it. */
	readonly mmReset: (id: number) => Promise<boolean>;
	/** Unbind and bind the USB device behind `ifname` once; true when both writes landed. */
	readonly usbRebind: (ifname: string) => Promise<boolean>;
	readonly isStreaming: () => boolean;
	/**
	 * Whether a bond link other than `ifname` is live in the sender's telemetry.
	 * `undefined` when there is no telemetry to judge by.
	 */
	readonly otherLinkLive: (ifname: string) => boolean | undefined;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly pollMs: number;
};

async function mmResetModem(id: number): Promise<boolean> {
	try {
		await run(mmcliBinary, ["-m", String(id), "--reset"]);
		return true;
	} catch (err) {
		logger.warn(
			`modem restart: ModemManager refused the reset: ${describeCliError(err)}`,
			{
				module: "modems",
			},
		);
		return false;
	}
}

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

async function usbRebindInterface(ifname: string): Promise<boolean> {
	const device = await usbDeviceForInterface(ifname);
	if (device === undefined) return false;
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

function otherBondLinkLive(ifname: string): boolean | undefined {
	const telemetry = buildLinkTelemetry();
	if (telemetry === null) return undefined;
	return telemetry.links.some((link) => link.iface !== ifname && !link.stale);
}

export const defaultModemRestartDeps: ModemRestartDeps = {
	modems: getModems,
	stableKeyForId: modemStableKeyForId,
	mmReset: mmResetModem,
	usbRebind: usbRebindInterface,
	isStreaming: getIsStreaming,
	otherLinkLive: otherBondLinkLive,
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	pollMs: 2_000,
};

let activeDeps: ModemRestartDeps = defaultModemRestartDeps;

export function setModemRestartDeps(deps: Partial<ModemRestartDeps>): void {
	activeDeps = { ...defaultModemRestartDeps, ...deps };
}

export function resetModemRestartDeps(): void {
	activeDeps = defaultModemRestartDeps;
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

export async function restartModem(
	input: RestartModemInput,
	deps: ModemRestartDeps = activeDeps,
): Promise<RestartModemOutput> {
	const id = resolveModemIndex(input.device);
	const modem = id === undefined ? undefined : deps.modems()[id];
	if (id === undefined || modem === undefined)
		return { started: false, refusal: "unknown_modem" };

	const qualification = modemRestartQualification(modem.model);
	if (qualification === undefined) {
		logger.warn("modem restart refused: model not qualified", {
			module: "modems",
			model: modem.model,
		});
		return { started: false, refusal: "not_qualified" };
	}

	const stableKey = deps.stableKeyForId(id);
	if (!stableKey) return { started: false, refusal: "identity_unresolved" };

	if (restarting !== undefined)
		return { started: false, refusal: "restart_in_progress" };

	const ended = lastAttemptEnded.get(stableKey);
	if (ended !== undefined) {
		const left = Math.ceil(
			(ended + MODEM_RESTART_COOLDOWN_SECONDS * 1000 - deps.now()) / 1000,
		);
		if (left > 0)
			return { started: false, refusal: "cooldown", retryAfterSeconds: left };
	}

	if (deps.isStreaming() && deps.otherLinkLive(modem.ifname) !== true) {
		if (input.onlyLinkConfirmed !== true) {
			logger.warn("modem restart refused: only link carrying the stream", {
				module: "modems",
				stableKey,
			});
			return { started: false, refusal: "only_link_live" };
		}
	}

	// Claimed synchronously, before the first await, so two requests in the same
	// tick cannot both pass the one-at-a-time check.
	restarting = stableKey;
	try {
		const outcome = await withModemRestartLease(stableKey, () =>
			runRestart(id, modem, stableKey, qualification.boundSeconds, deps),
		);
		if (!outcome.ok) {
			logger.warn("modem restart refused by the modem lease", {
				module: "modems",
				stableKey,
				refusal: outcome.refusal,
			});
			return { started: false, refusal: outcome.refusal };
		}
		lastAttemptEnded.set(stableKey, deps.now());
		return outcome.value;
	} finally {
		restarting = undefined;
	}
}

async function runRestart(
	id: number,
	modem: Modem,
	stableKey: string,
	boundSeconds: number,
	deps: ModemRestartDeps,
): Promise<RestartModemOutput> {
	const ifname = modem.ifname;
	const startedAt = deps.now();
	const elapsed = () => Math.round((deps.now() - startedAt) / 100) / 10;
	logger.info("modem restart started", {
		module: "modems",
		stableKey,
		model: modem.model,
		device: id,
		streaming: deps.isStreaming(),
	});

	let method: RestartModemMethod = "mm-reset";
	if (!(await deps.mmReset(id))) {
		method = "usb-rebind";
		if (!(await deps.usbRebind(ifname))) {
			logger.error(
				"modem restart failed: neither the reset nor the USB rebind ran",
				{
					module: "modems",
					stableKey,
					device: id,
				},
			);
			return {
				started: true,
				outcome: "failed",
				method,
				elapsedSeconds: elapsed(),
			};
		}
	}

	// Wait for the modem to leave and come back on the same port. "Left" is seen
	// as no modem on this key, or the key under a different index; a modem that is
	// still listed under its old index has not restarted yet.
	let left = false;
	let back: { id: number; modem: Modem } | undefined;
	while (deps.now() - startedAt < boundSeconds * 1000) {
		await deps.sleep(deps.pollMs);
		const found = findByStableKey(stableKey, deps);
		if (found === undefined || found.id !== id) left = true;
		if (!left || found === undefined) continue;
		back = found;
		if (found.modem.status?.connection === "connected") {
			const result: RestartModemOutput = {
				started: true,
				outcome: "back_connected",
				method,
				elapsedSeconds: elapsed(),
				device: String(found.id),
			};
			logModemRestartOutcome(stableKey, modem, id, result);
			return result;
		}
	}
	const result: RestartModemOutput = !left
		? { started: true, outcome: "unchanged", method, elapsedSeconds: elapsed() }
		: back === undefined
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
					device: String(back.id),
					...(back.modem.status?.connection
						? { connection: back.modem.status.connection }
						: {}),
				};
	logModemRestartOutcome(stableKey, modem, id, result);
	return result;
}

function logModemRestartOutcome(
	stableKey: string,
	modem: Modem,
	oldId: number,
	result: RestartModemOutput,
): void {
	const meta = {
		module: "modems",
		stableKey,
		model: modem.model,
		method: result.method,
		outcome: result.outcome,
		oldDevice: oldId,
		newDevice: result.device,
		elapsedSeconds: result.elapsedSeconds,
	};
	if (result.outcome === "back_connected")
		logger.info("modem restart finished", meta);
	else logger.warn("modem restart finished without a connection", meta);
}
