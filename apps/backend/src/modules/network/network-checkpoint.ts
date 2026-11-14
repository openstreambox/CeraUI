import { randomUUID } from "node:crypto";

export interface NetworkChangeSession {
	readonly id: string;
	readonly openedAt: number;
	readonly authenticated: boolean;
	/** Trusted arrival interface; unavailable evidence must remain undefined. */
	readonly ingress: string | undefined;
}

export interface NetworkCheckpointDeps {
	readonly now: () => number;
	readonly create: (devices: string[], timeout: number) => Promise<string>;
	readonly live: (path: string) => Promise<boolean>;
	readonly destroy: (path: string) => Promise<void>;
	readonly rollback: (path: string) => Promise<void>;
}

interface PendingChange {
	id: string;
	path: string;
	startedAt: number;
	appliedAt: number;
	expiresAt: number;
	creator: string;
	devices: string[];
	save: Array<() => Promise<void>>;
}

/** NM owns the timer and snapshots. This owner holds only confirmation policy. */
export function createNetworkCheckpointOwner(deps: NetworkCheckpointDeps) {
	let pending: PendingChange | undefined;
	let busy = false;

	async function current() {
		const change = pending;
		if (change && !(await deps.live(change.path)) && pending === change)
			pending = undefined;
		return pending;
	}

	return {
		async status() {
			const change = await current();
			return change ? { id: change.id, expiresAt: change.expiresAt } : null;
		},
		async apply(
			session: NetworkChangeSession,
			devices: string[],
			applyInMemory: () => Promise<Array<() => Promise<void>>>,
		) {
			if (!session.authenticated || devices.length === 0 || busy) {
				throw new Error("Network change unavailable");
			}
			busy = true;
			let path: string | undefined;
			try {
				if (await current()) throw new Error("Network change pending");
				const startedAt = deps.now();
				path = await deps.create(devices, 90);
				const change: PendingChange = {
					id: randomUUID(),
					path,
					startedAt,
					appliedAt: startedAt,
					expiresAt: startedAt + 90_000,
					creator: session.id,
					devices: [...devices],
					save: [],
				};
				pending = change;
				change.save = await applyInMemory();
				change.appliedAt = deps.now();
				if (deps.now() >= change.expiresAt || !(await deps.live(path))) {
					throw new Error("Network change expired");
				}
				return { id: change.id, expiresAt: change.expiresAt };
			} catch (error) {
				if (path) {
					// A rollback failure must not destroy the daemon's armed timer.
					try {
						await deps.rollback(path);
					} catch {
						/* NM retains ownership. */
					}
					pending = undefined;
				}
				throw error;
			} finally {
				busy = false;
			}
		},
		async confirm(id: string, session: NetworkChangeSession) {
			if (busy) throw new Error("Network change busy");
			busy = true;
			try {
				const change = await current();
				if (
					!change ||
					change.id !== id ||
					!session.authenticated ||
					session.id === change.creator ||
					session.openedAt <= change.appliedAt ||
					!session.ingress ||
					!change.devices.includes(session.ingress) ||
					deps.now() >= change.expiresAt
				) {
					throw new Error(
						"Reconnect over the changed network before confirming",
					);
				}
				// Destroy is the daemon-side expiry fence. Never save before it:
				// a timed-out checkpoint must not race a persistent candidate write.
				await deps.destroy(change.path);
				pending = undefined;
				for (const save of change.save) await save();
			} finally {
				busy = false;
			}
		},
	};
}
