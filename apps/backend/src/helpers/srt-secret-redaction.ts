/** Scrub structured/URI SRT credentials from diagnostic text, including old journal entries. */
export function redactSrtPassphrases(text: string): string {
	return text
		.replace(
			/("(?:srt_)?passphrase"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
			'$1"[REDACTED]"',
		)
		.replace(
			/((?:srt_)?passphrase=)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s&"']+)/gi,
			"$1[REDACTED]",
		);
}
