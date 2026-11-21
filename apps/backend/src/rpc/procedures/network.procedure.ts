/**
 * Network Interface Procedures
 * Wraps existing network logic from modules/network/
 */

import { existsSync } from "node:fs";
import {
	type ChangeSafetyStatus,
	changeSafetyActionOutputSchema,
	changeSafetyIdInputSchema,
	changeSafetyNoticeInputSchema,
	changeSafetyStatusSchema,
	NETWORK_INGEST_UNAVAILABLE_ERROR,
	netifConfigInputSchema,
	netifConfigOutputSchema,
	netifMessageSchema,
	setEthernetRoleInputSchema,
	setEthernetRoleOutputSchema,
	setIngestEnabledInputSchema,
	setIngestEnabledOutputSchema,
	sharingPolicySchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import {
	setMockNetifConfig,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import { setMockNetworkIngestActive } from "../../mocks/providers/network-ingest.ts";
import { setMockGatewayActive } from "../../mocks/providers/streaming.ts";
import {
	ethernetRoleOfSummary,
	networkChangeSafetyEnabled,
} from "../../modules/network/ethernet-role-safety.ts";
import {
	reapplyEthernetRoleNotice,
	setEthernetRole,
} from "../../modules/network/ethernet-role-transition.ts";
import {
	getNetworkChangeOwner,
	networkChangeJournalPath,
	networkChangeSession,
	resetDamagedNetworkChangeJournal,
	resolveNetworkChangeSession,
} from "../../modules/network/network-change-runtime.ts";
import { refreshAndBroadcastNetworkIngest } from "../../modules/network/network-ingest.ts";
import {
	persistIngestDesired,
	setIngestEnabled,
} from "../../modules/network/network-ingest-control.ts";
import {
	getNetworkInterfaces,
	handleNetif,
	netIfBuildMsg,
	readAppliedNetifConfig,
} from "../../modules/network/network-interfaces.ts";
import { sharingPolicyOwner } from "../../modules/network/uplink-steering/policy.ts";
import { requestUplinkSteeringReconcile } from "../../modules/network/uplink-steering/runtime.ts";
import { broadcastSources } from "../../modules/streaming/sources.ts";
import { hasCapability } from "../../modules/system/board-capabilities.ts";
import { broadcastMsg } from "../compat.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get network interfaces procedure
 */
export const getNetworkInterfacesProcedure = authedProcedure
	.output(netifMessageSchema)
	.handler(() => {
		return netIfBuildMsg();
	});

/**
 * Configure network interface procedure
 */
export const configureNetworkInterfaceProcedure = authedProcedure
	.input(netifConfigInputSchema)
	.output(netifConfigOutputSchema)
	.handler(({ input, context }) => {
		// Order is load-bearing: persist the mock overlay BEFORE handleNetif,
		// whose synchronous netif broadcasts overlay `enabled`/`ip` from it via
		// netIfBuildMsg. Writing first makes those broadcasts carry the new
		// value, not the stale prior one. (undefined IP === DHCP.)
		if (shouldUseMocks()) {
			setMockNetifConfig(input.name, {
				enabled: input.enabled,
				dhcp: input.ip === undefined,
				ip: input.ip,
			});
			// Publish the overlay before the raw-map mutation so bonded-link cards
			// react immediately instead of waiting for the next 5 s poll.
			broadcastMsg("netif", netIfBuildMsg());
		}

		const observedIp = shouldUseMocks()
			? getNetworkInterfaces()[input.name]?.ip
			: input.ip;
		const outcome = handleNetif(context.ws as unknown as import("ws").default, {
			name: input.name,
			ip: observedIp ?? "",
			enabled: input.enabled,
		});

		// Under mocks the overlay is authoritative; the raw-map mutation remains a
		// best effort so dev/e2e reflects the same immediate applied readback.
		if (!shouldUseMocks() && !outcome.ok) {
			return { success: false, error: outcome.reason };
		}

		const applied = shouldUseMocks()
			? readAppliedNetifConfig(input.name)
			: outcome.ok
				? outcome.applied
				: undefined;
		if (applied === undefined) {
			return { success: false, error: "unknown_interface" as const };
		}
		return {
			success: true,
			applied,
		};
	});

/**
 * Declare an Ethernet port's role.
 *
 * Emulated hosts are refused BEFORE anything is persisted: there is no
 * NetworkManager profile to rewrite, so persisting a role the device could never
 * apply would leave the boot reconciler chasing it forever.
 */
export const setEthernetRoleProcedure = authedProcedure
	.input(setEthernetRoleInputSchema)
	.output(setEthernetRoleOutputSchema)
	.handler(async ({ input, context }) => {
		if (!shouldUseMocks() && !(await hasCapability("client-internet"))) {
			return { success: false, error: "unavailable_in_emulated_mode" as const };
		}

		// Behind the off-by-default flag, a real role change runs through the
		// network-change owner: checkpoint, candidate, confirm or automatic undo.
		// A session without arrival evidence also carries the box's route back
		// to it, so the prompt can say up front that the change cuts it.
		const safety =
			!shouldUseMocks() && networkChangeSafetyEnabled()
				? {
						owner: getNetworkChangeOwner(),
						// Resolved inside the port's role queue.
						session: () => resolveNetworkChangeSession(context.ws),
						answer: input.changeAnswer,
					}
				: undefined;
		return setEthernetRole(input.name, input.role, undefined, input.op, safety);
	});

/** Whether the owner may be consulted at all: flag on, or a journal to recover. */
function changeSafetyActive(): boolean {
	return (
		!shouldUseMocks() &&
		(networkChangeSafetyEnabled() || existsSync(networkChangeJournalPath()))
	);
}

const NO_CHANGE: Omit<ChangeSafetyStatus, "enabled"> = {
	pending: null,
	kept: null,
	undoIncomplete: false,
	commitIncomplete: false,
	problem: null,
	journalUnavailable: false,
	notice: null,
};

/** The pending change, kept change and stored notice; reads the journal only. */
export const getChangeSafetyStatusProcedure = authedProcedure
	.output(changeSafetyStatusSchema)
	.handler(async () => {
		const enabled = !shouldUseMocks() && networkChangeSafetyEnabled();
		if (!changeSafetyActive()) return { enabled, ...NO_CHANGE };
		try {
			return {
				enabled,
				...(await getNetworkChangeOwner().status()),
				journalUnavailable: false,
			};
		} catch {
			// A damaged journal refuses every protected change and role write on
			// the ports it might name; say so instead of an all-clear.
			return { enabled, ...NO_CHANGE, journalUnavailable: true };
		}
	});

/**
 * Move a damaged change journal aside (kept for support) so changes work
 * again. Refused while the journal is readable: it may hold an undo.
 */
export const resetNetworkChangeJournalProcedure = authedProcedure
	.output(changeSafetyActionOutputSchema)
	.handler(async () => {
		if (shouldUseMocks()) return { success: false, error: "unavailable" };
		try {
			await resetDamagedNetworkChangeJournal();
			return { success: true };
		} catch (error) {
			return refusal(error);
		}
	});

function refusal(error: unknown) {
	return { success: false, error: (error as Error).message };
}

/** Confirm a pending change. Only a new session over the changed path qualifies. */
export const confirmNetworkChangeProcedure = authedProcedure
	.input(changeSafetyIdInputSchema)
	.output(changeSafetyActionOutputSchema)
	.handler(async ({ input, context }) => {
		if (!changeSafetyActive()) return { success: false, error: "unavailable" };
		try {
			await getNetworkChangeOwner().confirm(
				input.id,
				networkChangeSession(context.ws),
			);
			return { success: true };
		} catch (error) {
			return refusal(error);
		}
	});

/** Undo a change someone kept with "don't undo it", from any signed-in session. */
export const undoKeptNetworkChangeProcedure = authedProcedure
	.input(changeSafetyIdInputSchema)
	.output(changeSafetyActionOutputSchema)
	.handler(async ({ input, context }) => {
		if (!changeSafetyActive()) return { success: false, error: "unavailable" };
		try {
			await getNetworkChangeOwner().undoKept(
				input.id,
				networkChangeSession(context.ws),
			);
			return { success: true };
		} catch (error) {
			return refusal(error);
		}
	});

/** Answer the stored "the box undid it" notice: make the change again, or leave it. */
export const answerNetworkChangeNoticeProcedure = authedProcedure
	.input(changeSafetyNoticeInputSchema)
	.output(changeSafetyActionOutputSchema)
	.handler(async ({ input, context }) => {
		if (!changeSafetyActive()) return { success: false, error: "unavailable" };
		const owner = getNetworkChangeOwner();
		const session = networkChangeSession(context.ws);
		try {
			if (input.answer === "leave-undone") {
				await owner.leaveUndone(input.id, session);
				return { success: true };
			}
			// Re-applying is deliberate: the owner always asks before again.
			if (!networkChangeSafetyEnabled())
				return { success: false, error: "unavailable" };
			// A stored role change is planned again from the port's state now,
			// through the normal role path (and so its queue), never replayed
			// from the stored plan. The owner checks and consumes the notice in
			// the same apply, so a notice answered meanwhile refuses it.
			const notice = (await owner.status()).notice;
			if (notice?.id === input.id && ethernetRoleOfSummary(notice.summary)) {
				if (!(await hasCapability("client-internet")))
					return { success: false, error: "unavailable_in_emulated_mode" };
				const result = await reapplyEthernetRoleNotice(notice, {
					owner,
					session: () => resolveNetworkChangeSession(context.ws),
					answer: input.changeAnswer,
				});
				// Nothing to change (the port already has that role): the owner
				// wasn't involved, so answer the notice here.
				if (result?.success && !result.changeSafety)
					await owner.leaveUndone(input.id, session).catch(() => undefined);
				return {
					success: result?.success ?? false,
					...(result?.error ? { error: result.error } : {}),
					...(result?.changeSafety
						? { changeSafety: result.changeSafety }
						: {}),
				};
			}
			const changeSafety = await owner.reapply(
				input.id,
				await resolveNetworkChangeSession(context.ws),
				input.changeAnswer,
			);
			return { success: changeSafety.kind !== "ask-before", changeSafety };
		} catch (error) {
			return refusal(error);
		}
	});

/**
 * Enable/disable a LAN RTMP/SRT network-ingest gateway (operator desired state).
 *
 * Branch order is normative:
 *   1. mocks — persist the desired state + flip BOTH mock signals (status +
 *      start-gate), rebroadcast, ZERO process spawns (dev/e2e parity);
 *   2. emulated non-mock — the systemd units do not exist → UNAVAILABLE, no spawns;
 *   3. real device — persist → reconcile units → refresh (in setIngestEnabled).
 */
export const setNetworkIngestEnabledProcedure = authedProcedure
	.input(setIngestEnabledInputSchema)
	.output(setIngestEnabledOutputSchema)
	.handler(async ({ input }) => {
		const { protocol, enabled } = input;

		if (shouldUseMocks()) {
			persistIngestDesired(protocol, enabled);
			setMockNetworkIngestActive(protocol, enabled);
			setMockGatewayActive(protocol, enabled);
			await refreshAndBroadcastNetworkIngest();
			broadcastSources();
			return { success: true, applied: { protocol, enabled } };
		}

		if (!(await hasCapability("network-ingest"))) {
			return { success: false, error: NETWORK_INGEST_UNAVAILABLE_ERROR };
		}

		return setIngestEnabled(protocol, enabled);
	});

export const getSharingPolicyProcedure = authedProcedure
	.output(sharingPolicySchema)
	.handler(() => sharingPolicyOwner.get());
export const setSharingPolicyProcedure = authedProcedure
	.input(sharingPolicySchema)
	.output(sharingPolicySchema)
	.handler(async ({ input }) => {
		if (!shouldUseMocks() && !(await hasCapability("client-internet")))
			throw new Error("Sharing unavailable on emulated hosts");
		return sharingPolicyOwner.set(
			input,
			shouldUseMocks() ? async () => undefined : requestUplinkSteeringReconcile,
		);
	});
