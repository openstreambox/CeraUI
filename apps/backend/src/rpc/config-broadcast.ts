/**
 * The one way a `config` broadcast leaves the device (GAP-2).
 *
 * The runtime config holds a cleared setting as absent, and the broadcast is
 * JSON, which drops an absent key: a `config` frame cannot say a key is gone,
 * and a client's merge keeps the old value. This remembers the keys clients
 * were sent and, after a broadcast that no longer carries one of them, sends
 * `config_clear` naming them, on the same sockets and after the `config` frame,
 * so a client never re-adds a cleared key from the same write. The `config`
 * frame itself is unchanged: old tabs and the cloud relay parse it as before,
 * and a client that predates `config_clear` ignores it. It is not relayed.
 *
 * Every config save is followed by a check here, so a write that cleared a key
 * clients hold is published even when its writer broadcasts nothing.
 */
import { CONFIG_CLEAR_EVENT } from "@ceraui/rpc/schemas";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { onConfigSave } from "../modules/config-save-listeners.ts";
import { excludedAudioInputs } from "../modules/streaming/audio-inputs.ts";
import { broadcastMsg } from "./compat.ts";
import { publicEventData } from "./events.ts";

let sent = new Set<string>();

// The keys of the frame clients get: its public form, where a stream id is a
// `*_configured` flag that every frame carries.
function carried(config: object): Set<string> {
	return new Set(
		Object.entries(publicEventData("config", config) as object)
			.filter(([, value]) => value !== undefined)
			.map(([key]) => key),
	);
}

/** A client was sent `config` outside a broadcast: its login snapshot. */
export function rememberConfigSent(config: object): void {
	for (const key of carried(config)) sent.add(key);
}

// The one raw `config` send; the cloud relay projects `relay` by its allowlist.
// Typed as the runtime config so the remote-status inventory sees its fields.
function sendConfig(frame: RuntimeConfig, relay: RuntimeConfig): void {
	broadcastMsg("config", frame, 0, true, relay);
}

/** Broadcast `config`, then `config_clear` for every key it no longer carries. */
export function broadcastConfig(config: RuntimeConfig): void {
	const now = carried(config);
	const cleared = [...sent].filter((key) => !now.has(key));
	sendConfig(config, config);
	if (cleared.length > 0) broadcastMsg(CONFIG_CLEAR_EVENT, { keys: cleared });
	sent = now;
	if (now.has("audio_inputs") || cleared.includes("audio_inputs"))
		broadcastMsg("status", { audio_mix_excluded: excludedAudioInputs(config) });
}

/**
 * Echo only the settings a writer changed, for a writer that cannot clear a
 * key. Every local frame carries the two Stream ID flags, read here from the
 * stored config: a partial frame without them would read as "unset". The
 * cloud relay keeps the whole config, which its allowlist projection reduces.
 */
export function broadcastConfigFields(
	config: RuntimeConfig,
	keys: readonly (keyof RuntimeConfig)[],
): void {
	const frame: Record<string, unknown> = {};
	for (const key of keys) frame[key] = config[key];
	frame.srt_streamid_configured = Boolean(config.srt_streamid);
	frame.relay_streamid_override_configured = Boolean(
		config.relay_streamid_override,
	);
	// The flags are wire-only, outside the stored schema.
	sendConfig(frame as RuntimeConfig, config);
	rememberConfigSent(frame);
}

// After the writer's own synchronous broadcast, which leaves nothing to publish.
onConfigSave((config) => {
	queueMicrotask(() => {
		const now = carried(config);
		if ([...sent].some((key) => !now.has(key))) broadcastConfig(config);
	});
});
