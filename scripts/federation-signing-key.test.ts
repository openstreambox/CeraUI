import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFederationSigningKey } from './federation-signing-key.ts';

test('imported signing keys retain arbitrary decoded bytes at mode 0600', () => {
	const dir = mkdtempSync(join(tmpdir(), 'signing-key-'));
	const previous = process.umask(0o022);
	try {
		const path = join(dir, 'key');
		const bytes = Buffer.from([0, 255, 195, 40, 128, 10]);
		writeFederationSigningKey(path, bytes.toString('base64'));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path)).toEqual(bytes);
	} finally {
		process.umask(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});
