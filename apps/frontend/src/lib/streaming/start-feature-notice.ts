/**
 * The `stream-start-features` notice names the configured start features the
 * running stream went without. The backend sends a catalog key for the reason
 * and the features as tokens (`params.features`); each token reads as its own
 * localized phrase, joined by the locale's own pair wording. A token this build
 * does not know means the list cannot be said truthfully, so the caller falls
 * back to the notice's wire text. Pure.
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
 * `undefined` when the tokens are missing, empty or unknown, or a phrase is
 * missing from the catalog.
 */
export function localizedStartFeatureList(
	features: unknown,
	translate: Translate,
): string | undefined {
	if (!Array.isArray(features) || features.length === 0) return undefined;
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
