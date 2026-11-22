/**
 * Install fresh setup material for the experimental companion channel on an
 * unclaimed box and print its setup link once.
 *
 *   bun scripts/companion-provision.ts [--state <dir>] > private-file
 *
 * Run as the backend's user on the box (or a bench personalization step that
 * has the box present). The box keeps only the claim public key and the setup
 * proof key; the secret exists in the printed link alone. Print it to a
 * private file or the insert printer, never to a shared terminal log.
 */
import { provisionSetup } from "../src/modules/companion/channel.ts";
import {
	deriveClaimKey,
	deriveSetupProofKey,
} from "../src/modules/companion/keys.ts";
import {
	formatSetupLink,
	newSetupSecret,
} from "../src/modules/companion/setup-link.ts";
import {
	CompanionStore,
	CompanionStoreError,
	DEFAULT_COMPANION_STATE_DIR,
} from "../src/modules/companion/store.ts";

const args = process.argv.slice(2);
const stateIndex = args.indexOf("--state");
const dir =
	(stateIndex >= 0 ? args[stateIndex + 1] : undefined) ??
	process.env.CERAUI_COMPANION_STATE_DIR ??
	DEFAULT_COMPANION_STATE_DIR;

try {
	const store = new CompanionStore(dir);
	const { setupId, secret } = newSetupSecret();
	provisionSetup(store, {
		setupId,
		claimKey: deriveClaimKey(secret, setupId).publicKey,
		proofKey: deriveSetupProofKey(secret, setupId),
	});
	process.stdout.write(
		`${formatSetupLink({ setupId, secret, fingerprint: store.identity().fingerprint })}\n`,
	);
} catch (error) {
	console.error(
		error instanceof CompanionStoreError
			? error.message
			: "Provisioning failed. Check the state directory.",
	);
	process.exitCode = 1;
}
