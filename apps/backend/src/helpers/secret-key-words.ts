/**
 * Whole-word credential key names, shared by the logger's key walker and the
 * support-bundle and export text redaction so both apply one rule.
 */

/**
 * Credential words, matched as WHOLE words of a key after splitting it on case
 * changes, separators and dots. The logger's `SENSITIVE_KEY_RE` is a substring match,
 * so it cannot hold `pass` (it would eat `video_passthrough` and every `bypass`)
 * or `key` (every `keyframe`); split into words they are safe, and `ssh_pass`,
 * `sshPassHash`, `wifi-pwd` and `remote_key` are caught without naming each one.
 */
const SECRET_KEY_WORDS: ReadonlySet<string> = new Set<string>([
	"pass",
	"passwd",
	"pwd",
	"passcode",
	"passkey",
	"psk",
	"privkey",
	"apikey",
	"secret",
	"secrets",
	"password",
	"passwords",
	"passphrase",
]);

/** A `key` or `hash` word is key material when one of these words names it. */
const KEY_MATERIAL_QUALIFIERS: ReadonlySet<string> = new Set<string>([
	"remote",
	"private",
	"priv",
	"ssh",
	"api",
	"ingest",
	"stream",
	"signing",
	"access",
	"session",
	"pairing",
	"shared",
	"preshared",
	"encryption",
	"wireguard",
	"wg",
	"shadow",
]);

/** Lower-case words of a key: `sshPassHash`, `ssh_pass_hash` and `ssh.pass-hash` all give ssh, pass, hash. */
export function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/**
 * Whole-word credential test: a secret word, or `key`/`hash` named by a
 * qualifier in the key itself or in its parent key, so `remote_key`,
 * `{ remote: { key } }` and `{ ssh: { hash } }` are all caught.
 */
export function isSecretWordKey(key: string, parentKey?: string): boolean {
	const words = keyWords(key);
	if (words.some((word) => SECRET_KEY_WORDS.has(word))) return true;
	const parentWords = parentKey === undefined ? [] : keyWords(parentKey);
	return words.some(
		(word, index) =>
			(word === "key" || word === "keys" || word === "hash") &&
			(words.some(
				(other, at) => at !== index && KEY_MATERIAL_QUALIFIERS.has(other),
			) ||
				parentWords.some((other) => KEY_MATERIAL_QUALIFIERS.has(other))),
	);
}
