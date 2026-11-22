/*
  Publish one persistent recovery notice per failed or quarantined modem. Use
  its current label when available, including after interface renaming.
*/

import type { ModemMutationBlock } from "@ceraui/rpc/schemas";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";

export const HELD_OUT_PREFIX = "modem_held_out:";
export const HELD_OUT_KEY = "notifications.modemHeldOut";
export const HELD_OUT_UNKNOWN_KEY = "notifications.modemHeldOutUnknown";

export function heldOutMsg(name: string | undefined): string {
	return name === undefined
		? "A modem setting change is pending recovery."
		: `A setting change on ${name} is pending recovery.`;
}

export interface HeldOutNoticeDeps {
	readonly notify: typeof notificationBroadcast;
	readonly remove: typeof notificationRemove;
	readonly labelFor: (stableKey: string) => string | undefined;
}

function currentLabel(stableKey: string): string | undefined {
	for (const id of getModemIds()) {
		if (modemStableKeyForId(id) !== stableKey) continue;
		const name = getModem(id)?.name?.trim();
		if (name) return name;
	}
	return undefined;
}

const defaultDeps: HeldOutNoticeDeps = {
	notify: notificationBroadcast,
	remove: notificationRemove,
	labelFor: currentLabel,
};

/** Notice name → the label it was raised with (undefined: unknown modem). */
const standing = new Map<string, string | undefined>();

export function resetHeldOutNoticesForTest(): void {
	standing.clear();
}

/** A held-out modem: its change failed or it went missing mid-change. */
function heldOut(block: ModemMutationBlock): boolean {
	return (
		block.blocksStreaming &&
		(block.state === "failed" || block.state === "device-absent-quarantine")
	);
}

/** Raise and retract notices to match the current block set. Never throws. */
export function syncHeldOutModemNotices(
	blocks: readonly ModemMutationBlock[],
	deps: HeldOutNoticeDeps = defaultDeps,
): void {
	try {
		const wanted = new Map<string, string | undefined>();
		for (const block of blocks) {
			if (!heldOut(block)) continue;
			wanted.set(
				`${HELD_OUT_PREFIX}${block.stableKey}`,
				deps.labelFor(block.stableKey),
			);
		}
		for (const name of [...standing.keys()]) {
			if (wanted.has(name)) continue;
			deps.remove(name);
			standing.delete(name);
		}
		for (const [name, label] of wanted) {
			// Re-raise when the modem gains or loses its row, so the text stays true.
			if (standing.has(name) && standing.get(name) === label) continue;
			deps.notify(
				name,
				"warning",
				heldOutMsg(label),
				0,
				true, // persistent until the block clears
				false, // not dismissable: it stands for a real, current condition
				true, // authedOnly
				label === undefined ? HELD_OUT_UNKNOWN_KEY : HELD_OUT_KEY,
				label === undefined ? undefined : { name: label },
			);
			standing.set(name, label);
		}
	} catch {
		// A notice must never break the block projection.
	}
}
