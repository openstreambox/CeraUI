import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { localClaimCodeSchema } from '../packages/rpc/src/schemas/auth.schema.ts';

const [, , endpoint, keyFile] = process.argv;
if (!endpoint || !keyFile) {
	throw new Error('Usage: bun scripts/claim-local-owner.ts <ws-url> <new-key-file>');
}
const url = new URL(endpoint);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (
	(url.protocol !== 'wss:' && !(loopback && url.protocol === 'ws:')) ||
	url.pathname !== '/ws' ||
	url.username ||
	url.password ||
	url.search ||
	url.hash
) {
	throw new Error('Use a trusted wss: endpoint at /ws or a loopback test endpoint');
}

const entered = prompt('One-time setup code:')?.trim().toLowerCase();
const { success, data: code } = localClaimCodeSchema.safeParse(entered);
if (!success) throw new Error('Expected a 32-character hexadecimal setup code');

// An existing key file from an unconfirmed run is reused, so whichever request
// the box committed, the same key signs in.
const previous = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined;
if (previous !== undefined && !/^[0-9a-f]{64}$/.test(previous)) {
	throw new Error('The key file exists and does not hold a setup key');
}
const ownerSecret = previous ?? randomBytes(32).toString('hex');
const socket = new WebSocket(url);
try {
	const accepted = await new Promise<boolean>((resolve, reject) => {
		const signal = AbortSignal.timeout(10_000);
		signal.addEventListener('abort', () => reject(new Error('Setup timed out')), { once: true });
		socket.addEventListener('close', () => reject(new Error('Setup connection closed')), {
			once: true,
			signal,
		});
		socket.addEventListener('error', () => reject(new Error('Setup connection failed')), {
			once: true,
			signal,
		});
		socket.addEventListener(
			'open',
			() => {
				try {
					// Save first so a lost response never strands the new credential.
					if (previous === undefined) {
						const file = openSync(keyFile, 'wx', 0o600);
						try {
							writeFileSync(file, `${ownerSecret}\n`);
							fsyncSync(file);
						} finally {
							closeSync(file);
						}
					}
					socket.send(
						JSON.stringify({
							id: 'claim',
							path: ['auth', 'claimLocalOwner'],
							input: { code, ownerSecret },
						}),
					);
				} catch (error) {
					reject(error);
				}
			},
			{ once: true, signal },
		);
		socket.addEventListener(
			'message',
			(event) => {
				try {
					const reply = JSON.parse(event.data);
					if (reply.id !== 'claim') return;
					// Only an explicit answer is a verdict. An error reply can follow a
					// write whose outcome the box is still settling.
					if (typeof reply.result?.success === 'boolean') resolve(reply.result.success);
					else reject(new Error('Setup error reply'));
				} catch {
					reject(new Error('Invalid setup response'));
				}
			},
			{ signal },
		);
	});
	process.stdout.write(
		accepted ? 'Box claimed. Owner credential saved.\n' : 'The box refused setup.\n',
	);
	if (!accepted) process.exitCode = 1;
} catch (error) {
	// The box may have committed before the reply was lost.
	process.stderr.write(
		`The box did not confirm setup. ${keyFile} is kept; sign in with it, or run setup again with the same key file.\n`,
	);
	throw error;
} finally {
	socket.close();
}
