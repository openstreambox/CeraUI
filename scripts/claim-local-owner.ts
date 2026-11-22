import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
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

const ownerSecret = randomBytes(32).toString('hex');
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
					const file = openSync(keyFile, 'wx', 0o600);
					try {
						writeFileSync(file, `${ownerSecret}\n`);
						fsyncSync(file);
					} finally {
						closeSync(file);
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
					if (reply.id === 'claim') resolve(reply.result?.success === true);
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
} finally {
	socket.close();
}
