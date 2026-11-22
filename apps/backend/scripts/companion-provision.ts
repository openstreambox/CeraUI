/**
 * Install fresh setup material for the experimental companion channel on an
 * unclaimed box and print its setup link once.
 *
 *   bun scripts/companion-provision.ts [--state <dir>] --out <new-file>
 *
 * Run as the backend's user on the box (or a bench personalization step that
 * has the box present). The box keeps only the claim public key and the setup
 * proof key; the secret exists in the link alone. `--out` creates a new
 * file with mode 0600 (it refuses an existing one); without it the link goes
 * to stdout, so redirect it under `umask 077`, never to a shared log.
 */
import { closeSync, fsyncSync, openSync, rmSync, writeFileSync } from "node:fs";

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
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const dir =
	(stateIndex >= 0 ? args[stateIndex + 1] : undefined) ??
	process.env.CERAUI_COMPANION_STATE_DIR ??
	DEFAULT_COMPANION_STATE_DIR;

// The output file is created before the box changes, so a link is never lost.
let fd: number | undefined;
try {
	if (out) fd = openSync(out, "wx", 0o600);
	const store = new CompanionStore(dir);
	const { setupId, secret } = newSetupSecret();
	provisionSetup(store, {
		setupId,
		claimKey: deriveClaimKey(secret, setupId).publicKey,
		proofKey: deriveSetupProofKey(secret, setupId),
	});
	const link = `${formatSetupLink({ setupId, secret, fingerprint: store.identity().fingerprint })}\n`;
	if (fd === undefined) process.stdout.write(link);
	else {
		writeFileSync(fd, link);
		fsyncSync(fd);
	}
} catch (error) {
	if (out && fd !== undefined) rmSync(out, { force: true });
	console.error(
		error instanceof CompanionStoreError
			? error.message
			: "Provisioning failed. Check the state directory and output file.",
	);
	process.exitCode = 1;
} finally {
	if (fd !== undefined) closeSync(fd);
}
