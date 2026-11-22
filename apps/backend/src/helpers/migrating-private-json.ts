import { createHash } from "node:crypto";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./private-json-state.ts";
import { acquirePrivateStateLease } from "./private-state-lease.ts";

const receiptSchema = z
	.object({
		version: z.literal(1),
		key: z.string().regex(/^[a-f0-9]{64}$/),
		sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export interface PrivateJsonMigration<T> {
	readonly source: { readonly dir: string };
	readonly destination: { readonly dir: string };
	readonly receipts: { readonly dir: string };
	/** Validate and canonicalize the complete record, including its file slot. */
	readonly parse: (value: unknown, key: string) => T;
}
export interface PrivateJsonMigrationIO {
	readonly read: typeof readPrivateJson;
	readonly write: typeof writePrivateJson;
	readonly acquire: typeof acquirePrivateStateLease;
}
const defaultIO: PrivateJsonMigrationIO = {
	read: readPrivateJson,
	write: writePrivateJson,
	acquire: acquirePrivateStateLease,
};
/**
 * Receipts this process has already written and fsynced. Recommitting one on
 * every access would turn each read into a durable write, and those writes
 * count as journal changes for runtime readers (a retried withdrawal would
 * then raise the global recovery barrier).
 */
const committedReceipts = new Set<string>();
export function forgetCommittedMigrationReceiptsForTest(): void {
	committedReceipts.clear();
}
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Read-only runtime verification never migrates, repairs or recreates a slot. */
export async function verifyMigratedPrivateJson<T>(
	migration: PrivateJsonMigration<T>,
	key: string,
): Promise<void> {
	const rawSource = await readPrivateJson(migration.source, key),
		source =
			rawSource === undefined ? undefined : migration.parse(rawSource, key),
		rawReceipt = await readPrivateJson(migration.receipts, key),
		receipt =
			rawReceipt === undefined ? undefined : receiptSchema.parse(rawReceipt),
		rawDestination = await readPrivateJson(migration.destination, key);
	if (rawDestination !== undefined) migration.parse(rawDestination, key);
	if (
		(source !== undefined && !receipt) ||
		(receipt &&
			(receipt.key !== key ||
				(source !== undefined && receipt.sourceHash !== hash(source))))
	)
		throw new Error("Private authority migration is incomplete or changed");
}
export class PrivateMigrationBusy extends Error {}

/** Copy authority before writing a migration receipt. The source is retained.
 * A receipt permits subsequent destination updates or deletion without reviving
 * the old baseline. Changed source authority and conflicting copies block.
 * Every new reader/writer holds the same short kernel lease; a lost receipt
 * reply can safely retry only an identical durable copy.
 */
export async function withMigratedPrivateJson<T, Result>(
	migration: PrivateJsonMigration<T>,
	key: string,
	operation: (
		value: T | undefined,
		write: (value: T | undefined) => Promise<void>,
	) => Promise<Result>,
	io: PrivateJsonMigrationIO = defaultIO,
): Promise<Result> {
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid migration slot");
	if (migration.source.dir === migration.destination.dir)
		throw new Error("Migration requires independent stores");
	const lease = await io.acquire(migration.receipts, key);
	if (!lease)
		throw new PrivateMigrationBusy("Private authority migration is busy");
	try {
		const sourceValue = await io.read(migration.source, key),
			source =
				sourceValue === undefined
					? undefined
					: migration.parse(sourceValue, key),
			rawReceipt = await io.read(migration.receipts, key),
			receipt =
				rawReceipt === undefined ? undefined : receiptSchema.parse(rawReceipt);
		if (
			receipt &&
			(receipt.key !== key ||
				(source !== undefined && receipt.sourceHash !== hash(source)))
		)
			throw new Error("Legacy private authority changed after migration");
		// Visible bytes are not an acknowledgement of a previous directory fsync.
		// Recommit a retained receipt before granting access, including after a
		// process restart or a lost reply from its original durable write.
		// Once per process: after that this process's own write acknowledged it.
		const committed = receipt
			? `${migration.receipts.dir}\0${key}\0${receipt.sourceHash}`
			: undefined;
		if (receipt && committed && !committedReceipts.has(committed)) {
			await io.write(migration.receipts, key, receipt);
			committedReceipts.add(committed);
		}
		if (!receipt && source !== undefined) {
			const destinationValue = await io.read(migration.destination, key),
				destination =
					destinationValue === undefined
						? undefined
						: migration.parse(destinationValue, key);
			if (destination !== undefined && hash(destination) !== hash(source))
				throw new Error("Private authority copies conflict");
			// Recommit even a matching copy: a previous visible write may not have
			// acknowledged its directory fsync. The receipt must follow that boundary.
			await io.write(migration.destination, key, source);
			const sourceHash = hash(source);
			await io.write(migration.receipts, key, {
				version: 1,
				key,
				sourceHash,
			});
			committedReceipts.add(`${migration.receipts.dir}\0${key}\0${sourceHash}`);
		}
		const current = await io.read(migration.destination, key);
		return await operation(
			current === undefined ? undefined : migration.parse(current, key),
			(value) =>
				io.write(
					migration.destination,
					key,
					value === undefined ? undefined : migration.parse(value, key),
				),
		);
	} finally {
		lease.release();
	}
}
