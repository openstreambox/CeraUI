import {
	type PrivateJsonMigration,
	withMigratedPrivateJson,
} from "../../helpers/migrating-private-json.ts";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import { acquirePrivateStateLease } from "../../helpers/private-state-lease.ts";
import {
	noteMutationJournalReadFault,
	withMutationJournalChange,
} from "./mutation-journal-revision.ts";

const trackedWrite: typeof writePrivateJson = (store, key, value) =>
	withMutationJournalChange(() => writePrivateJson(store, key, value));

export type CellularAuthorityKind =
	| "automatic-carrier-intent"
	| "cellular-preparation"
	| "cellular-internal-context";
export function cellularAuthorityMigration<T>(
	kind: CellularAuthorityKind,
	parse: PrivateJsonMigration<T>["parse"],
): PrivateJsonMigration<T> {
	return {
		source: { dir: `/var/lib/ceralive/${kind}` },
		destination: { dir: `/data/ceralive/${kind}` },
		receipts: { dir: `/data/ceralive/${kind}-migration` },
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
): Promise<Result> {
	try {
		if (explicitDirectory !== undefined) {
			const store = { dir: explicitDirectory },
				raw = await readPrivateJson(store, key);
			return await operation(
				raw === undefined ? undefined : parse(raw, key),
				(value) =>
					(protectRecovery ? trackedWrite : writePrivateJson)(
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
				read: readPrivateJson,
				write: protectRecovery ? trackedWrite : writePrivateJson,
				acquire: acquirePrivateStateLease,
			},
		);
	} catch (error) {
		if (protectRecovery) noteMutationJournalReadFault();
		throw error;
	}
}
