/*
  Publish one persistent recovery notice for a pending recovery or held link. Use
  its current label when available, including after interface renaming.
*/

import type { ModemMutationBlock } from "@ceraui/rpc/schemas";
import { clatTranslationFor } from "../network/clat-translation.ts";
import {
	getNetworkInterfaces,
	isHeldOutByModemBlock,
	onNetworkInterfacesChange,
} from "../network/network-interfaces.ts";
import { getMutationBlocks } from "../streaming/lifecycle-admission.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";

export const HELD_OUT_PREFIX = "modem_held_out:";
export const HELD_OUT_KEY = "notifications.modemHeldOut";
export const HELD_OUT_UNKNOWN_KEY = "notifications.modemHeldOutUnknown";

const recoveryStep =
	"Reconnect the original modem to its original USB port if available. Contact support if recovery is still pending.";

export function heldOutMsg(name: string | undefined, links = "-"): string {
	const pending =
		name === undefined
			? "A modem setting change is pending recovery."
			: `A setting change on ${name} is pending recovery.`;
	return `${pending} Links held from bond selection: ${links}. ${recoveryStep}`;
}

export interface HeldOutNoticeDeps {
	readonly notify: typeof notificationBroadcast;
	readonly remove: typeof notificationRemove;
	readonly labelFor: (stableKey: string) => string | undefined;
	readonly linksFor?: (stableKey: string) => readonly string[];
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
	linksFor: (stableKey) => {
		const block = getMutationBlocks().find(
			(candidate) => candidate.stableKey === stableKey,
		);
		if (block === undefined) return [];
		const interfaces = getNetworkInterfaces();
		return Object.entries(interfaces)
			.filter(([name, int]) => {
				if (!int.ip) return false;
				const owner = clatTranslationFor(name, int.ip)?.parent ?? name;
				return isHeldOutByModemBlock(owner, interfaces[owner], [block]);
			})
			.map(([name]) => name)
			.sort();
	},
};

/** Remember the actual text, so a change in held links refreshes the notice. */
const standing = new Map<string, string>();
let activeBlocks: readonly ModemMutationBlock[] = [];
let stopNetworkNoticeUpdates: (() => void) | undefined;

export function resetHeldOutNoticesForTest(): void {
	standing.clear();
	activeBlocks = [];
	stopNetworkNoticeUpdates?.();
	stopNetworkNoticeUpdates = undefined;
}

/** These states warrant a notice even when no link is currently present. */
function recoveryPending(block: ModemMutationBlock): boolean {
	return (
		block.state === "recommission-pending" ||
		(block.blocksStreaming &&
			(block.state === "failed" || block.state === "device-absent-quarantine"))
	);
}

/** Raise and retract notices to match the current block set. Never throws. */
export function syncHeldOutModemNotices(
	blocks: readonly ModemMutationBlock[],
	deps: HeldOutNoticeDeps = defaultDeps,
): void {
	try {
		if (deps === defaultDeps) {
			activeBlocks = blocks;
			if (blocks.length > 0) {
				stopNetworkNoticeUpdates ??= onNetworkInterfacesChange(() =>
					syncHeldOutModemNotices(activeBlocks),
				);
			} else {
				stopNetworkNoticeUpdates?.();
				stopNetworkNoticeUpdates = undefined;
			}
		}
		const wanted = new Map<
			string,
			{ label: string | undefined; links: string }
		>();
		for (const block of blocks) {
			const links = deps.linksFor?.(block.stableKey) ?? [];
			if (links.length === 0 && !recoveryPending(block)) continue;
			wanted.set(`${HELD_OUT_PREFIX}${block.stableKey}`, {
				label: deps.labelFor(block.stableKey),
				links: links.join(", ") || "-",
			});
		}
		for (const name of [...standing.keys()]) {
			if (wanted.has(name)) continue;
			deps.remove(name);
			standing.delete(name);
		}
		for (const [name, { label, links }] of wanted) {
			const message = heldOutMsg(label, links);
			if (standing.get(name) === message) continue;
			deps.notify(
				name,
				"warning",
				message,
				0,
				true, // persistent until the block clears
				false, // not dismissable: it stands for a real, current condition
				true, // authedOnly
				label === undefined ? HELD_OUT_UNKNOWN_KEY : HELD_OUT_KEY,
				label === undefined ? { links } : { name: label, links },
			);
			standing.set(name, message);
		}
	} catch {
		// A notice must never break the block projection.
	}
}
