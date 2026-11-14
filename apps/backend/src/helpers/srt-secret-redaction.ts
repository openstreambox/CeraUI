/** Scrub structured/URI SRT credentials from diagnostic text, including old journal entries. */
export function redactSrtPassphrases(text: string): string {
	return text
		.replace(
			/(\\"(?:srt[_-]?)?passphrase\\"\s*:\s*\\")(?:[^"\\]|\\(?!"))*\\"/gi,
			'$1[REDACTED]\\"',
		)
		.replace(
			/("(?:srt[_-]?)?passphrase"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
			'$1"[REDACTED]"',
		)
		.replace(
			/((?:srt[_-]?)?passphrase=)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s&"']+)/gi,
			"$1[REDACTED]",
		);
}

/** Remove recoverable encryption credentials at every config transport boundary. */
export function publicSrtConfig(payload: unknown): unknown {
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("srt_passphrase" in payload)
	)
		return payload;
	const { srt_passphrase: _secret, ...config } = payload;
	return config;
}
