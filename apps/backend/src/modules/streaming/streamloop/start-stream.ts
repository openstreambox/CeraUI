/*
    CeraUI - web UI for the CERALIVE project
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

// Core stream launch: spawns srtla_send under the process-runner supervisor,
// wires srtla per-uplink telemetry, then starts the engine session over the
// StreamingBackend seam.

import type { AudioConfig } from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO, type StartFailureClass } from "@ceraui/rpc/schemas";
import {
	buildSrtlaSendArgs,
	controlSocketPath,
} from "@ceraui/srtla-send/sender";
import type { RuntimeConfig } from "../../../helpers/config-schemas.ts";
import { logger } from "../../../helpers/logger.ts";
import { getConfig } from "../../config.ts";
import { setup } from "../../setup.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";
import {
	resetActiveEncodeLiveness,
	resetActivePassthrough,
} from "../active-passthrough.ts";
import {
	type LaunchedAudio,
	pinLaunchedAudio,
} from "../armed-stream-marker.ts";
import {
	type AudioIdentityEvidence,
	asrcProbe,
	audioIdentitySuccessor,
	isPseudoAudioSource,
	liveAudioIdentityEvidence,
	NO_AUDIO_ID,
	refreshBluetoothAudioDevices,
} from "../audio.ts";
import {
	audioInputEngineId,
	canPickAudioInput,
	effectiveAudioInputs,
	planLaunchAudio,
	unavailableAudioRoute,
} from "../audio-inputs.ts";
import {
	defaultBindMapSpawnDeps,
	resolveBindMapArgs,
} from "../bind-map-spawn.ts";
import { getLastCapabilities } from "../capabilities.ts";
import { SRTLA_LISTEN_PORT } from "../constants.ts";
import {
	embeddedAudioActive,
	isEmbeddedAudioPipeline,
} from "../embedded-audio.ts";
import { clearStreamProcessExit } from "../health.ts";
import { createLaunchTransaction } from "../launch-transaction.ts";
import {
	srtlaStatsFile,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../link-telemetry.ts";
import {
	hasOrderedMicProofs,
	micRouteKeys,
	networkAudioSource,
} from "../mic-route-admission.ts";
import type { Pipeline } from "../pipelines.ts";
import { replayPreviewEncodeMode } from "../preview-encode-replay.ts";
import { getLastPublishedBond } from "../srtla.ts";
import { resolvePinnedLaunchAudio, type StartAudio } from "../start-audio.ts";
import { assertStreamLaunchOwnership } from "../stream-launch-ownership.ts";
import { getStreamingBackend } from "../streaming-engine.ts";
import { srtlaSendExec } from "./exec-paths.ts";
import { resolveLaunchConfig } from "./launch-config.ts";
import { resolveProcessError } from "./process-error-patterns.ts";
import { spawnStreamingLoop, stopProcessAndWait } from "./process-runner.ts";

interface StartStreamBackend {
	start: ReturnType<typeof getStreamingBackend>["start"];
}

export interface StartStreamDeps {
	readonly getStreamingBackend: () => StartStreamBackend;
	readonly spawnStreamingLoop: typeof spawnStreamingLoop;
	readonly startLinkTelemetry: typeof startLinkTelemetry;
	readonly stopLinkTelemetry: typeof stopLinkTelemetry;
	readonly stopProcessAndWait: typeof stopProcessAndWait;
}

const defaultStartStreamDeps: StartStreamDeps = {
	getStreamingBackend,
	spawnStreamingLoop,
	startLinkTelemetry,
	stopLinkTelemetry,
	stopProcessAndWait,
};

let startStreamDeps = defaultStartStreamDeps;

export function setStartStreamDepsForTest(
	overrides: Partial<StartStreamDeps> | null,
): void {
	startStreamDeps =
		overrides === null
			? defaultStartStreamDeps
			: { ...defaultStartStreamDeps, ...overrides };
}

export interface AudioProbeDeps {
	probe?: (asrc: string) => Promise<string>;
	networkEmbeddedAudio?: boolean;
}

export const AUDIO_SOURCE_PROBE_FAILED = "audio_source_probe_failed";
export const IP_LIST_READ_FAILED = "ip_list_read_failed";
export const PREVIEW_ENCODE_REPLAY_FAILED = "preview_encode_replay_failed";

export type StartStreamResult =
	| { success: true }
	| {
			success: false;
			error: string;
			reason: string;
			/**
			 * `connect` is reachable from the preview-encode fence alone: it is the
			 * only gate here that actually dials the engine, and it does so before
			 * any start is accepted — which is precisely the phase's meaning, and
			 * what makes a mid-restart engine a retriable boot race rather than a
			 * hard refusal.
			 */
			phase: "params" | "connect" | "spawn-sender";
			/**
			 * Set when this site already knows the taxonomy class. The launch
			 * wrappers use it verbatim instead of re-deriving a class from the
			 * opaque `error` string.
			 */
			failureClass?: StartFailureClass;
	  };

export async function maybeProbeAudioSource(
	pipeline: Pipeline,
	config: RuntimeConfig,
	deps: AudioProbeDeps = {},
	evidence?: AudioIdentityEvidence,
): Promise<boolean> {
	if (!pipeline.supportsAudio || !config.asrc) return true;
	// A pipeline pseudo-source is not a device — never probe (nor probe-fail) it.
	if (isPseudoAudioSource(config.asrc)) return true;
	const networkEmbeddedAudio =
		deps.networkEmbeddedAudio ?? getLastCapabilities()?.network_embedded_audio;
	if (embeddedAudioActive(pipeline.audio_kind, networkEmbeddedAudio)) {
		return true;
	}
	try {
		if (deps.probe !== undefined) await deps.probe(config.asrc);
		else if (evidence === undefined) await asrcProbe(config.asrc);
		else await asrcProbe(config.asrc, evidence);
		return true;
	} catch (_err) {
		// asrcProbe rejects when the operator stops the stream before the audio
		// interface is found; the stream is already stopped, so signal abort.
		return false;
	}
}

/**
 * `acceptedConfig` came from validation or the restored stream, not from a
 * later read of saved settings. Only live bitrate and the audio roster can
 * change while starting.
 */
const autoLaunches = new WeakMap<StartAudio, ReturnType<typeof launchAudio>>();

function launchAudio(config: RuntimeConfig, startAudio: StartAudio) {
	const { config: launchConfig, publish } = resolveLaunchConfig(config);
	const chosen = launchConfig.asrc;
	const wasAuto = config.asrc === AUDIO_SOURCE_AUTO;
	const autoEvidence =
		wasAuto && chosen !== undefined && startAudio.restoration === undefined
			? liveAudioIdentityEvidence().get(chosen)
			: undefined;
	const audioEvidence =
		// Auto's lookup cannot clear uncertainty frozen for a saved mix leg.
		autoEvidence !== undefined &&
		chosen !== undefined &&
		startAudio.audioEvidence.get(chosen)?.kind !== "unavailable"
			? new Map(startAudio.audioEvidence).set(chosen, autoEvidence)
			: startAudio.audioEvidence;
	const audioOff = config.asrc === NO_AUDIO_ID;
	const micChoices =
		wasAuto && startAudio.restoration === undefined
			? startAudio.autoMicChoices(launchConfig, audioOff)
			: startAudio.micChoices;
	return {
		launchConfig,
		chosen,
		wasAuto,
		autoEvidence,
		audioEvidence,
		audioOff,
		micChoices,
		publish,
	};
}

function resolveLaunchRoute(
	{
		launchConfig,
		chosen,
		wasAuto,
		audioEvidence,
		audioOff,
	}: ReturnType<typeof launchAudio>,
	settings: StartAudio["config"],
) {
	const asrc = wasAuto
		? chosen &&
			(audioEvidence.has(chosen)
				? chosen
				: (audioIdentitySuccessor(chosen) ?? chosen))
		: settings.asrc;
	return resolvePinnedLaunchAudio(
		{ ...launchConfig, ...settings, asrc },
		audioEvidence,
		{ audioOff, embedded: isEmbeddedAudioPipeline(launchConfig.pipeline) },
	);
}

async function launchMicProofs(
	audio: AudioConfig,
	config: RuntimeConfig,
	originalKey: (id: string) => string,
	choices: StartAudio["micChoices"],
) {
	const ids =
		audio.inputs === undefined
			? [config.asrc]
			: micRouteKeys(audio).map(
					(key) =>
						effectiveAudioInputs(config)?.find(
							({ id }) => audioInputEngineId(id, config) === key,
						)?.id,
				);
	const proofs = await Promise.all(
		ids.map((id) =>
			id === undefined ? undefined : choices.get(originalKey(id)),
		),
	);
	return {
		ids,
		proofs: proofs.every((proof) => proof !== undefined) ? proofs : undefined,
	};
}

/** Preflight only a destructive replacement. Dispatch still verifies independently. */
export async function verifyReplacementAudio(
	capture: Pick<RuntimeConfig, "pipeline" | "source">,
	startAudio: StartAudio,
): Promise<() => boolean> {
	const audio = launchAudio({ ...capture, ...startAudio.config }, startAudio);
	const current = () => {
		const resolved = resolveLaunchRoute(audio, startAudio.config);
		if (!resolved.ok) return undefined;
		const config = {
			...audio.launchConfig,
			asrc: resolved.asrc,
			audio_inputs: resolved.audio_inputs,
		};
		const plan = planLaunchAudio(config, { audioOff: audio.audioOff });
		if (plan === null) return undefined;
		return { config, plan, originalKeys: resolved.originalKeys };
	};
	const initial = current();
	const refused = () => false;
	if (initial === undefined) return refused;
	const { config, plan, originalKeys } = initial;
	const keys = micRouteKeys(plan);
	let listed = () => true;
	if (plan !== undefined && keys.length > 0) {
		const { ids, proofs } = await launchMicProofs(
			plan,
			config,
			(id) => originalKeys.get(id) ?? startAudio.originalMicChoice(id),
			audio.micChoices,
		);
		listed = () =>
			ids.every((id) => id !== undefined && canPickAudioInput(config, id));
		if (
			!listed() ||
			proofs === undefined ||
			!hasOrderedMicProofs(proofs, keys.length) ||
			new Set(keys).size !== keys.length
		)
			return refused;
		const verified = await getStreamingBackend().admitMicRoutes({
			audio: { ...plan, backend: config.audio_backend },
			network: networkAudioSource(config.pipeline),
			operation: { kind: "verify", expected: proofs },
		});
		if (!Bun.deepEquals(proofs, verified)) return refused;
	}
	return () => {
		if (!listed() || !Bun.deepEquals(current(), initial)) return false;
		if (audio.wasAuto) autoLaunches.set(startAudio, audio);
		return true;
	};
}

export async function startStream(
	pipeline: Pipeline,
	srtlaAddr: string,
	srtlaPort: number,
	streamid: string,
	audioDeps: AudioProbeDeps = {},
	attemptId = "legacy-start",
	acceptedConfig: RuntimeConfig,
	startAudio: StartAudio,
): Promise<StartStreamResult> {
	assertStreamLaunchOwnership();
	if (startAudio.routeUnavailable) throw unavailableAudioRoute(attemptId);
	startAudio.verifiedMicChoices.clear();
	// The preview-encoder fence, and the reason it lives HERE. The engine fixes
	// the preview encoder when it builds the main graph, so the operator's mode
	// has to be in the engine's config BEFORE the `start` below — not racing it.
	// This function is the single point every start origin funnels through (UI,
	// autostart, set-profile, and all three restoration sites), and the engine
	// `start` has exactly one dispatch site, further down this same function. So
	// awaiting the replay here is what makes "no start of any origin outruns the
	// replay" true for ALL of them, instead of four call-site checks that the
	// fifth origin would silently miss.
	//
	// It runs before every other side effect on purpose: a refused mode must cost
	// nothing — no sender spawned, no audio probed, no bitrate written.
	const previewEncode = await replayPreviewEncodeMode(
		acceptedConfig.previewEncode,
	);
	assertStreamLaunchOwnership();
	if (!previewEncode.ok) {
		return {
			success: false,
			error: PREVIEW_ENCODE_REPLAY_FAILED,
			reason: PREVIEW_ENCODE_REPLAY_FAILED,
			phase: "connect",
			failureClass:
				previewEncode.failure === "unreachable"
					? "engine_unavailable"
					: "engine_internal",
		};
	}

	if (getConfig().audio_backend !== startAudio.config.audio_backend) {
		// The Bluetooth microphones may be listed for the backend saved since.
		await refreshBluetoothAudioDevices();
		assertStreamLaunchOwnership();
	}
	const config: RuntimeConfig = {
		...acceptedConfig,
		pipeline: pipeline.source,
		...startAudio.config,
	};
	// Auto can first resolve from the live roster, but retries cannot choose a
	// new microphone. Dispatch still rechecks the accepted physical identity.
	const prechecked = autoLaunches.get(startAudio);
	const audio =
		prechecked === undefined
			? launchAudio(config, startAudio)
			: {
					...prechecked,
					launchConfig: { ...config, ...prechecked.launchConfig },
				};
	if (audio.wasAuto)
		autoLaunches.set(startAudio, { ...audio, publish: undefined });
	audio.publish?.();
	const {
		launchConfig,
		chosen,
		wasAuto,
		autoEvidence,
		audioEvidence,
		audioOff,
		micChoices,
	} = audio;

	// A fresh stream start clears any prior unexpected-exit health flag so the
	// health rollup tracks this new session (ADR-0005 observe-and-notify). The
	// raw-bridge caches are dropped for the same reason: they describe the
	// PREVIOUS session, and the bridge holds its connection across a stop/start,
	// so nothing else would retire them. A new session must read as a genuine
	// cold start until its own first heartbeat lands.
	clearStreamProcessExit();
	resetActiveEncodeLiveness();
	resetActivePassthrough();

	const audioReady = await maybeProbeAudioSource(
		pipeline,
		launchConfig,
		audioDeps,
		chosen === undefined ? undefined : audioEvidence.get(chosen),
	);
	assertStreamLaunchOwnership();
	if (!audioReady) {
		logger.warn("startStream: audio source probe failed; aborting start", {
			asrc: launchConfig.asrc,
		});
		return {
			success: false,
			error: AUDIO_SOURCE_PROBE_FAILED,
			reason: AUDIO_SOURCE_PROBE_FAILED,
			phase: "params",
			failureClass: "audio_source_unavailable",
		};
	}
	const statsFile = srtlaStatsFile();
	// ADR-001 control socket: telemetry rides the JSON-RPC subscription when the
	// sender advertises it, with --stats-file as the airtight fallback poll.
	const controlSocket = controlSocketPath(SRTLA_LISTEN_PORT);
	let ipsContent: string;
	try {
		ipsContent = await Bun.file(setup.ips_file ?? "").text();
		assertStreamLaunchOwnership();
	} catch (error) {
		logger.warn("startStream: IP list read failed; aborting start", { error });
		return {
			success: false,
			error: IP_LIST_READ_FAILED,
			reason: IP_LIST_READ_FAILED,
			phase: "params",
		};
	}
	// ADR-003 §7: the capability probe runs BEFORE the argument vector is built,
	// so a new CeraUI against an OLD sender emits the byte-identical legacy vector.
	const bindMapArgs = await resolveBindMapArgs(
		srtlaSendExec,
		defaultBindMapSpawnDeps(getLastPublishedBond),
	);
	assertStreamLaunchOwnership();
	const transaction = createLaunchTransaction(attemptId, {
		warn: (message, meta) => logger.warn(message, meta),
	});
	try {
		const sender = startStreamDeps.spawnStreamingLoop(
			{ command: srtlaSendExec, role: "srtla_send" },
			[
				...buildSrtlaSendArgs({
					listenPort: SRTLA_LISTEN_PORT,
					srtlaHost: srtlaAddr,
					srtlaPort,
					ipsFile: setup.ips_file,
					statsFile,
					controlSocket,
					execPath: setup.srtla_path,
				}),
				...bindMapArgs,
			],
			(err) => {
				const resolved = resolveProcessError("srtla", err);
				if (resolved) {
					notificationBroadcast(
						"srtla",
						"error",
						resolved.message,
						5,
						true,
						false,
					);
				}
			},
		);
		transaction.register(() => startStreamDeps.stopProcessAndWait(sender));

		// Begin ingesting srtla_send's per-uplink telemetry. Seed the conn_id->iface
		// registry from the exact file srtla_send reads at spawn so tlm_id (file
		// order) maps back to interface names.
		startStreamDeps.startLinkTelemetry(statsFile, ipsContent.split("\n"), {
			controlSocket,
		});
		transaction.register(() => startStreamDeps.stopLinkTelemetry());

		let launchedAudio: LaunchedAudio | undefined;
		let launchedAsrc: RuntimeConfig["asrc"];
		let originalKeys: ReadonlyMap<string, string>;
		let checkedIds: readonly (string | undefined)[] = [];
		const engineConfig = launchConfig;
		await startStreamDeps.getStreamingBackend().start(
			engineConfig,
			{
				pipeline: pipeline.source,
				host: "127.0.0.1",
				port: SRTLA_LISTEN_PORT,
				streamid,
				inputResolved: true,
				// Auto's launch copy can read "No audio" without the operator picking it.
				audioOff,
				audioAtDispatch: () => {
					const settings = startAudio.config;
					const resolved = resolveLaunchRoute(audio, settings);
					if (!resolved.ok) throw unavailableAudioRoute(attemptId);
					originalKeys = resolved.originalKeys;
					launchedAsrc = resolved.asrc;
					launchedAudio = {
						...settings,
						asrc:
							wasAuto && autoEvidence === undefined
								? settings.asrc
								: resolved.asrc,
						audio_inputs: resolved.audio_inputs,
						audio_physical_ids: resolved.audio_physical_ids,
						audio_unverified_ids: resolved.audio_unverified_ids,
					};
					return { asrc: resolved.asrc, audio_inputs: resolved.audio_inputs };
				},
				micRoute: {
					attemptId,
					legacyAddressOnly: startAudio.restoration?.legacyAddressOnly === true,
					expected: async (audio) => {
						if (startAudio.restoration !== undefined)
							return startAudio.restoration.proofs;
						if (launchedAudio === undefined) return undefined;
						const projected = {
							...launchConfig,
							...launchedAudio,
							asrc: launchedAsrc,
						};
						const { ids, proofs } = await launchMicProofs(
							audio,
							projected,
							(id) => originalKeys.get(id) ?? startAudio.originalMicChoice(id),
							micChoices,
						);
						checkedIds = ids;
						return proofs;
					},
					applied: (proofs, backend) => {
						for (const [index, proof] of (proofs ?? []).entries()) {
							const id = checkedIds[index];
							if (id === undefined) continue;
							startAudio.verifiedMicChoices.set(id, proof);
							startAudio.verifiedMicChoices.set(
								originalKeys.get(id) ?? startAudio.originalMicChoice(id),
								proof,
							);
						}
						if (launchedAudio !== undefined)
							pinLaunchedAudio({
								...launchedAudio,
								streamConfig: engineConfig,
								...(proofs === undefined ? {} : { asrc: launchedAsrc }),
								...(backend === undefined ? {} : { audio_backend: backend }),
								// An empty applied batch is not a historical address-only marker.
								mic_route_proofs:
									proofs ??
									(startAudio.restoration?.legacyAddressOnly ? undefined : []),
							});
					},
				},
			},
			transaction,
		);
	} catch (error) {
		await transaction.rollback();
		throw error;
	}

	return { success: true };
}
