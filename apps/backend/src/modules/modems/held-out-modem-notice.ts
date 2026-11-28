/*
  TELL THE STREAMER WHEN A MODEM IS KEPT OUT OF THE STREAM.

  A modem whose setting change could not be undone (a failed rollback, or a
  modem that disappeared mid-change) is kept out of the bond by its stable key,
  and the other links stream without it. Nothing on screen said so: the block
  list was only reachable over RPC, and a modem that came back under another
  name, or was unplugged, had no row of its own to show it on.

  One persistent notice per held-out modem, raised when the block appears and
  retracted when it clears. It names the modem when a current modem row has that
  stable key, and says "a modem that was unplugged or reconnected" otherwise.
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
		? "A modem that was unplugged or reconnected is kept out of the stream because a setting change on it could not be undone. Your other links aren't affected."
		: `${name} is kept out of the stream because a setting change on it could not be undone. Your other links aren't affected.`;
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
