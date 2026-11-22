/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import type { AddonConfig, AddonState } from "@ceraui/rpc/schemas";
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	coerceLegacySource,
	RUNTIME_CONFIG_DEFAULTS,
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { logger } from "../helpers/logger.ts";
import {
	RuntimeConfigAuthorityError,
	readRuntimeConfigAuthority,
} from "../helpers/runtime-config-authority.ts";
import { setSrtPassphraseRedactionSource } from "../helpers/srt-secret-redaction.ts";
import { setStreamIdRedactionSource } from "../helpers/stream-id-secret.ts";
import { MOCK_CONFIG_PAIRING_DEFAULTS } from "../mocks/mock-config.ts";
import { shouldUseMocks } from "../mocks/mock-service.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";
import { getSshPasswordHash, setSshPasswordHash } from "./system/ssh.ts";

/**
 * Where the runtime config persists.
 *
 * Bare and CWD-relative BY DESIGN: the shipped unit pins
 * `WorkingDirectory=/opt/ceralive/`, so on a device it always resolves under the
 * service's own state directory. Under a test runner there is no such anchor —
 * the CWD is wherever the suite happened to be invoked from — and `saveConfig()`
 * rewrites the file WHOLE, so a suite exercising the real persistence path
 * against this default overwrites a live `config.json` with its fixtures. Tests
 * therefore redirect it; see `setConfigFilePath`.
 */
let configFile = "config.json";

export function getConfigFilePath(): string {
	return configFile;
}

export function setConfigFilePath(filePath: string): void {
	configFile = filePath;
}

let config: RuntimeConfig = {};
let localClaimDigest: string | undefined;
setSrtPassphraseRedactionSource(() => [config.srt_passphrase]);
setStreamIdRedactionSource(() => [
	config.srt_streamid,
	config.relay_streamid_override,
]);
let authorityFailure: RuntimeConfigAuthorityError | undefined;

export async function loadConfig() {
	authorityFailure = new RuntimeConfigAuthorityError();
	let raw: unknown;
	try {
		raw = await readRuntimeConfigAuthority(configFile);
	} catch (error) {
		if (error instanceof RuntimeConfigAuthorityError) authorityFailure = error;
		throw error;
	}
	// The default audio source is the "Auto" sentinel (RUNTIME_CONFIG_DEFAULTS):
	// the audio follows the video source, resolved at start/idle-preview. This
	// subsumes the former static per-board asrc guess.
	const result = await loadJsonConfig(
		configFile,
		runtimeConfigSchema,
		RUNTIME_CONFIG_DEFAULTS,
		{ parsed: raw },
	);
	config = coerceLegacySource(result.data);
	// A malformed existing credential must not be interpreted as first setup.
	// A malformed digest was already dropped by the per-field salvage above, so
	// it withholds claim setup without touching any other setting.
	localClaimDigest = Object.hasOwn(raw as object, "password_hash")
		? undefined
		: config.local_claim_digest;
	delete config.local_claim_digest;

	// Apply mock pairing AFTER file load so it overrides any absent/undefined remote_key in config.json
	// shouldUseMocks() is false on real devices.
	if (shouldUseMocks()) {
		Object.assign(config, MOCK_CONFIG_PAIRING_DEFAULTS);
	}

	logger.debug("config loaded", config);

	// Lazy import breaks the config↔audio cycle (audio.ts imports getConfig).
	const { warnIfConfiguredAudioSourceUnavailable } = await import(
		"./streaming/audio.ts"
	);
	warnIfConfiguredAudioSourceUnavailable(config.asrc);

	// Extract and set password hashes (they're stored separately for security)
	setPasswordHash(config.password_hash);
	setSshPasswordHash(config.ssh_pass_hash);

	// Clear password hashes from in-memory config for security
	config.password_hash = undefined;
	config.ssh_pass_hash = undefined;
	authorityFailure = undefined;
}

function writeConfig(
	passwordHash: string | undefined,
	claimDigest: string | undefined,
) {
	if (authorityFailure) throw authorityFailure;
	const dataToSave: RuntimeConfig = {
		...config,
		password_hash: passwordHash,
		// The digest is a first-owner verifier only. Any owner hash spends it.
		local_claim_digest: passwordHash ? undefined : claimDigest,
		ssh_pass_hash: getSshPasswordHash(),
	};
	// Must stay sync: sync callers (setBitrate/setAutostart) depend on the write
	// finishing before return. Atomic (temp+fsync+rename) so a crash mid-write
	// can't corrupt config.json — add-on state lives here too (E3).
	writeFileAtomicSync(configFile, JSON.stringify(dataToSave), { mode: 0o600 });
}

export function saveConfig() {
	const ownerHash = getPasswordHash();
	if (ownerHash) localClaimDigest = undefined;
	writeConfig(ownerHash, localClaimDigest);
}

export function getLocalClaimDigest(): string | undefined {
	return isRuntimeConfigAvailable() ? localClaimDigest : undefined;
}

/** Publish neither half of the claim until the single durable write succeeds. */
export function commitLocalClaim(ownerHash: string): void {
	try {
		writeConfig(ownerHash, undefined);
	} catch (error) {
		// A failed directory fsync can follow a completed rename. Freeze writes
		// until a fresh config load can establish which state is on disk.
		authorityFailure = new RuntimeConfigAuthorityError(error);
		throw authorityFailure;
	}
	localClaimDigest = undefined;
	setPasswordHash(ownerHash);
}

/**
 * After a failed claim write, read the file back to learn whether the owner
 * hash landed (a fault after the rename still published it). Throws while the
 * file stays unreadable; the caller then hands it to the recovery owner.
 */
export async function settleLocalClaimWrite(
	ownerHash: string,
): Promise<boolean> {
	await loadConfig();
	return getPasswordHash() === ownerHash;
}

/** False until a strict load has succeeded; the boot owner retries until it does. */
export function isRuntimeConfigAvailable(): boolean {
	return authorityFailure === undefined;
}

export function getConfig(): RuntimeConfig {
	if (authorityFailure) throw authorityFailure;
	return config;
}

export function getAddons(): AddonConfig {
	return getConfig().addons ?? {};
}

export function setAddonState(id: string, state: AddonState): void {
	config.addons = { ...getAddons(), [id]: state };
	saveConfig();
}

export function removeAddonState(id: string): void {
	const { [id]: _removed, ...rest } = getAddons();
	config.addons = rest;
	saveConfig();
}
