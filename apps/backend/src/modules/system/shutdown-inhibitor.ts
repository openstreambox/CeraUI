export type InhibitorOwner = "encoder" | "carrying";

/** One kernel-owned descriptor, shared by both traffic owners. */
export function createShutdownInhibitor(acquire: () => () => void) {
	const owners = new Set<InhibitorOwner>();
	let release: (() => void) | undefined;
	let disposed = false;
	return {
		set(owner: InhibitorOwner, active: boolean): boolean {
			if (disposed) return false;
			if (active) owners.add(owner);
			else owners.delete(owner);
			if (owners.size && !release) {
				try {
					release = acquire();
				} catch {
					return false;
				}
			}
			if (!owners.size && release) {
				const close = release;
				release = undefined;
				close();
			}
			return true;
		},
		dispose() {
			disposed = true;
			owners.clear();
			const close = release;
			release = undefined;
			close?.();
		},
	};
}
