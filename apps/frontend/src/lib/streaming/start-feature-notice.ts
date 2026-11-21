/**
 * The `stream-start-features` notice names the configured start features the
 * running stream went without. The backend sends a catalog key for the reason
 * and the features as tokens (`params.features`); each token reads as its own
 * localized phrase, joined by the locale's own pair wording. A list this build
 * cannot say truthfully (an unknown or repeated token, or both composition
 * variants at once, which the backend never sends) makes the caller fall back
 * to the notice's wire text. Pure.
 */
export const START_FEATURES_NOTICE_KEYS: ReadonlySet<string> = new Set([
	"notifications.startFeatures.unsupported",
	"notifications.startFeatures.unconfirmed",
]);

const FEATURE_KEYS: ReadonlyMap<string, string> = new Map([
	["audio-mix", "notifications.startFeatures.audioMix"],
	["composition", "notifications.startFeatures.composition"],
	["custom-layout", "notifications.startFeatures.customLayout"],
]);

const PAIR_KEY = "notifications.startFeatures.pair";

type Translate = (
	key: string,
	params?: Record<string, string | number | boolean>,
) => string | undefined;

/**
 * The localized feature list for the notice's `{features}` slot, or
 * `undefined` when the tokens are missing, empty, unknown, repeated or name
 * both composition variants, or a phrase is missing from the catalog.
 */
export function localizedStartFeatureList(
	features: unknown,
	translate: Translate,
): string | undefined {
	if (!Array.isArray(features) || features.length === 0) return undefined;
	if (new Set(features).size !== features.length) return undefined;
	if (features.includes("composition") && features.includes("custom-layout"))
		return undefined;
	const phrases: string[] = [];
	for (const token of features) {
		const key = typeof token === "string" ? FEATURE_KEYS.get(token) : undefined;
		const phrase = key === undefined ? undefined : translate(key);
		if (phrase === undefined) return undefined;
		phrases.push(phrase);
	}
	let list: string | undefined = phrases[0];
	for (const next of phrases.slice(1)) {
		list =
			list === undefined
				? undefined
				: translate(PAIR_KEY, { first: list, second: next });
	}
	return list;
}
