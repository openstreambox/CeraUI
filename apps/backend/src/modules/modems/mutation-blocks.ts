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
 * Projects the durable journal onto the interlock's fail-closed block set, and
 * onto the operator-facing list.
 *
 * The journal is the truth and this is the only thing that publishes it, so
 * "which devices are blocked" has exactly one derivation. The mapping from a
 * journal state to a REFUSAL is where the two different kinds of blocking meet:
 * every blocked state refuses mutations to its own identity, but only the states
 * whose device we still expect to answer for hold GLOBAL stream autostart — an
 * operator-confirmed decommission releases streaming precisely so a destroyed
 * modem cannot permanently strand the remaining links.
 */

import { createUsbEnumerator } from "@ceralive/modem-control";
import {
	deriveModemStableKey,
	type ModemMutationBlock,
	type ModemMutationEntry,
	type ModemMutationRefusal,
	type ModemMutationState,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { readUdevDeviceProperties } from "../network/router-cellular-scan.ts";
import {
	type MutationBlock,
	setMutationBlocks,
	tryAcquireModemJournalKey,
} from "../streaming/lifecycle-admission.ts";
import {
	beginRecoveryBarrier,
	isRecoveryPending,
} from "../streaming/recovery-barrier.ts";
import { syncHeldOutModemNotices } from "./held-out-modem-notice.ts";
import {
	commitMutationEntry,
	journalNow,
	listMutationEntries,
	mutationSlotName,
	nextEntry,
	readMutationEntry,
} from "./mutation-journal.ts";
import {
	assertMutationJournalRevision,
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
} from "./mutation-journal-revision.ts";
import {
	blocksMutations,
	blocksStreaming,
	presenceRecheckTarget,
} from "./mutation-journal-state.ts";
import { captureModemUnitLinkId } from "./mutation-rollback.ts";

const REFUSAL_BY_STATE: Readonly<
	Partial<Record<ModemMutationState, ModemMutationRefusal>>
> = {
	armed: "mutation_in_progress",
	executing: "mutation_in_progress",
	failed: "mutation_blocked",
	"device-absent-quarantine": "mutation_blocked",
	decommissioned: "device_decommissioned",
	"recommission-pending": "rebaseline_required",
};

export interface MutationBlockDeps {
	listEntries(
		onUnreadable: (slot: string) => void,
	): Promise<readonly ModemMutationEntry[]>;
	presentStableKeys(paths?: Map<string, string>): Promise<ReadonlySet<string>>;
}

/**
 * The sentinel a failed enumeration answers with. It is compared by IDENTITY, so
 * "we could not look" can never be mistaken for "we looked and found nothing".
 */
export const PRESENCE_UNKNOWN: ReadonlySet<string> = new Set<string>();

async function enumeratePresentKeys(
	paths?: Map<string, string>,
): Promise<ReadonlySet<string>> {
	const present = new Set<string>();
	try {
		for (const device of await createUsbEnumerator().enumerate()) {
			const key = deriveModemStableKey(device.physicalUid);
			if (key !== undefined) {
				present.add(key);
				if (device.sysfsPath) paths?.set(key, device.sysfsPath);
			}
		}
	} catch (err) {
		// An unreadable bus is a statement about the READ, never about the devices.
		// Answering "nothing is present" would quarantine every journaled modem.
		logger.warn("could not enumerate USB devices for mutation-block presence", {
			module: "modems",
			err,
		});
		return PRESENCE_UNKNOWN;
	}
	return present;
}

interface ReturnBlockDeps extends MutationBlockDeps {
	confirmPresent(key: string, sysfsPath: string | undefined): Promise<boolean>;
	readUnitLinkId(key: string): Promise<string | undefined>;
}

export const defaultMutationBlockDeps: ReturnBlockDeps = {
	async confirmPresent(key, path) {
		return (
			path !== undefined &&
			deriveModemStableKey((await readUdevDeviceProperties(path)).idPath) ===
				key
		);
	},
	listEntries: (onUnreadable) =>
		listMutationEntries(undefined, false, onUnreadable),
	presentStableKeys: enumeratePresentKeys,
	readUnitLinkId: captureModemUnitLinkId,
};

let activeDeps: ReturnBlockDeps = defaultMutationBlockDeps;

export function setMutationBlockDeps(deps: Partial<ReturnBlockDeps>): void {
	activeDeps = { ...defaultMutationBlockDeps, ...deps };
}

export function resetMutationBlockDeps(): void {
	activeDeps = defaultMutationBlockDeps;
}

let lastBlocks: readonly ModemMutationBlock[] = [];
let lastInterlock: readonly MutationBlock[] = [];
let lastRevision = mutationJournalRevision();

export function reconciledMutationJournalRevision(): bigint {
	return lastRevision;
}

export function currentMutationBlocks(): readonly ModemMutationBlock[] {
	return lastBlocks;
}

interface BlockCensus {
	readonly entries: readonly ModemMutationEntry[];
	readonly unreadable: readonly string[];
	readonly revision: bigint;
}

/**
 * Each damaged slot moves the revision once, by this very read. A census that
 * counted those faults itself is stale only when the revision moved further.
 */
async function readBlockCensus(deps: MutationBlockDeps): Promise<BlockCensus> {
	const before = mutationJournalRevision();
	const unreadable: string[] = [];
	const entries = await deps.listEntries((slot) => unreadable.push(slot));
	return {
		entries,
		unreadable,
		revision: before + BigInt(unreadable.length),
	};
}

/** Re-derive the block set from disk and publish it to the interlock. */
export async function refreshMutationBlocks(
	deps: MutationBlockDeps = activeDeps,
): Promise<readonly ModemMutationBlock[]> {
	return (await reconcileMutationBlocks(deps)).blocks;
}

/** The same publication, naming the damaged slots its view could not include. */
export async function reconcileMutationBlocks(
	deps: MutationBlockDeps = activeDeps,
): Promise<{
	readonly blocks: readonly ModemMutationBlock[];
	readonly unreadable: readonly string[];
}> {
	let census = await readBlockCensus(deps);
	if (!isMutationJournalRevisionCurrent(census.revision)) {
		census = await readBlockCensus(deps);
	}
	const { entries, unreadable, revision } = census;
	const blocking = entries.filter((entry) => blocksMutations(entry.state));
	const present =
		blocking.length === 0 ? PRESENCE_UNKNOWN : await deps.presentStableKeys();
	const presenceKnown = present !== PRESENCE_UNKNOWN;
	const readable: ModemMutationBlock[] = blocking.map((entry) => ({
		stableKey: entry.stableKey,
		kind: entry.kind,
		state: entry.state,
		updatedAt: entry.updatedAt,
		// A presence answer we could not obtain is reported as PRESENT, because a
		// device we cannot rule out is a device whose fail-closed handling must
		// keep running rather than being downgraded to quarantine.
		devicePresent: presenceKnown ? present.has(entry.stableKey) : true,
		blocksStreaming: blocksStreaming(entry.state),
		...(entry.detail === undefined ? {} : { detail: entry.detail }),
	}));

	assertMutationJournalRevision(revision);
	// Damage is not absence: a slot that cannot be read keeps its published row.
	const damaged = (block: { readonly stableKey: string }) =>
		unreadable.includes(`${mutationSlotName(block.stableKey)}.json`);
	const blocks = [...readable, ...lastBlocks.filter(damaged)];
	const interlock = [
		...blocking.map((entry): MutationBlock => {
			const prior = entry.preState.vidPid;
			const deviceVidPid =
				entry.deviceVidPid ??
				(typeof prior === "string" && /^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(prior)
					? prior.toLowerCase()
					: undefined);
			return {
				stableKey: entry.stableKey,
				...(entry.unitLinkId === undefined
					? {}
					: { unitLinkId: entry.unitLinkId }),
				...(deviceVidPid === undefined ? {} : { deviceVidPid }),
				...(entry.kind === "usb-mode" ? { matchUsbVendor: true } : {}),
				refusal: REFUSAL_BY_STATE[entry.state] ?? "mutation_blocked",
				blocksStreaming: blocksStreaming(entry.state),
			};
		}),
		// The interlock row keeps its unit link and USB identity with it.
		...lastInterlock.filter(damaged),
	];
	setMutationBlocks(interlock);
	lastInterlock = interlock;
	lastBlocks = blocks;
	lastRevision = revision;
	syncHeldOutModemNotices(lastBlocks);
	return { blocks, unreadable };
}

/** A return after replay needs the same terminal disposition as a return at boot.
 * Take the journal-only key, re-read the slot and require positive USB identity.
 * This poll never submits a rollback or clears the block. */
let returnPass: Promise<void> | undefined;

export function reconcileReturnedMutationBlocks(): Promise<void> {
	returnPass ??= reconcileReturns(activeDeps).finally(() => {
		returnPass = undefined;
	});
	return returnPass;
}

async function reconcileReturns(deps: ReturnBlockDeps): Promise<void> {
	const candidates = lastBlocks.filter(
		(block) => presenceRecheckTarget(block.state, true) !== undefined,
	);
	if (!candidates.length || isRecoveryPending()) return;
	let changed = false;
	try {
		const paths = new Map<string, string>();
		const present = new Set(await deps.presentStableKeys(paths));
		for (const block of candidates) {
			if (!present.has(block.stableKey) || isRecoveryPending()) continue;
			const lease = tryAcquireModemJournalKey(block.stableKey);
			if (!lease) continue;
			try {
				const entry = await readMutationEntry(block.stableKey);
				if (!entry || entry.state !== block.state) continue;
				const current = await deps.confirmPresent(
					entry.stableKey,
					paths.get(entry.stableKey),
				);
				if (!current) present.delete(entry.stableKey);
				if (
					current &&
					entry.state !== "decommissioned" &&
					entry.unitLinkId !== undefined &&
					(await deps
						.readUnitLinkId(entry.stableKey)
						.catch(() => undefined)) !== entry.unitLinkId
				)
					continue;
				const target = presenceRecheckTarget(entry.state, current);
				if (!target || isRecoveryPending()) continue;
				await commitMutationEntry(
					nextEntry(
						entry,
						target,
						journalNow(),
						"device present after recovery",
					),
				);
				changed = true;
			} finally {
				lease.release();
			}
		}
		if (changed)
			await refreshMutationBlocks({
				...deps,
				presentStableKeys: async () => present,
			});
	} catch (err) {
		// A visible rename can precede a failed fsync. Have the existing owner
		// verify durable authority and republish even after a partial pass.
		beginRecoveryBarrier();
		logger.warn("modem return reconciliation incomplete", {
			module: "modems",
			err,
		});
	}
}
