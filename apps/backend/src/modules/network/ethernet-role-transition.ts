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

import { AsyncLocalStorage } from "node:async_hooks";
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

export class EthernetRoleReentryError extends Error {
	constructor(
		readonly ownerPort: string,
		readonly requestedPort: string,
	) {
		super(
			`Ethernet role change for ${requestedPort} cannot nest inside ${ownerPort}`,
		);
		this.name = "EthernetRoleReentryError";
	}
}

const roleOperations = new Map<string, Promise<unknown>>();
const roleOwnership = new AsyncLocalStorage<{
	port: string;
	active: boolean;
}>();

function assertNoRoleReentry(requestedPort?: string): void {
	const owner = roleOwnership.getStore();
	if (owner?.active) {
		throw new EthernetRoleReentryError(owner.port, requestedPort ?? owner.port);
	}
}

async function withEthernetRoleQueue<T>(
	ifname: string,
	operation: () => Promise<T>,
): Promise<T> {
	assertNoRoleReentry(ifname);

	const ownership = { port: ifname, active: true };
	const run = () => roleOwnership.run(ownership, operation);
	// Either outcome releases the next operation; callers still receive their
	// own rejection. Retain only the latest operation until that port drains.
	const current = (roleOperations.get(ifname) ?? Promise.resolve()).then(
		run,
		run,
	);
	roleOperations.set(ifname, current);
	try {
		return await current;
	} finally {
		ownership.active = false;
		if (roleOperations.get(ifname) === current) roleOperations.delete(ifname);
	}
}

export async function setEthernetRole(
	name: string,
	role: EthernetRole,
	deps: EthernetRoleTransitionDeps = defaultEthernetRoleDeps,
	op?: string,
): Promise<SetEthernetRoleResult> {
	return withEthernetRoleQueue(name, async () => {
		const correlation = op === undefined ? {} : { op };
		const refuse = (error: EthernetRoleError): SetEthernetRoleResult => {
			deps.publishOutcome(name, { success: false, error, ...correlation });
			return { success: false, error };
		};
		if (!isEthernetRoleCandidate(name)) return refuse("not_ethernet");
		if (deps.listInterfaces()[name] === undefined)
			return refuse("unknown_interface");
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
				deps.publishOutcome(name, { success: true, role, ...correlation });
				return { success: true, applied: role };
			}
			deps.publishOutcome(name, { pending: true, role, ...correlation });
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
			return refuse(failure);
		}
		deps.refreshInterfaces();
		deps.publishOutcome(name, { success: true, role, ...correlation });
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
	// Reconciliation includes every busy port, including an active caller's port.
	// Reject before its fail-soft catch or any injected reader can run.
	assertNoRoleReentry();
	try {
		const roles = readRoles();
		// A queued set may not have persisted yet, or may restore another role.
		// Select busy ports too, then read their choice only after taking ownership.
		const ports = new Set([
			...Object.keys(roles).filter((ifname) => roles[ifname] === "shared-lan"),
			...roleOperations.keys(),
		]);
		if (ports.size === 0) return;

		await Promise.all(
			[...ports].map((ifname) =>
				withEthernetRoleQueue(ifname, async () => {
					try {
						if (
							!isEthernetRoleCandidate(ifname) ||
							readRoles()[ifname] !== "shared-lan"
						)
							return;
						if (deps.listInterfaces()[ifname] === undefined) {
							logger.debug(
								`ethernet role reconcile: ${ifname} is not present; leaving shared-lan pending`,
							);
							return;
						}

						const failure = await applyRoleToNetworkManager(
							ifname,
							"shared-lan",
							deps,
							false,
						);
						if (failure !== undefined) {
							logger.warn(
								`ethernet role reconcile: ${ifname} could not be restored to shared-lan (${failure})`,
							);
						}
					} catch (error: unknown) {
						const message =
							error instanceof Error ? error.message : String(error);
						logger.error(
							`ethernet role reconcile: ${ifname} threw restoring shared-lan: ${message}`,
						);
					}
				}),
			),
		);

		deps.refreshInterfaces();
	} catch {
		logger.warn("ethernet role reconciliation unavailable");
	}
}

export { getEthernetRole };
