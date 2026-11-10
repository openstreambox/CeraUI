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

/* The persisted role is intent. Restoring it does not undo uncertain NM effects. */

import { randomUUID } from "node:crypto";
import type { EthernetRole, EthernetRoleError } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import {
	ETHERNET_ROLE_DEFAULT,
	getEthernetRole,
	getPersistedEthernetRoles,
	getSharedEthernetProfile,
	isEthernetRoleCandidate,
	persistEthernetRole,
	reserveSharedEthernetProfile,
	restoreEthernetRole,
} from "./ethernet-role.ts";
import {
	type EthernetRoleOutcomePublisher,
	publishEthernetRoleOutcome,
} from "./ethernet-role-outcome.ts";
import {
	applySharedLanBondGate,
	getNetworkInterfaces,
	triggerNetworkInterfacesChange,
} from "./network-interfaces.ts";
import {
	createEthernetNm,
	type EthernetActiveConnection,
	type EthernetOwnedProfile,
	type EthernetSharedProfile,
	nmConnect,
	nmConnSetFields,
} from "./network-manager.ts";

const IPV4_METHOD_FOR_ROLE: Record<EthernetRole, string> = {
	uplink: "auto",
	"shared-lan": "shared",
};

export interface EthernetRoleTransitionDeps {
	readonly listInterfaces: () => Record<string, unknown>;
	readonly resolveConnection: (
		ifname: string,
	) => Promise<EthernetActiveConnection>;
	readonly readProfile: (
		uuid: string,
		ifname: string,
	) => Promise<EthernetOwnedProfile>;
	readonly addConnection: (profile: EthernetSharedProfile) => Promise<boolean>;
	readonly readOwnedProfile: (ifname: string) => string | undefined;
	readonly reserveProfile: (ifname: string, uuid: string) => void;
	readonly newUuid: () => string;
	readonly setFields: (
		uuid: string,
		fields: Record<string, string>,
	) => Promise<boolean>;
	readonly activate: (uuid: string) => Promise<boolean>;
	readonly persistRole: (ifname: string, role: EthernetRole) => void;
	readonly restoreRole: (
		ifname: string,
		previous: EthernetRole | undefined,
	) => void;
	readonly readPersistedRole: (ifname: string) => EthernetRole | undefined;
	readonly publishOutcome: EthernetRoleOutcomePublisher;
	readonly refreshInterfaces: () => void;
}

function refreshNetifRoleFlags(): void {
	applySharedLanBondGate(getNetworkInterfaces());
	triggerNetworkInterfacesChange();
}
const ethernetNm = createEthernetNm();
export const defaultEthernetRoleDeps: EthernetRoleTransitionDeps = {
	listInterfaces: getNetworkInterfaces,
	resolveConnection: ethernetNm.active,
	readProfile: ethernetNm.profile,
	addConnection: ethernetNm.addShared,
	readOwnedProfile: getSharedEthernetProfile,
	reserveProfile: reserveSharedEthernetProfile,
	newUuid: randomUUID,
	setFields: nmConnSetFields,
	activate: nmConnect,
	persistRole: persistEthernetRole,
	restoreRole: restoreEthernetRole,
	readPersistedRole: (ifname) => getPersistedEthernetRoles()[ifname],
	publishOutcome: publishEthernetRoleOutcome,
	refreshInterfaces: refreshNetifRoleFlags,
};

export interface SetEthernetRoleResult {
	success: boolean;
	applied?: EthernetRole;
	error?: EthernetRoleError;
}
function refuse(
	name: string,
	error: EthernetRoleError,
	deps: EthernetRoleTransitionDeps,
): SetEthernetRoleResult {
	deps.publishOutcome(name, { success: false, error });
	return { success: false, error };
}

// The existing transition owner serializes each selected port independently.
const portOperations = new Map<string, Promise<void>>();
function onPort<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const previous = portOperations.get(name) ?? Promise.resolve();
	const result = previous.then(operation);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	portOperations.set(name, tail);
	void tail.then(() => {
		if (portOperations.get(name) === tail) portOperations.delete(name);
	});
	return result;
}

async function applyRoleToNetworkManager(
	ifname: string,
	role: EthernetRole,
	deps: EthernetRoleTransitionDeps,
	allowCreate: boolean,
): Promise<EthernetRoleError | undefined> {
	const initial = await deps.resolveConnection(ifname);
	if (deps.listInterfaces()[ifname] === undefined) return "unknown_interface";
	if (initial.kind === "unavailable") return "no_connection";
	let uuid =
		initial.kind === "active" ? initial.uuid : deps.readOwnedProfile(ifname);
	if (!uuid) {
		if (!allowCreate || role !== "shared-lan") return "no_connection";
		uuid = deps.newUuid();
		// This synchronous atomic reservation must finish before any profile add.
		deps.reserveProfile(ifname, uuid);
	}
	const selectedUuid = uuid;
	const owned = deps.readOwnedProfile(ifname) === selectedUuid;
	const stillSelected = async () => {
		const active = await deps.resolveConnection(ifname);
		return (
			deps.listInterfaces()[ifname] !== undefined &&
			(active.kind === "active"
				? active.uuid === selectedUuid
				: active.kind === "absent" && initial.kind === "absent")
		);
	};
	if (owned) {
		const profile = await deps.readProfile(selectedUuid, ifname);
		if (profile.kind === "unavailable") return "no_connection";
		if (profile.kind === "absent") {
			if (initial.kind !== "absent" || !allowCreate || role !== "shared-lan")
				return "no_connection";
			if (!(await stillSelected())) return "apply_failed";
			if (!(await deps.addConnection({ ifname, uuid: selectedUuid })))
				return "apply_failed";
			// An acknowledged add alone does not prove its UUID/type/interface binding.
			if ((await deps.readProfile(selectedUuid, ifname)).kind !== "present")
				return "apply_failed";
		}
	}
	if (!(await stillSelected())) return "apply_failed";
	const fields: Record<string, string> = {
		"ipv4.method": IPV4_METHOD_FOR_ROLE[role],
	};
	if (owned)
		fields["connection.autoconnect"] = role === "uplink" ? "yes" : "no";
	if (!(await deps.setFields(selectedUuid, fields))) return "apply_failed";
	if (
		owned &&
		(await deps.readProfile(selectedUuid, ifname)).kind !== "present"
	)
		return "apply_failed";
	if (!(await stillSelected())) return "apply_failed";
	if (!(await deps.activate(selectedUuid))) return "apply_failed";
	const applied = await deps.resolveConnection(ifname);
	return deps.listInterfaces()[ifname] !== undefined &&
		applied.kind === "active" &&
		applied.uuid === selectedUuid
		? undefined
		: "apply_failed";
}

export async function setEthernetRole(
	name: string,
	role: EthernetRole,
	deps: EthernetRoleTransitionDeps = defaultEthernetRoleDeps,
): Promise<SetEthernetRoleResult> {
	if (!isEthernetRoleCandidate(name)) return refuse(name, "not_ethernet", deps);
	return onPort(name, async () => {
		if (deps.listInterfaces()[name] === undefined)
			return refuse(name, "unknown_interface", deps);
		const previous = deps.readPersistedRole(name);
		let persisted = false;
		let failure: EthernetRoleError | undefined;
		try {
			deps.persistRole(name, role);
			persisted = true;
			if (
				(previous ?? ETHERNET_ROLE_DEFAULT) === role &&
				role === "uplink" &&
				!deps.readOwnedProfile(name)
			) {
				deps.refreshInterfaces();
				deps.publishOutcome(name, { success: true, role });
				return { success: true, applied: role };
			}
			deps.publishOutcome(name, { pending: true, role });
			failure = await applyRoleToNetworkManager(name, role, deps, true);
		} catch {
			failure = "apply_failed";
		}
		if (failure !== undefined) {
			if (persisted) {
				try {
					deps.restoreRole(name, previous);
				} catch {
					logger.warn("ethernet role: could not restore persisted intent");
				}
			}
			// This restores intent/bond flags only. Profiles and unknown device effects
			// are retained; only an explicit request can inspect/retry the reservation.
			deps.refreshInterfaces();
			return refuse(name, failure, deps);
		}
		deps.refreshInterfaces();
		deps.publishOutcome(name, { success: true, role });
		return { success: true, applied: role };
	});
}

/** Boot reuses profiles only; it cannot allocate, add or discard a reservation. */
export async function reconcileEthernetRoles(
	deps: EthernetRoleTransitionDeps = defaultEthernetRoleDeps,
	readRoles: () => Readonly<
		Record<string, EthernetRole>
	> = getPersistedEthernetRoles,
): Promise<void> {
	try {
		const roles = readRoles();
		for (const ifname of Object.keys(roles).filter(
			(name) => roles[name] === "shared-lan",
		)) {
			await onPort(ifname, async () => {
				if (
					!isEthernetRoleCandidate(ifname) ||
					deps.listInterfaces()[ifname] === undefined ||
					deps.readPersistedRole(ifname) !== "shared-lan"
				)
					return;
				try {
					const failure = await applyRoleToNetworkManager(
						ifname,
						"shared-lan",
						deps,
						false,
					);
					if (failure)
						logger.warn(
							`ethernet role reconcile: ${ifname} remains unconfirmed (${failure})`,
						);
				} catch {
					logger.warn(`ethernet role reconcile: ${ifname} remains unconfirmed`);
				}
			});
		}
		deps.refreshInterfaces();
	} catch {
		logger.warn("ethernet role reconciliation unavailable");
	}
}

export { getEthernetRole };
