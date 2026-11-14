import { FAMILY_REFRESH_MS } from "../link-family.ts";

export type FamilyRefreshDeps = {
	interval: (tick: () => void, ms: number) => () => void;
	subscribe: (change: () => void) => () => void;
};
/** Session-owned timer and source subscription share a non-overlapping refresh. */
export function createFamilyRefresh(
	refresh: () => Promise<void>,
	deps: FamilyRefreshDeps,
): () => void {
	let refreshing = false,
		disposed = false;
	const tick = async () => {
		if (refreshing || disposed) return;
		refreshing = true;
		try {
			await refresh();
		} finally {
			refreshing = false;
		}
	};
	const clear = deps.interval(() => {
		void tick();
	}, FAMILY_REFRESH_MS);
	const remove = deps.subscribe(() => {
		void tick();
	});
	return () => {
		if (disposed) return;
		disposed = true;
		clear();
		remove();
	};
}
