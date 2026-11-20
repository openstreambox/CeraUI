export type InhibitorOwner = "encoder" | "carrying";

/** One kernel-owned descriptor, shared by both traffic owners. */
export function createShutdownInhibitor(
	acquire: () => (() => void) | Promise<() => void>,
) {
	const owners = new Set<InhibitorOwner>();
	let release: (() => void) | undefined;
	let disposed = false;
	// Set while an admitted power action runs: owners are kept, the lock is not.
	let yielded = false;
	let pending: Promise<void> | undefined;
	let retryAt = 0;
	const lock = {
		set(owner: InhibitorOwner, active: boolean): boolean {
			if (disposed) return false;
			if (active) owners.add(owner);
			else owners.delete(owner);
			if (yielded) return owners.size === 0;
			if (owners.size && !release) {
				try {
					if (pending || performance.now() < retryAt) return false;
					const result = acquire();
					if (typeof result === "function") release = result;
					else {
						pending = result
							.then(
								(close) => {
									if (disposed || yielded || !owners.size) close();
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
		/**
		 * This process's own lock must not refuse a power action this process
		 * has already admitted. Closes the descriptor and stops reacquisition
		 * while keeping the owners; the returned function takes the lock again
		 * for a submission that failed. Other processes' locks still apply.
		 */
		yieldForPowerAction(): () => void {
			if (disposed) return () => undefined;
			yielded = true;
			const close = release;
			release = undefined;
			close?.();
			let resumed = false;
			return () => {
				if (resumed || disposed) return;
				resumed = true;
				yielded = false;
				retryAt = 0;
				const owner = owners.values().next();
				if (!owner.done) lock.set(owner.value, true);
			};
		},
		dispose() {
			disposed = true;
			owners.clear();
			const close = release;
			release = undefined;
			close?.();
		},
	};
	return lock;
}
