/**
 * The `config` frame a signed-in local client receives.
 *
 * The runtime config holds device-only secrets beside the settings a tab
 * shows: the pairing claim-code seed, password fields, stream ids and the SRT
 * passphrase. Every local `config` frame (login snapshot, broadcast, a single
 * socket push) is built through this projection, so a writer that echoes the
 * whole config cannot carry one of them to a browser.
 *
 * The rule is the log redactor's key rule ({@link isSensitiveKey}), applied at
 * every depth, so a new secret key is withheld here as soon as the logs
 * withhold it. A boolean under a matching key stays: it says whether a
 * capability or secret is on (`modem_capabilities.ussd`, `*_configured`), never
 * what the secret is.
 *
 * Add-on state (`addons` frames and the `addons.list` and `addons.getStatus`
 * replies) gets the same rule for its owner-typed `userConfig`.
 *
 * Two top-level keys are read back on purpose by the signed-in owner's own
 * dialogs, and stay: {@link OWNER_READABLE_CONFIG_KEYS}. Remote transports never
 * see them; they build their frames from a separate allowlist.
 */
import { isSensitiveKey } from "./logger.ts";
import { publicSrtConfig } from "./srt-secret-redaction.ts";
import { publicStreamIds } from "./stream-id-secret.ts";

/**
 * Secrets the owner reads back from the config frame: the SSH dialog shows
 * `ssh_pass` to copy, and the cloud-remote dialog fills its key field from
 * `remote_key`. Every signed-in local client holds the device password, the
 * same authority that sets both values. Top level only.
 */
export const OWNER_READABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
	"ssh_pass",
	"remote_key",
]);

/** Deeper than any config shape; a subtree past it is withheld, not sent raw. */
const MAX_DEPTH = 16;

function withhold(key: string, value: unknown): boolean {
	return isSensitiveKey(key) && typeof value !== "boolean";
}

function project(value: unknown, depth: number): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (depth >= MAX_DEPTH) return undefined;
	if (Array.isArray(value))
		return value.map((item) => project(item, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (withhold(key, item)) continue;
		out[key] = project(item, depth + 1);
	}
	return out;
}

/**
 * Project a runtime config (or a partial echo of it) for local clients. Stream
 * ids become their `*_configured` flags first, from the stored values, then
 * every sensitive key is dropped. The input is never mutated.
 */
export function publicLocalConfig(payload: unknown): unknown {
	const srtFree = publicSrtConfig(payload);
	if (Array.isArray(srtFree)) return project(srtFree, 0);
	if (typeof srtFree !== "object" || srtFree === null) return srtFree;
	const flagged: Record<string, unknown> = publicStreamIds(
		srtFree as Record<string, unknown>,
	);
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(flagged)) {
		if (OWNER_READABLE_CONFIG_KEYS.has(key)) {
			out[key] = item;
			continue;
		}
		if (withhold(key, item)) continue;
		out[key] = project(item, 1);
	}
	return out;
}

/**
 * One add-on's state for local clients. Its `userConfig` holds whatever the
 * owner typed at install, so a secret-named field there gets the same rule as
 * the config frame. Nothing in the page reads `userConfig` back.
 */
export function publicAddonState<T>(state: T): T {
	if (typeof state !== "object" || state === null) return state;
	const { userConfig } = state as { userConfig?: unknown };
	if (typeof userConfig !== "object" || userConfig === null) return state;
	return { ...state, userConfig: project(userConfig, 1) };
}

/** The `addons` event: a map of add-on id to state. */
export function publicAddonStates(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload))
		return payload;
	return Object.fromEntries(
		Object.entries(payload).map(([id, state]) => [id, publicAddonState(state)]),
	);
}
