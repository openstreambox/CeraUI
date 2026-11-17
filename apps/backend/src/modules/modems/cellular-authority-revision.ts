export interface PrivateStateStore {
	readonly dir: string;
	readonly change?: <T>(operation: () => Promise<T>) => Promise<T>;
}

import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";

const slots = new Map<string, { revision: number; pending: number }>();
const state = (store: PrivateStateStore, key: string) => {
	const name = `${store.dir}\0${key}`;
	let slot = slots.get(name);
	if (!slot) {
		slot = { revision: 0, pending: 0 };
		slots.set(name, slot);
	}
	return slot;
};
export class CellularAuthorityBusy extends Error {}
/** A slot cursor is independent of the global mutation journal. Readers retry a
 * concurrent write once and report contention without raising global recovery.
 * The caller still holds the unit's lifetime lease for every effect/retirement.
 */
export async function readCellularSlot(
	store: PrivateStateStore,
	key: string,
): Promise<unknown> {
	const slot = state(store, key);
	for (let attempt = 0; attempt < 2; attempt++) {
		const revision = slot.revision;
		const value = await readPrivateJson(store, key);
		if (!slot.pending && revision === slot.revision) return value;
	}
	throw new CellularAuthorityBusy("Cellular authority slot is changing");
}
export async function writeCellularSlot(
	store: PrivateStateStore,
	key: string,
	value: unknown,
): Promise<void> {
	const slot = state(store, key);
	slot.revision++;
	slot.pending++;
	try {
		const operation = () => writePrivateJson(store, key, value);
		if (store.change) await store.change(operation);
		else await operation();
	} finally {
		slot.pending--;
		slot.revision++;
	}
}
