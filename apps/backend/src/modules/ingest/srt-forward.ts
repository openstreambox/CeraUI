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
import { setForwardActive } from "../streaming/forward-activity.ts";
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
	spawnForwardLoop,
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

/** A failed attempt must clean up before rejecting. Only the backend owns this
 * listener; restarting it never restarts the encoder or backend service. */
export function superviseForwardListener(deps: {
	report(state: boolean | null): void;
	attempt(signal: AbortSignal): Promise<void>;
	schedule?: typeof setTimeout;
}) {
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = Promise.resolve();
	let failures = 0;
	const run = async () => {
		try {
			await deps.attempt(abort.signal);
		} catch {
			logger.warn("SRT forwarding listener retrying");
		}
		if (abort.signal.aborted) return;
		deps.report(false);
		const delay = Math.min(8000, 250 * 2 ** Math.min(failures++, 5));
		timer = (deps.schedule ?? setTimeout)(() => {
			running = run();
		}, delay);
	};
	running = run();
	return {
		ready: running,
		stop: async () => {
			abort.abort();
			clearTimeout(timer);
			await running;
			deps.report(false);
		},
	};
}

/** No engine calls. Only a caller on the explicitly configured LAN address. */
export async function initSrtForward(): Promise<void> {
	if (!setup.srt_forward || stop) return;
	const report = (state: boolean | null) =>
		carryingTracker.session("srt-forward", state, performance.now());
	report(false);
	const supervisor = superviseForwardListener({
		report,
		attempt: runForwardAttempt,
	});
	stop = async () => {
		await supervisor.stop();
		stop = undefined;
	};
	// Boot does not wait for a phone, relay DNS, or a retry timer.
}

const runtime = {
	getConfig,
	getRelays,
	resolveSrtla,
	prepareSrtlaIpAddresses,
	resolveBindMapArgs,
	spawnForwardLoop,
	onNetworkInterfacesChange,
	startLinkTelemetry,
	stopLinkTelemetry,
	superviseWorker,
	awaitRecoveryBarrier,
	isUpdating,
	getIsStreaming,
	getStreamLifecycleState,
	admitAndPrepareStreamStart,
	isRecoveryPending,
	readIps: () => Bun.file(setup.ips_file ?? "").text(),
};

export async function runForwardAttempt(
	signal: AbortSignal,
	deps = runtime,
): Promise<void> {
	const input = setup.srt_forward;
	if (!input || signal.aborted) return;
	const report = (state: boolean | null) =>
		carryingTracker.session("srt-forward", state, performance.now());
	if (input.port === FORWARD_PORT || input.port === SRTLA_LISTEN_PORT)
		throw Error("srt_forward_port_collision");
	// Re-read receiver selection and DNS on every listener/session attempt.
	const selection = () => {
		const c = deps.getConfig();
		return JSON.stringify([
			c.relay_protocol,
			c.relay_server,
			c.relay_account,
			c.srtla_addr,
			c.srtla_port,
			c.srt_streamid,
			c.relay_streamid_override,
			c.srt_latency,
			deps.getRelays(),
		]);
	};
	const selected = selection();
	const config = deps.getConfig();
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
		deps.getRelays(),
	);
	let address = "";
	let transmitter: SupervisedHandle | undefined;
	let stopping = false;
	let restarting = false;
	let rejectAttempt!: () => void;
	const ended = new Promise<void>((resolve) => {
		rejectAttempt = resolve;
	});
	let admissionRelease: (() => void) | undefined;
	const releaseForwardAdmission = () => {
		admissionRelease?.();
		admissionRelease = undefined;
	};
	let relayAccepted = false;
	let publisherAccepted = false;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	const reset = () => {
		if (!stopping) {
			restarting = true;
			rejectAttempt();
		}
	};
	const onAbort = () => rejectAttempt();
	signal.addEventListener("abort", onAbort, { once: true });
	const controller = createSrtForwardController({
		report: (state) => {
			if (state === true) {
				if (restarting || stopping) return;
				publisherAccepted = true;
				if (!relayAccepted) return;
			}
			report(state);
		},
		admit: async () => {
			await deps.awaitRecoveryBarrier();
			if (selection() !== selected) throw Error("receiver_changed");
			if (
				deps.isUpdating() ||
				deps.getIsStreaming() ||
				deps.getStreamLifecycleState() !== "idle"
			)
				throw Error("stream_or_update_busy");
			const admission = tryAcquireLifecycle("streaming");
			if (!admission.admitted) throw Error(admission.refusal);
			try {
				const update = await deps.admitAndPrepareStreamStart();
				if (!update.allowed || deps.isRecoveryPending())
					throw Error("update_or_recovery_busy");
				setForwardActive(true);
				admissionRelease = () => admission.lease.release();
				return () => {
					setForwardActive(false);
					releaseForwardAdmission();
				};
			} catch (error) {
				admission.lease.release();
				throw error;
			}
		},
		start: async () => {
			address = await deps.resolveSrtla(endpoint.srtlaAddr);
			await deps.prepareSrtlaIpAddresses(address);
			const bind = await deps.resolveBindMapArgs(
				srtlaSendExec,
				defaultBindMapSpawnDeps(getLastPublishedBond),
			);
			const stats = srtlaStatsFile(FORWARD_PORT);
			const socket = controlSocketPath(FORWARD_PORT);
			const ips = await deps.readIps();
			const sender = deps.spawnForwardLoop(
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
			const remove = deps.onNetworkInterfacesChange(() => {
				refresh = refresh.then(async () => {
					if (retired) return;
					try {
						const publication = await deps.prepareSrtlaIpAddresses(address);
						if (
							!retired &&
							publication.changed &&
							sender.proc.exitCode === null &&
							sender.proc.signalCode === null
						)
							sender.proc.kill("SIGHUP");
					} catch {
						if (!retired) reset();
					}
				});
				return refresh;
			});
			sender.exitListeners.push(() => {
				if (!retired) reset();
			});
			try {
				deps.startLinkTelemetry(stats, ips.split("\n"), {
					controlSocket: socket,
				});
				await Bun.sleep(0);
				if (sender.proc.exitCode !== null) throw Error("sender_start_failed");
			} catch (error) {
				retired = true;
				remove();
				await refresh;
				deps.stopLinkTelemetry(true);
				await stopProcessAndWait(sender);
				throw error;
			}
			return {
				stop: async () => {
					retired = true;
					remove();
					await refresh;
					deps.stopLinkTelemetry(true);
					await stopProcessAndWait(sender);
				},
			};
		},
	});

	try {
		const urls = forwardUrls(input, {
			port: FORWARD_PORT,
			streamid: endpoint.streamid,
			latency: config.srt_latency ?? 2000,
			maxbw: input.maxbw,
			...(input.relay_passphrase ? { passphrase: input.relay_passphrase } : {}),
		});
		// Give the supervisor a redacted identity too: readiness/shutdown errors
		// include its argv. Only the spawn closure receives the private URLs.
		const argv = ["srt-live-transmit", urls.input, urls.output];
		transmitter = deps.superviseWorker(
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
					if (stopping || restarting) continue;
					if (line.includes("Accepted SRT source connection")) {
						if (connectTimer) continue;
						connectTimer = setTimeout(reset, 10000);
						void controller.publisher(true).catch(() => {
							reset();
						});
					} else if (line.includes("SRT target connected")) {
						relayAccepted = true;
						clearTimeout(connectTimer);
						// The target is end-to-end SRT through the bonded sender.
						releaseForwardAdmission();
						if (publisherAccepted) report(true);
					} else if (
						line.includes("SRT source disconnected") ||
						line.includes("SRT target disconnected")
					) {
						reset();
					}
				}
				if (pending.length > 65536) {
					pending = "";
					reset();
				}
			}
			if (!stopping) {
				reset();
			}
		})().catch(() => {
			if (!stopping) {
				reset();
			}
		});
		void transmitter.proc.exited.then(() => {
			if (!stopping) reset();
		});
		await transmitter.ready;
		// Preserve acceptance evidence arriving before readiness.
		controller.listening();
		if (!signal.aborted) await ended;
	} finally {
		stopping = true;
		clearTimeout(connectTimer);
		signal.removeEventListener("abort", onAbort);
		await transmitter?.shutdown();
		await controller.stop();
	}
}

export async function stopSrtForward(): Promise<void> {
	await stop?.();
}
