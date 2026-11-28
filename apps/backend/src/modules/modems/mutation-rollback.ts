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
 * Capturing a modem's pre-state, and putting it back.
 *
 * The capture is DESCRIPTOR-level and deliberately generic: vid:pid, model,
 * firmware revision, composition mode and ifname, read from the same udev/sysfs
 * enumeration every other identity decision on this device uses. That is what a
 * rollback has to restore and what an acknowledgement has to compare against, and
 * keeping it in one shape means the verification path cannot disagree with the
 * arming path about what "the same state" means.
 *
 * A kind that CAN be put back registers a handler. A kind that cannot has no
 * handler and its rollback answers `unavailable` — which leaves the device
 * fail-closed until an operator acknowledges, rather than pretending a restore
 * happened. That asymmetry is the design: a rollback we cannot perform must be
 * visible, never inferred.
 *
 * `capture` answering `undefined` is the ABSENT-DEVICE signal. It is distinct from
 * a capture that read a device and found a different state, because the two have
 * opposite handling — absence quarantines, difference blocks.
 */

import { join } from "node:path";
import {
	createUsbEnumerator,
	detectUsbMode,
	type UsbDeviceSnapshot,
} from "@ceralive/modem-control";
import {
	deriveModemStableKey,
	type ModemMutationKind,
} from "@ceraui/rpc/schemas";
import { getConfig } from "../config.ts";
import { readMutationUdevExportDb } from "./modem-id-path-source.ts";
import {
	assertMutationJournalRevision,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";
import {
	mintLinkId,
	readUsbSerialAttribute,
	usbSerialIdentity,
} from "./physical-identity.ts";

export type CapturedState = Readonly<Record<string, unknown>>;

export type RollbackResult =
	| "restored"
	| "failed"
	| "unavailable"
	| "absent"
	// A different unit, positively identified, sits at the journaled port.
	| "replaced"
	// A device sits at the port, but its unit could not be established.
	| "presence-unknown"
	// The journal could not prove the modem's unit when it began.
	| "unproven";

export interface MutationRollbackHandler {
	/** A kind-specific durable witness can supersede generic USB capture. */
	rollbackIfAuthoritative?(
		preState: CapturedState,
	): Promise<"restored" | "failed"> | undefined;
	rollback(
		stableKey: string,
		preState: CapturedState,
	): Promise<"restored" | "failed">;
}

const handlers = new Map<ModemMutationKind, MutationRollbackHandler>();
const configInverses = new Map<string, MutationRollbackHandler>();

export function registerMutationRollback(
	kind: ModemMutationKind,
	handler: MutationRollbackHandler,
): void {
	handlers.set(kind, handler);
}

export function registerModemConfigInverse(
	format: string,
	handler: MutationRollbackHandler,
): void {
	configInverses.set(format, handler);
	registerMutationRollback("modem-config", {
		rollback: async (key, state) => {
			const inverse =
				typeof state.format === "string"
					? configInverses.get(state.format)
					: undefined;
			return inverse ? inverse.rollback(key, state) : "failed";
		},
	});
}

export function clearMutationRollbacks(): void {
	configInverses.clear();
	handlers.clear();
}

export interface MutationCaptureDeps {
	enumerate(
		readUdevDatabase?: () => Promise<string>,
	): Promise<readonly UsbDeviceSnapshot[]>;
	readSerial(path: string): Promise<string | undefined>;
	/** The kernel's device number at a sysfs path: it changes on every replug. */
	readDevnum(path: string): Promise<string | undefined>;
}

export const defaultMutationCaptureDeps: MutationCaptureDeps = {
	enumerate: (readUdevDatabase = readMutationUdevExportDb) =>
		createUsbEnumerator({ readUdevDatabase }).enumerate(),
	readSerial: (path) => readUsbSerialAttribute(join(path, "serial")),
	readDevnum: (path) => readUsbSerialAttribute(join(path, "devnum")),
};

let activeDeps: MutationCaptureDeps = defaultMutationCaptureDeps;

export function setMutationCaptureDeps(
	deps: Partial<MutationCaptureDeps>,
): void {
	activeDeps = { ...defaultMutationCaptureDeps, ...deps };
}

export function resetMutationCaptureDeps(): void {
	activeDeps = defaultMutationCaptureDeps;
}

export function enumerateMutationUsb(readUdevDatabase: () => Promise<string>) {
	return activeDeps.enumerate(readUdevDatabase);
}

export function captureUsbDescriptor(device: UsbDeviceSnapshot) {
	return {
		vidPid: `${device.vendorId.toLowerCase()}:${device.productId.toLowerCase()}`,
		model: device.model ?? "",
		firmwareRevision: device.firmwareRevision ?? "",
		mode: detectUsbMode(device) ?? "unknown",
	};
}

function deviceNumber(value: string | undefined): number | undefined {
	return value !== undefined && /^\d+$/.test(value.trim())
		? Number(value.trim())
		: undefined;
}

async function serialFor(device: UsbDeviceSnapshot, deps: MutationCaptureDeps) {
	// modem-control 1.4.0 preserves the udev property without promoting it.
	const property =
		device.udevProperties?.ID_SERIAL_SHORT ??
		device.udevProperties?.ID_USB_SERIAL_SHORT;
	let attribute: string | undefined;
	let unbound: string | undefined;
	let unproven = false;
	if (device.sysfsPath !== undefined) {
		attribute = await deps.readSerial(device.sysfsPath);
		unbound = attribute;
		// The path outlives the device: a replug at the same port reuses it.
		// Only a serial read while the enumerated device number still holds
		// belongs to the device whose descriptors the snapshot holds; without
		// that proof the read is no unit evidence at all.
		if (attribute !== undefined) {
			const enumerated = deviceNumber(device.udevProperties?.DEVNUM);
			const now =
				enumerated === undefined
					? undefined
					: deviceNumber(await deps.readDevnum(device.sysfsPath));
			if (now === undefined || now !== enumerated) {
				attribute = "";
				unproven =
					usbSerialIdentity(unbound, device.vendorId).key !== undefined;
			}
		}
	}
	const raw = attribute ?? device.serialNumber;
	const reported = usbSerialIdentity(property, device.vendorId);
	const observed = usbSerialIdentity(raw ?? property, device.vendorId);
	return {
		observed,
		reported,
		// Not this lifetime's identity, but still a serial some device holds.
		unbound: usbSerialIdentity(unbound, device.vendorId),
		agrees: property === undefined || observed.key === reported.key,
		// A serial was read, but nothing proved it was this device's.
		unproven,
	};
}

/**
 * The unit evidence of one enumerated device: its link id when its serial is
 * this lifetime's and unique, `unproven` when a serial was read but the device
 * number that ties it to this lifetime was missing or had changed.
 */
async function unitEvidence(
	device: UsbDeviceSnapshot,
	devices: readonly UsbDeviceSnapshot[],
	deps: MutationCaptureDeps,
): Promise<{ id?: string; unproven?: true }> {
	const vid = device.vendorId.toLowerCase();
	if (!/^[0-9a-f]{4}$/.test(vid)) return {};
	const { observed, agrees, unproven } = await serialFor(device, deps);
	if (unproven) return { unproven: true };
	if (observed.key === undefined || !agrees) return {};
	const peers = await Promise.all(
		devices
			.filter(
				(other) =>
					other.physicalUid !== device.physicalUid &&
					other.vendorId.toLowerCase() === vid,
			)
			.map((other) => serialFor(other, deps)),
	);
	if (
		peers.some(
			(peer) =>
				peer.observed.key === observed.key ||
				peer.reported.key === observed.key ||
				peer.unbound.key === observed.key,
		)
	)
		return {};
	const remembered = new Set(getConfig().usb_serial_shared ?? []);
	if (observed.isShared(remembered)) return {};

	return { id: mintLinkId(`usb-serial:${observed.key}`) };
}

async function reliableUnitLinkId(
	device: UsbDeviceSnapshot,
	devices: readonly UsbDeviceSnapshot[],
	deps: MutationCaptureDeps,
): Promise<string | undefined> {
	return (await unitEvidence(device, devices, deps)).id;
}

/** The unit identity of a device from one enumeration, read with the active capture deps. */
export function observedUnitLinkId(
	device: UsbDeviceSnapshot,
	devices: readonly UsbDeviceSnapshot[],
): Promise<string | undefined> {
	return reliableUnitLinkId(device, devices, activeDeps);
}

/**
 * Record an opaque unit identity if the enumerated modem has a reliable serial.
 * A census that does not list the modem proves nothing about its unit, so the
 * journal holds it as unproven; only a modem it lists without a serial keeps
 * descriptor-only verification.
 */
export async function captureModemJournalIdentity(stableKey: string): Promise<{
	deviceVidPid?: string;
	unitLinkId?: string;
	unitUnproven?: true;
}> {
	const deps = activeDeps;
	const devices = await deps.enumerate();
	const device = devices.find(
		(candidate) => deriveModemStableKey(candidate.physicalUid) === stableKey,
	);
	if (device === undefined) return { unitUnproven: true };
	const vidPid = `${device.vendorId}:${device.productId}`.toLowerCase();
	const unit = await unitEvidence(device, devices, deps);
	return {
		...(/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(vidPid)
			? { deviceVidPid: vidPid }
			: {}),
		...(unit.id === undefined ? {} : { unitLinkId: unit.id }),
		...(unit.unproven ? { unitUnproven: true } : {}),
	};
}

export async function captureModemUnitLinkId(
	stableKey: string,
): Promise<string | undefined> {
	return (await captureModemJournalIdentity(stableKey)).unitLinkId;
}

/**
 * What one enumeration shows at a journaled port. `replaced` needs a different
 * unit positively identified in that same enumeration; a device whose unit could
 * not be established there is `unknown`, never the original and never another.
 */
export type JournaledUnitObservation =
	| { readonly status: "present"; readonly state: CapturedState }
	| { readonly status: "empty" }
	| { readonly status: "replaced" }
	| { readonly status: "unknown" };

export async function observeJournaledUnit(
	stableKey: string,
	deps: MutationCaptureDeps = activeDeps,
	unitLinkId?: string,
): Promise<JournaledUnitObservation> {
	const devices = await deps.enumerate();
	const device = devices.find(
		(candidate) => deriveModemStableKey(candidate.physicalUid) === stableKey,
	);
	if (device === undefined) return { status: "empty" };
	const state = {
		...captureUsbDescriptor(device),
		ifname: device.ifname ?? "",
	};
	if (unitLinkId === undefined) return { status: "present", state };
	const unit = await reliableUnitLinkId(device, devices, deps);
	if (unit === unitLinkId) return { status: "present", state };
	return { status: unit === undefined ? "unknown" : "replaced" };
}

/** Find the original device at the journaled port when its unit identity is known. */
export async function captureModemState(
	stableKey: string,
	deps: MutationCaptureDeps = activeDeps,
	unitLinkId?: string,
): Promise<CapturedState | undefined> {
	const observed = await observeJournaledUnit(stableKey, deps, unitLinkId);
	return observed.status === "present" ? observed.state : undefined;
}

/**
 * Whether a captured state matches a journaled pre-state.
 *
 * `ifname` is EXCLUDED from the comparison, and that exclusion is load-bearing: a
 * predictable interface name is derived from a MAC that this fleet has already
 * proven can collide, and it legitimately changes across a re-enumeration that
 * restored the correct composition mode. Comparing it would reject a rollback that
 * genuinely succeeded.
 */
export function statesMatch(
	preState: CapturedState,
	current: CapturedState,
): boolean {
	const compared = ["vidPid", "model", "firmwareRevision", "mode"] as const;
	return compared.every((field) => preState[field] === current[field]);
}

/**
 * A captured state is COHERENT when it names a real device rather than a partly
 * enumerated one. It is the validation the force-rebaseline path runs before it
 * will adopt the current hardware as a new baseline.
 */
export function isCoherentState(state: CapturedState): boolean {
	const vidPid = state.vidPid;
	return typeof vidPid === "string" && /^[0-9a-f]{4}:[0-9a-f]{4}$/.test(vidPid);
}

export async function rollbackMutation(
	kind: ModemMutationKind,
	stableKey: string,
	preState: CapturedState,
	unitLinkId?: string,
	unitUnproven = false,
): Promise<RollbackResult> {
	if (kind === "modem-config" && typeof preState.format === "string") {
		const inverse = configInverses.get(preState.format);
		if (!inverse) return "failed";
		try {
			return await inverse.rollback(stableKey, preState);
		} catch {
			return "failed";
		}
	}
	const revision = mutationJournalRevision();
	const authoritativeRollback = handlers.get(kind)?.rollbackIfAuthoritative;
	if (authoritativeRollback) {
		try {
			const authoritative = authoritativeRollback(preState);
			if (authoritative !== undefined) return await authoritative;
		} catch {
			return "failed";
		}
	}
	// Descriptor equality would accept a replacement with the same descriptors.
	if (unitUnproven) return "unproven";
	const observed = await observeJournaledUnit(stableKey, undefined, unitLinkId);
	assertMutationJournalRevision(revision);
	if (observed.status === "empty") return "absent";
	if (observed.status === "replaced") return "replaced";
	if (observed.status === "unknown") return "presence-unknown";
	const current = observed.state;
	// Already back — nothing to undo. This is the common replay case: an `armed`
	// entry means the mutation had not been dispatched at all.
	if (statesMatch(preState, current)) return "restored";

	const handler = handlers.get(kind);
	if (handler === undefined) return "unavailable";
	try {
		return await handler.rollback(stableKey, preState);
	} catch {
		return "failed";
	}
}
