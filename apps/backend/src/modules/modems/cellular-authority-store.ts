import { join } from "node:path";
import {
	type PrivateJsonMigration,
	PrivateMigrationBusy,
	withMigratedPrivateJson,
} from "../../helpers/migrating-private-json.ts";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import {
	CellularAuthorityBusy,
	readCellularSlot,
	writeCellularSlot,
} from "./cellular-authority-revision.ts";
import {
	noteMutationJournalReadFault,
	withMutationJournalChange,
} from "./mutation-journal-revision.ts";

const trackedWrite: typeof writePrivateJson = (store, key, value) =>
	withMutationJournalChange(() => writePrivateJson(store, key, value));

export type CellularAuthorityKind =
	| "automatic-carrier-intent"
	| "cellular-preparation"
	| "cellular-internal-context"
	| "cellular-internal-owner"
	| "apn-provenance";
/** The shared data partition, `/data` unless `CERALIVE_DATA_DIR` moves it, as it
 * does for the event store and shadow evidence: a dev host or a served test
 * device never has a `/data`, and an unwritable one reads as a recovery fault. */
export function cellularAuthorityMigration<T>(
	kind: CellularAuthorityKind,
	parse: PrivateJsonMigration<T>["parse"],
	env: Record<string, string | undefined> = process.env,
): PrivateJsonMigration<T> {
	const data = env.CERALIVE_DATA_DIR?.trim() || "/data";
	return {
		source: { dir: `/var/lib/ceralive/${kind}` },
		destination: { dir: join(data, "ceralive", kind) },
		receipts: { dir: join(data, "ceralive", `${kind}-migration`) },
		parse,
	};
}
/** The shared data partition, rather than an OS slot, owns cellular decisions.
 * Explicit stores are independent (including disconnected test instances).
 * Default access migrates the old slot under a per-key kernel lease before it
 * can report absence or authorize an update. No raw subscription IDs are filed.
 */
export async function accessCellularAuthority<T, Result>(
	kind: CellularAuthorityKind,
	key: string,
	parse: (value: unknown, key: string) => T,
	operation: (
		value: T | undefined,
		write: (value: T | undefined) => Promise<void>,
	) => Promise<Result>,
	explicitDirectory?: string,
	protectRecovery = true,
	revisionScope: "journal" | "slot" = "journal",
): Promise<Result> {
	const slotScoped = revisionScope === "slot";
	try {
		if (explicitDirectory !== undefined) {
			const store = { dir: explicitDirectory },
				raw = await (slotScoped ? readCellularSlot : readPrivateJson)(
					store,
					key,
				);
			return await operation(
				raw === undefined ? undefined : parse(raw, key),
				(value) =>
					(slotScoped
						? writeCellularSlot
						: protectRecovery
							? trackedWrite
							: writePrivateJson)(
						store,
						key,
						value === undefined ? undefined : parse(value, key),
					),
			);
		}
		return await withMigratedPrivateJson(
			cellularAuthorityMigration(kind, parse),
			key,
			operation,
			{
				read: slotScoped ? readCellularSlot : readPrivateJson,
				write: slotScoped
					? writeCellularSlot
					: protectRecovery
						? trackedWrite
						: writePrivateJson,
				acquire: acquirePrivateStateLease,
			},
		);
	} catch (error) {
		if (slotScoped && error instanceof PrivateMigrationBusy)
			throw new CellularAuthorityBusy(error.message, { cause: error });
		if (protectRecovery && !(error instanceof CellularAuthorityBusy))
			noteMutationJournalReadFault();
		throw error;
	}
}
