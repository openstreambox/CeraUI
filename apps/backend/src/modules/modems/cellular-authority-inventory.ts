import {
	type PrivateJsonMigration,
	verifyMigratedPrivateJson,
	withMigratedPrivateJson,
} from "../../helpers/migrating-private-json.ts";
import {
	listPrivateJsonKeys,
	readPrivateJson,
} from "../../helpers/private-json-state.ts";
import { parseCarrierIntentSlot } from "./automatic-carrier-intent.ts";
import { cellularAuthorityMigration } from "./cellular-authority-store.ts";
import { parsePreparationRecord } from "./cellular-preparation-state.ts";

export async function inventoryCellularMigration<T>(
	migration: PrivateJsonMigration<T>,
	mode: "migrate" | "verify",
): Promise<void> {
	const inventory = async () => {
		const source = await listPrivateJsonKeys(migration.source);
		return {
			source,
			keys: [
				...new Set([
					...source,
					...(await listPrivateJsonKeys(migration.destination)),
					...(await listPrivateJsonKeys(migration.receipts)),
				]),
			].sort(),
		};
	};
	const before = await inventory();
	for (const key of before.keys) {
		if (mode === "migrate")
			await withMigratedPrivateJson(migration, key, async () => undefined);
		else await verifyMigratedPrivateJson(migration, key);
	}
	// Copy/receipt creation does not change the union of logical slots. New or
	// removed source authority cannot be hidden by a successful partial census.
	if (JSON.stringify(before) !== JSON.stringify(await inventory()))
		throw new Error("Cellular authority inventory changed during recovery");
}
/** Boot handles ALL remembered pairs, including a SIM that is not inserted.
 * The existing mutation recovery owner owns retries; runtime verification is
 * read-only and cannot repeat a migration or a hardware effect.
 */
export async function inventoryCellularAuthority(
	mode: "migrate" | "verify",
): Promise<void> {
	for (const [kind, directory, parse] of [
		[
			"automatic-carrier-intent",
			process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR,
			parseCarrierIntentSlot,
		],
		[
			"cellular-preparation",
			process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR,
			parsePreparationRecord,
		],
	] as const) {
		if (directory !== undefined) {
			const store = { dir: directory };
			const keys = await listPrivateJsonKeys(store);
			for (const key of keys) {
				const value = await readPrivateJson(store, key);
				if (value !== undefined) parse(value, key);
			}
			if (
				JSON.stringify(keys) !==
				JSON.stringify(await listPrivateJsonKeys(store))
			)
				throw new Error("Cellular authority inventory changed during recovery");
		} else {
			await inventoryCellularMigration(
				cellularAuthorityMigration<unknown>(kind, parse),
				mode,
			);
		}
	}
}
