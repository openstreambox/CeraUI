import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import type { ModemMutationAckOutput } from "@ceraui/rpc/schemas";
import { heldModemMutations } from "../streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../streaming/recovery-barrier.ts";
import {
	openStoredStateDirectory,
	readStoredStateDescriptor,
	STORED_STATE_LIMITS,
} from "../system/update-orchestrator/stored-state-file.ts";
import { decodeAuthorityUtf8 } from "../system/update-orchestrator/strict-authority-json.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import {
	currentMutationJournalDeps,
	mutationSlotName,
} from "./mutation-journal.ts";
import { parseMutationJournalEntry } from "./mutation-journal-parse.ts";
import { acknowledgeMutationRemoval } from "./mutation-journal-retirement.ts";
import {
	isMutationJournalRevisionCurrent,
	mutationJournalRevision,
	withMutationJournalChange,
} from "./mutation-journal-revision.ts";

const NOTICE = "modem_recovery_record";
const RETRIES = 3;

function identity(path: string): string {
	const stat = lstatSync(path, { bigint: true });
	return [stat.dev, stat.ino, stat.ctimeNs, stat.size].join("/");
}

// The directory and leaf are independently pinned. Never follow a link in place
// of this slot or read unbounded bytes while deciding if it is still damaged.
function readable(path: string, name: string): boolean {
	try {
		const fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const bytes = readStoredStateDescriptor(fd, STORED_STATE_LIMITS.agent);
			return (
				parseMutationJournalEntry(decodeAuthorityUtf8(bytes), name) !==
				undefined
			);
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

interface Offer {
	name: string;
	signature: string;
	token: string;
	resume: ReturnType<typeof Promise.withResolvers<void>>;
	busy: boolean;
}

export class MutationDamageMonitor {
	private seen = new Map<string, { signature: string; failures: number }>();
	private offer: Offer | undefined;
	private stopped = false;
	private readonly journal = currentMutationJournalDeps();

	waitForOperator = () => this.offer?.resume.promise;

	// Only a complete pass can attribute its remaining failures to these files.
	observe = (damaged: readonly string[]): void => {
		if (this.stopped || this.offer) return;
		const next = new Map<string, { signature: string; failures: number }>();
		for (const name of [...damaged].sort()) {
			if (basename(name) !== name || !name.endsWith(".json")) continue;
			let signature: string;
			try {
				signature = identity(join(this.journal.dir, name));
			} catch {
				continue;
			}
			const before = this.seen.get(name);
			const failures =
				before?.signature === signature ? before.failures + 1 : 1;
			next.set(name, { signature, failures });
		}
		this.seen = next;
		// Give a newly unreadable peer its own retries before pausing boot replay.
		if (
			next.size !== damaged.length ||
			[...next.values()].some((slot) => slot.failures <= RETRIES)
		)
			return;
		for (const [name, { signature }] of next) {
			const token = randomUUID();
			const record = mutationSlotName(name).slice(0, 8);
			notificationBroadcast(
				NOTICE,
				"warning",
				"The box cannot read modem recovery record " +
					record +
					". New stream starts are on hold.",
				0,
				true,
				false,
				true,
				"notifications.modemRecoveryWarning",
				{ record },
				{
					action: {
						schema: 1,
						kind: "confirm-modem-record",
						token,
						labelKey: "notifications.modemRecoveryReview",
					},
				},
			);
			this.offer = {
				name,
				signature,
				token,
				resume: Promise.withResolvers<void>(),
				busy: false,
			};
			break;
		}
	};

	private withdraw(offer: Offer) {
		if (this.offer !== offer) return;
		this.offer = undefined;
		this.seen.delete(offer.name);
		try {
			notificationRemove(NOTICE);
		} finally {
			offer.resume.resolve();
		}
	}

	stop() {
		this.stopped = true;
		if (this.offer) this.withdraw(this.offer);
	}

	async confirm(token: string): Promise<ModemMutationAckOutput> {
		const offer = this.offer;
		if (!offer || offer.token !== token || offer.busy || !isRecoveryPending())
			return { success: false, error: "no_entry" };
		if (
			!isMutationJournalRevisionCurrent(mutationJournalRevision()) ||
			heldModemMutations().some(
				(key) => mutationSlotName(key) + ".json" === offer.name,
			)
		)
			return { success: false, error: "not_blocked" };
		offer.busy = true;
		try {
			return await withMutationJournalChange(async () => {
				const dir = openStoredStateDirectory(this.journal.dir);
				try {
					const root = "/proc/self/fd/" + dir;
					const path = join(root, offer.name);
					if (
						identity(path) !== offer.signature ||
						readable(path, offer.name) ||
						identity(path) !== offer.signature
					)
						return { success: false, error: "not_blocked" } as const;
					renameSync(path, join(root, ".recovery-" + token + ".archived"));
					await acknowledgeMutationRemoval(this.journal);
					return { success: true };
				} finally {
					closeSync(dir);
				}
			});
		} catch {
			return { success: false, error: "journal_write_failed" };
		} finally {
			// Fresh inventory, even on error. A visible rename with failed directory
			// fsync stays behind the existing pending-removal acknowledgement.
			this.withdraw(offer);
		}
	}
}

let active: MutationDamageMonitor | undefined;

export function startMutationDamageMonitor(): MutationDamageMonitor {
	stopMutationDamageMonitor();
	active = new MutationDamageMonitor();
	return active;
}

export function stopMutationDamageMonitor(): void {
	active?.stop();
	active = undefined;
}

export async function confirmUnreadableRecord(
	token: string,
): Promise<ModemMutationAckOutput> {
	return active?.confirm(token) ?? { success: false, error: "no_entry" };
}
