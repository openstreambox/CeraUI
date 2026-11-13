import {
	buildSrtlaSendArgs,
	controlSocketPath,
} from "@ceraui/srtla-send/sender";
import { logger } from "../../helpers/logger.ts";
import {
	type SupervisedHandle,
	superviseWorker,
} from "../../helpers/spawn-policy.ts";
import { getConfig } from "../config.ts";
import { onNetworkInterfacesChange } from "../network/network-interfaces.ts";
import { getRelays } from "../remote/remote-relays.ts";
import { setup } from "../setup.ts";
import {
	defaultBindMapSpawnDeps,
	resolveBindMapArgs,
} from "../streaming/bind-map-spawn.ts";
import { SRTLA_LISTEN_PORT } from "../streaming/constants.ts";
import { tryAcquireLifecycle } from "../streaming/lifecycle-admission.ts";
import {
	srtlaStatsFile,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../streaming/link-telemetry.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../streaming/recovery-barrier.ts";
import { getLastPublishedBond, resolveSrtla } from "../streaming/srtla.ts";
import { getStreamLifecycleState } from "../streaming/stream-lifecycle-status.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { srtlaSendExec } from "../streaming/streamloop/exec-paths.ts";
import {
	spawnStreamingLoop,
	stopProcessAndWait,
} from "../streaming/streamloop/process-runner.ts";
import { prepareSrtlaIpAddresses } from "../streaming/streamloop/srtla-ip-preparation.ts";
import { resolveStreamEndpoint } from "../streaming/transport/resolve-endpoint.ts";
import { carryingTracker } from "../system/carrying.ts";
import { isUpdating } from "../system/software-updates.ts";
import { admitAndPrepareStreamStart } from "../system/update-orchestrator/runtime.ts";
import {
	createSrtForwardController,
	forwardSenderPort,
	forwardUrls,
} from "./srt-forward-core.ts";

// An unadmitted phone must never feed the encoder sender socket.
const FORWARD_PORT = forwardSenderPort(SRTLA_LISTEN_PORT);
let stop: (() => Promise<void>) | undefined;

/** No engine calls. Only a phone caller on the explicitly configured LAN address. */
export async function initSrtForward(): Promise<void> {
	const input = setup.srt_forward;
	if (!input || stop) return;
	const report = (state: boolean | null) =>
		carryingTracker.session("srt-forward", state, performance.now());
	// Register before reading receiver configuration or starting any process.
	report(null);
	if (input.port === FORWARD_PORT || input.port === SRTLA_LISTEN_PORT)
		throw Error("srt_forward_port_collision");
	const config = getConfig();
	if (config.relay_protocol && config.relay_protocol !== "srtla")
		throw Error("srt_forward_requires_srtla");
	const endpoint = resolveStreamEndpoint(
		{
			...(config.relay_server !== undefined
				? { relay_server: config.relay_server }
				: {}),
			...(config.relay_account !== undefined
				? { relay_account: config.relay_account }
				: {}),
			...(config.srtla_addr !== undefined
				? { srtla_addr: config.srtla_addr }
				: {}),
			...(config.srtla_port !== undefined
				? { srtla_port: config.srtla_port }
				: {}),
			...(config.srt_streamid !== undefined
				? { srt_streamid: config.srt_streamid }
				: {}),
			...(config.relay_streamid_override !== undefined
				? { relay_streamid_override: config.relay_streamid_override }
				: {}),
		},
		getRelays(),
	);
	const address = await resolveSrtla(endpoint.srtlaAddr);
	let transmitter: SupervisedHandle | undefined;
	let stopping = false;
	const controller = createSrtForwardController({
		report,
		admit: async () => {
			await awaitRecoveryBarrier();
			if (
				isUpdating() ||
				getIsStreaming() ||
				getStreamLifecycleState() !== "idle"
			)
				throw Error("stream_or_update_busy");
			const admission = tryAcquireLifecycle("streaming");
			if (!admission.admitted) throw Error(admission.refusal);
			try {
				const update = await admitAndPrepareStreamStart();
				if (!update.allowed || isRecoveryPending())
					throw Error("update_or_recovery_busy");
				// Hold through forwarding: both paths share bond and telemetry ownership.
				return () => admission.lease.release();
			} catch (error) {
				admission.lease.release();
				throw error;
			}
		},
		start: async () => {
			await prepareSrtlaIpAddresses(address);
			const bind = await resolveBindMapArgs(
				srtlaSendExec,
				defaultBindMapSpawnDeps(getLastPublishedBond),
			);
			const stats = srtlaStatsFile();
			const socket = controlSocketPath(FORWARD_PORT);
			const ips = await Bun.file(setup.ips_file ?? "").text();
			const sender = spawnStreamingLoop(
				srtlaSendExec,
				[
					...buildSrtlaSendArgs({
						listenPort: FORWARD_PORT,
						srtlaHost: address,
						srtlaPort: endpoint.srtlaPort,
						ipsFile: setup.ips_file,
						statsFile: stats,
						controlSocket: socket,
						execPath: setup.srtla_path,
					}),
					...bind,
				],
				() => {
					/* Raw stderr may contain credentials; lifecycle observes process exit. */
				},
			);
			let retired = false;
			let refresh = Promise.resolve();
			const remove = onNetworkInterfacesChange(() => {
				refresh = refresh.then(async () => {
					if (retired) return;
					try {
						const publication = await prepareSrtlaIpAddresses(address);
						if (
							!retired &&
							publication.changed &&
							sender.proc.exitCode === null
						)
							sender.proc.kill("SIGHUP");
					} catch {
						if (!retired) void controller.fault();
					}
				});
				return refresh;
			});
			sender.exitListeners.push(() => {
				if (!retired) void controller.fault();
			});
			try {
				startLinkTelemetry(stats, ips.split("\n"), { controlSocket: socket });
				await Bun.sleep(0);
				if (sender.proc.exitCode !== null) throw Error("sender_start_failed");
			} catch (error) {
				retired = true;
				remove();
				await refresh;
				stopLinkTelemetry();
				await stopProcessAndWait(sender);
				throw error;
			}
			return {
				stop: async () => {
					retired = true;
					remove();
					await refresh;
					stopLinkTelemetry();
					await stopProcessAndWait(sender);
				},
			};
		},
	});
	stop = async () => {
		stopping = true;
		await controller.stop();
		await transmitter?.shutdown();
		stop = undefined;
	};
	try {
		const urls = forwardUrls(input, {
			port: FORWARD_PORT,
			streamid: endpoint.streamid,
			latency: config.srt_latency ?? 2000,
			...(input.relay_passphrase ? { passphrase: input.relay_passphrase } : {}),
		});
		// Give the supervisor a redacted identity too: readiness/shutdown errors
		// include its argv. Only the spawn closure receives the private URLs.
		const argv = ["srt-live-transmit", urls.input, urls.output];
		transmitter = superviseWorker(
			["srt-live-transmit", "[private endpoints]"],
			{
				waitForReady: async (proc) => {
					await Bun.sleep(100);
					if (proc.exitCode !== null || proc.signalCode !== null)
						throw Error("listener_start_failed");
				},
				spawn: () =>
					Bun.spawn(argv, {
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					}),
			},
		);
		void new Response(transmitter.proc.stdout).text();
		const stderr = transmitter.proc.stderr;
		if (!stderr) throw Error("forward_status_unreadable");
		void (async () => {
			const decoder = new TextDecoder();
			let pending = "";
			for await (const chunk of stderr) {
				pending += decoder.decode(chunk, { stream: true });
				while (pending.includes("\n")) {
					const end = pending.indexOf("\n");
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (stopping) continue;
					if (line.includes("Accepted SRT source connection")) {
						void controller.publisher(true).catch(() => {
							logger.warn("SRT forwarding admission or sender failed");
						});
					} else if (line.includes("SRT source disconnected")) {
						void controller.publisher(false);
					}
				}
				if (pending.length > 65536) {
					pending = "";
					await controller.fault();
				}
			}
			if (!stopping) {
				await controller.fault();
			}
		})().catch(() => {
			if (!stopping) {
				void controller.fault();
			}
		});
		void transmitter.proc.exited.then(() => {
			if (!stopping) void controller.fault();
		});
		await transmitter.ready;
		// Preserve acceptance evidence arriving before readiness.
		controller.listening();
	} catch {
		await controller.fault();
		await transmitter?.shutdown();
		throw Error("srt_forward_start_failed");
	}
}

export async function stopSrtForward(): Promise<void> {
	await stop?.();
}
