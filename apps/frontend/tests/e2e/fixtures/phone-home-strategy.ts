/** Validate source bytes at Vite load time, without a cached runtime import. */
export function assertPhoneHomeStrategy(
	source: string,
	expected: readonly string[],
) {
	const match = /export const strategy\s*=\s*(\[[^;]*?\]);/.exec(source);
	if (
		!match ||
		JSON.stringify(JSON.parse(match[1])) !== JSON.stringify(expected)
	) {
		throw new Error(
			"Phone Home fixture requires the shipped Paraglide strategy. Prepare i18n before starting workers (see frontend README).",
		);
	}
}
