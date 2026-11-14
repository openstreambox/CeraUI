import { writeFileAtomicSync } from '../apps/backend/src/helpers/config-loader.ts';

/** Keep imported signing material private without changing its decoded bytes. */
export function writeFederationSigningKey(path: string, encoded: string): void {
	writeFileAtomicSync(path, Buffer.from(encoded, 'base64'), { mode: 0o600 });
}
