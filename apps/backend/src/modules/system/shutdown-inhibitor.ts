export type InhibitorOwner = "encoder" | "carrying";

/** One kernel-owned descriptor, shared by both traffic owners. */
export function createShutdownInhibitor(
	acquire: () => (() => void) | Promise<() => void>,
) {
	const owners = new Set<InhibitorOwner>();
	let release: (() => void) | undefined;
	let disposed = false;
	let pending: Promise<void> | undefined;
	let retryAt = 0;
	return {
		set(owner: InhibitorOwner, active: boolean): boolean {
			if (disposed) return false;
			if (active) owners.add(owner);
			else owners.delete(owner);
			if (owners.size && !release) {
				try {
					if (pending || performance.now() < retryAt) return false;
					const result = acquire();
					if (typeof result === "function") release = result;
					else {
						pending = result
							.then(
								(close) => {
									if (disposed || !owners.size) close();
									else release = close;
								},
								() => {
									retryAt = performance.now() + 1000;
								},
							)
							.finally(() => {
								pending = undefined;
							});
						return false;
					}
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
		pending: () => pending,
		confirmed: () => Boolean(release),
		dispose() {
			disposed = true;
			owners.clear();
			const close = release;
			release = undefined;
			close?.();
		},
	};
}
