let retainedValues: () => readonly (string | undefined)[] = () => [];
export function setSrtPassphraseRedactionSource(
	source: typeof retainedValues,
): typeof retainedValues {
	const previous = retainedValues;
	retainedValues = source;
	return previous;
}

/** Scrub structured/URI SRT credentials from diagnostic text, including old journal entries. */
export function redactSrtPassphrases(text: string): string {
	let result = text;
	const variants = new Set<string>();
	for (const value of retainedValues()) {
		if (!value) continue;
		variants.add(value);
		variants.add(encodeURIComponent(value));
		let escaped = value;
		for (let depth = 0; depth < 3; depth++) {
			escaped = JSON.stringify(escaped).slice(1, -1);
			variants.add(escaped);
		}
	}
	for (const value of [...variants].sort((a, b) => b.length - a.length)) {
		result = result.replaceAll(value, "[REDACTED]");
	}
	return result
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
