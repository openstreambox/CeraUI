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
  An Ethernet port role change through the network-change owner.

  Switching a port between uplink and shared LAN rewrites `ipv4.method` on the
  profile that port is running. If that port carries the session (a remote
  box managed over its wired uplink, or a laptop on the shared LAN), the change
  cuts it. Through the owner, the change runs on an in-memory candidate inside
  a NetworkManager checkpoint, and it is undone unless a new session confirms
  it in time.

  Two rules make this safe with the role's own persistence:
  - the role intent and the owned-profile reservation are written only when the
    change is committed (`onSettled`), never at apply time, so the boot
    reconciler can never re-apply a change nobody confirmed;
  - a port with no active connection carries no session, so creating the
    shared profile there keeps the existing path.
*/

import type { EthernetRole } from "@ceraui/rpc/schemas";
import type { EthernetRoleOutcomePublisher } from "./ethernet-role-outcome.ts";
import type { NetworkChangePlan } from "./network-change-journal.ts";
import { CHANGE_SAFETY_COPY } from "./network-change-policy.ts";
import type { SettledEvent } from "./network-checkpoint.ts";

/** The off-by-default switch. Only the exact value "1" enables it. */
export const NETWORK_CHANGE_SAFETY_ENV = "CERALIVE_NETWORK_CHANGE_SAFETY";

export function networkChangeSafetyEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env[NETWORK_CHANGE_SAFETY_ENV] === "1";
}

export const ETHERNET_ROLE_SUMMARY_KEY = CHANGE_SAFETY_COPY.summaryEthernetRole;

const IPV4_METHOD: Record<EthernetRole, string> = {
	uplink: "auto",
	"shared-lan": "shared",
};

const ROLES: readonly EthernetRole[] = ["uplink", "shared-lan"];
/**
 * A port with no stated role is an uplink. Kept here as a literal so this
 * module stays free of the config graph (the real-daemon contract loads it);
 * a test pins it to ETHERNET_ROLE_DEFAULT.
 */
export const DEFAULT_ROLE: EthernetRole = "uplink";
const isRole = (value: unknown): value is EthernetRole =>
	ROLES.includes(value as EthernetRole);

export interface EthernetRolePlanInput {
	readonly ifname: string;
	readonly role: EthernetRole;
	readonly previous: EthernetRole | undefined;
	/** The profile active on the port now. */
	readonly activeUuid: string;
	/** The active profile is the one CeraUI created for this port. */
	readonly owned: boolean;
	readonly op?: string | undefined;
}

/**
 * The plan: one edit of the active profile, re-activated on the port. The
 * owned profile also carries the role's autoconnect, which the owner writes on
 * promotion (the candidate itself never autoconnects).
 */
export function ethernetRolePlan(
	input: EthernetRolePlanInput,
): NetworkChangePlan {
	const params: Record<string, string> = {
		ifname: input.ifname,
		role: input.role,
	};
	if (input.previous !== undefined) params.previous = input.previous;
	if (input.op !== undefined) params.op = input.op;
	return {
		summary: { key: ETHERNET_ROLE_SUMMARY_KEY, params },
		devices: [input.ifname],
		profiles: [
			{
				uuid: input.activeUuid,
				set: [["ipv4.method", IPV4_METHOD[input.role]]],
				activateOn: input.ifname,
				...(input.owned ? { autoconnect: input.role === "uplink" } : {}),
			},
		],
		effects: [],
	};
}

export interface EthernetRoleIntent {
	readonly ifname: string;
	readonly role: EthernetRole;
	readonly previous: EthernetRole | undefined;
	readonly op: string | undefined;
}

/** Read the role change back from a stored plan; any other plan is not ours. */
export function ethernetRoleFromPlan(
	plan: NetworkChangePlan,
): EthernetRoleIntent | undefined {
	if (plan.summary.key !== ETHERNET_ROLE_SUMMARY_KEY) return undefined;
	const params = plan.summary.params ?? {};
	const { ifname, role, previous, op } = params;
	if (typeof ifname !== "string" || !isRole(role)) return undefined;
	if (previous !== undefined && !isRole(previous)) return undefined;
	return { ifname, role, previous, op };
}

/** The port a stored role-change summary names, for queueing a re-apply. */
export function ethernetRolePortOfSummary(summary: {
	readonly key: string;
	readonly params?: Readonly<Record<string, string>>;
}): string | undefined {
	if (summary.key !== ETHERNET_ROLE_SUMMARY_KEY) return undefined;
	const ifname = summary.params?.ifname;
	return typeof ifname === "string" ? ifname : undefined;
}

export interface EthernetRoleSettledDeps {
	readonly persistRole: (ifname: string, role: EthernetRole) => void;
	readonly restoreRole: (
		ifname: string,
		previous: EthernetRole | undefined,
	) => void;
	readonly readOwnedProfile: (ifname: string) => string | undefined;
	readonly reserveProfile: (ifname: string, uuid: string) => void;
	readonly refreshInterfaces: () => void;
	readonly publishOutcome: EthernetRoleOutcomePublisher;
}

/**
 * Persist the role (and follow the owned profile's new UUID) once the owner
 * settles a role change. Idempotent: it may run again after a crash.
 */
export function createEthernetRoleSettledHandler(
	deps: EthernetRoleSettledDeps,
) {
	return (event: SettledEvent): void => {
		const intent = ethernetRoleFromPlan(event.plan);
		if (!intent) return;
		const { ifname } = intent;
		const correlation = intent.op === undefined ? {} : { op: intent.op };
		const owned = deps.readOwnedProfile(ifname);
		for (const { original, candidate } of event.profiles) {
			if (!candidate || !owned) continue;
			if (event.outcome === "committed" && owned === original.toLowerCase())
				deps.reserveProfile(ifname, candidate);
			if (event.outcome === "reverted" && owned === candidate.toLowerCase())
				deps.reserveProfile(ifname, original);
		}
		if (event.outcome === "committed") {
			deps.persistRole(ifname, intent.role);
			deps.refreshInterfaces();
			deps.publishOutcome(ifname, {
				success: true,
				role: intent.role,
				...correlation,
			});
			return;
		}
		if (event.outcome === "reverted") {
			deps.restoreRole(ifname, intent.previous);
			deps.refreshInterfaces();
			deps.publishOutcome(ifname, {
				success: true,
				role: intent.previous ?? DEFAULT_ROLE,
				...correlation,
			});
			return;
		}
		// Undone: nothing was persisted. A change that failed during its apply
		// never published a pending frame (the caller got the error), so only an
		// undone pending change owes a terminal frame.
		if (event.reason === "failed") return;
		deps.refreshInterfaces();
		deps.publishOutcome(ifname, {
			success: false,
			error: "apply_failed",
			...correlation,
		});
	};
}
