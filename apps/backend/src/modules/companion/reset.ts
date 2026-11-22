import { resetOwnership, type SetupVerifier } from "./channel.ts";
import type { CompanionState, CompanionStore } from "./store.ts";

/**
 * Physical reset, in the order that never leaves a gap:
 *
 * 1. Lock legacy first-password setup, so clearing the password cannot hand
 *    the box to whoever reaches it first.
 * 2. Forget the owner password and every remembered or temporary session.
 * 3. Forget every companion device, advance the generation, keep retired
 *    claim keys and install the fresh setup material.
 * 4. Close the companion sockets.
 *
 * If the lock fails nothing is cleared. The trigger (a local gesture, a card
 * reset mark) and the production lock come with the release work.
 */
export interface PhysicalResetDeps {
	store: CompanionStore;
	fresh: SetupVerifier;
	lockLegacySetup(): Promise<void>;
	clearLegacyCredentials(): Promise<number>;
	closeCompanionSockets(): void;
}

export async function physicalReset(
	deps: PhysicalResetDeps,
): Promise<CompanionState & { legacy_revoked: number }> {
	await deps.lockLegacySetup();
	const legacyRevoked = await deps.clearLegacyCredentials();
	const next = resetOwnership(deps.store, deps.fresh);
	deps.closeCompanionSockets();
	return { ...next, legacy_revoked: legacyRevoked };
}
