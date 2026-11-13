import type { BondEntry } from "./bind-map.ts";
import {
	type BindMapPublication,
	type BindMapWriterDeps,
	publishBondMapping,
} from "./bind-map-writer.ts";

export interface CapturedBondEntry {
	readonly entry: BondEntry;
	readonly current: () => boolean;
}
export interface BondPublicationQueueDeps {
	readonly capture: (entry: BondEntry) => CapturedBondEntry;
	readonly writer: () => BindMapWriterDeps;
	readonly published: (
		entries: readonly BondEntry[],
		result: BindMapPublication,
		current: () => boolean,
		captured: readonly CapturedBondEntry[],
	) => void;
}
/** One writer and commit order for launch, refresh and withdrawal. Each
 * captured row needs its original observation at every file dispatch. A
 * revocation during I/O gets one bounded restrictive republication; churn or
 * I/O failure keeps the publication unavailable, never timeout-open.
 */
export class BondPublicationQueue {
	private tail: Promise<void> = Promise.resolve();
	constructor(private readonly deps: BondPublicationQueueDeps) {}
	publish(
		entries: readonly BondEntry[],
		owned: () => boolean = () => true,
	): Promise<BindMapPublication> {
		const captured = entries.map((entry) => this.deps.capture(entry));
		const operation = this.tail.then(async () => {
			const refused: BindMapPublication = {
				ok: false,
				reason: "source_changed",
				changed: true,
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				if (!owned()) return refused;
				const selected = captured.filter((row) => row.current()),
					current = () => selected.every((row) => row.current()),
					writer = this.deps.writer();
				let revoked = false;
				const permit = () => {
					if (!owned()) throw new Error("Bond publication lease retired");
					if (current()) return;
					revoked = true;
					throw new Error("Bond publication observation retired");
				};
				const snapshot = selected.map((row) => Object.freeze({ ...row.entry }));
				const result = await publishBondMapping(snapshot, {
					...writer,
					writeFile: async (path, contents) => {
						permit();
						await writer.writeFile(path, contents);
					},
					renameFile: async (from, to) => {
						permit();
						await writer.renameFile(from, to);
					},
					removeFile: async (path) => {
						if (!owned()) throw new Error("Bond publication lease retired");
						await writer.removeFile(path);
					},
				});
				if (!owned()) return refused;
				if (!revoked && current()) {
					this.deps.published(
						snapshot,
						result,
						current,
						selected.map((row, i) => ({
							entry: snapshot[i] as BondEntry,
							current: row.current,
						})),
					);
					return result;
				}
			}
			this.deps.published([], refused, () => false, []);
			return refused;
		});
		this.tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
	/** A receipt taken after this await cannot precede any already-queued write. */
	drain(): Promise<void> {
		return this.tail;
	}
}
