/*
 * Taking over a live sender after a backend restart (stream continuity,
 * slice 3). Only with the `stream_continuity_takeover` flag.
 *
 * All or nothing. The new backend adopts the sender its predecessor left
 * running only when every piece of the adoption evidence (`sender-adoption.ts`)
 * is positive in one sampled collection, no modem state is in flight, and the
 * commit finds nothing changed since. One negative or unknown answer and the
 * fallback runs: the sender's unit is stopped by NAME, and startup continues
 * exactly as it does without a surviving sender (the engine session stays
 * unconfirmed and protected until Stop).
 *
 * What is taken over: the process (a hosted handle holding the pidfd the
 * collection used), the control socket and stats readers (link telemetry
 * reattached to the recorded paths), the bind-map generation (continued above
 * the applied one), the session's listeners and reload verification, and the
 * in-process reference to the engine session (bound to the connection that
 * answered). Never touched: ModemManager and NetworkManager, routes, rules and
 * fences, the engine process, the IP list and sidecar, the records, the armed
 * marker, the configuration, and any process reached only by its number.
 * Nothing is written to disk, so a crash at any point leaves the next backend
 * the same evidence.
 */

import { readdir } from "node:fs/promises";
import type { LifecycleState } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import type { ProcessPin } from "../../helpers/process-pin.ts";
import { getConfig } from "../config.ts";
import { clearAdoptedSender, noteAdoptedSender } from "./adopted-sender.ts";
import type { ArmedStreamConfig } from "./armed-stream-marker.ts";
import { continuityObserverIo } from "./continuity-observer.ts";
import {
	type Lifetime,
	lifetimeSchema,
	readRecord,
} from "./continuity-records.ts";
import {
	collectSenderAdoptionEvidence,
	defaultSenderAdoptionIo,
	eligibleProcessState,
	observeSenderAdoption,
	type SenderAdoptionEvidence,
	type SenderAdoptionIo,
	sameArmedIntent,
	senderAdoptionVerdict,
} from "./sender-adoption.ts";
import { statFields } from "./sender-invocation.ts";
import type { StreamingProcess } from "./streamloop/process-runner.ts";
import {
	type HostedSender,
	hostedSenderHandle,
	isSenderUnit,
	type UnitStopOutcome,
} from "./streamloop/sender-host.ts";

export type TakeoverRefusal = {
	readonly check: string;
	readonly reason: string;
};

export type TakeoverOutcome =
	| { readonly result: "detect_only" }
	| { readonly result: "adopted"; readonly unit: string }
	| {
			readonly result: "fallback";
			readonly check: string;
			readonly reason: string;
			/** What happened to the recorded unit; `none` when there was none. */
			readonly stopped: UnitStopOutcome | "none";
	  };

export type TakeoverDeps = {
	readonly flagOn: () => boolean;
	readonly bootId: () => Promise<string>;
	readonly readLifetime: () => Promise<Lifetime | null>;
	/** A refusal when modem state is in flight or unreadable, else null. */
	readonly modemGates: () => Promise<TakeoverRefusal | null>;
	/** The operator stop intent, captured now; the closure says if still current. */
	readonly captureIntent: () => () => boolean;
	readonly sessionState: () => LifecycleState;
	readonly sessionGeneration: () => number;
	readonly adoptionIo: () => SenderAdoptionIo;
	readonly pin: (pid: number) => Promise<ProcessPin | null>;
	readonly readStat: (pid: number) => Promise<string | null>;
	readonly readMarker: SenderAdoptionIo["readMarker"];
	readonly captureConfig: () => ArmedStreamConfig;
	readonly adoptEngineSession: (
		sessionId: string,
		connection: number,
	) => boolean;
	readonly hostedHandle: (
		pid: number,
		startTime: string,
		unit: string,
		pin: ProcessPin,
	) => HostedSender;
	readonly register: (sender: HostedSender) => StreamingProcess;
	readonly continueGeneration: (applied: number) => void;
	readonly adoptLifetime: (lifetime: Lifetime) => void;
	readonly attachTelemetry: (
		lifetime: Lifetime,
		current: () => boolean,
	) => Promise<void>;
	readonly reconcile: () => Promise<LifecycleState>;
	readonly attachSession: (
		generation: number,
		evidence: SenderAdoptionEvidence,
		current: () => boolean,
	) => Promise<boolean>;
	readonly stopAdopted: (sender: StreamingProcess) => Promise<void>;
	readonly stopTelemetry: () => void;
	readonly stopUnit: (unit: string) => Promise<UnitStopOutcome>;
	readonly listUnits: () => Promise<string[] | null>;
	readonly detectOnly: () => Promise<unknown>;
};

function refusal(check: string, reason: string): TakeoverRefusal {
	return { check, reason };
}

/** A recorded unit this backend may act on: this boot, our prefix, hosted. */
function hostedUnitOf(
	lifetime: Lifetime | null,
	bootId: string,
): string | null {
	if (!lifetime || !bootId || lifetime.bootId !== bootId) return null;
	if (lifetime.host !== "systemd" || !lifetime.unit) return null;
	if ((lifetime.unitManager ?? "system") !== "system") return null;
	return isSenderUnit(lifetime.unit) ? lifetime.unit : null;
}

/**
 * Stop the recorded unit by name (and, with the flag, every other sender unit
 * except `keep`), then reconcile again. The order is fixed: no sender is left
 * that the next reconciliation could mistake for ours.
 */
async function fallback(
	deps: TakeoverDeps,
	unit: string | null,
	why: TakeoverRefusal,
): Promise<TakeoverOutcome> {
	let stopped: UnitStopOutcome | "none" = "none";
	if (unit) stopped = await deps.stopUnit(unit).catch(() => "failed" as const);
	const swept = deps.flagOn() ? await sweepUnits(deps, unit) : 0;
	if (unit)
		logger.warn("sender takeover refused; the sender unit is stopped", {
			check: why.check,
			reason: why.reason,
			stopped,
		});
	else
		logger.info("sender takeover: nothing to adopt", {
			check: why.check,
			reason: why.reason,
		});
	// Without a stopped sender nothing changed for reconciliation.
	if (unit || swept > 0) await deps.reconcile().catch(() => undefined);
	return { result: "fallback", ...why, stopped };
}

/** Stop every loaded sender unit other than `keep`; how many were asked. */
async function sweepUnits(
	deps: TakeoverDeps,
	keep: string | null,
): Promise<number> {
	const units = await deps.listUnits().catch(() => null);
	if (units === null) {
		logger.warn("sender takeover: sender units could not be listed");
		return 0;
	}
	let asked = 0;
	for (const other of units) {
		if (other === keep) continue;
		asked++;
		const outcome = await deps.stopUnit(other).catch(() => "failed" as const);
		logger.warn("sender takeover: stopped a sender unit with no record", {
			outcome,
		});
	}
	return asked;
}

/**
 * The startup takeover. With the flag off it runs the detect-only observer
 * as before, except that a record naming a hosted unit (left by a backend
 * that had the flag on) is stopped. Never throws.
 */
export async function takeOverSenderAtStartup(
	deps: TakeoverDeps = defaultTakeoverDeps(),
): Promise<TakeoverOutcome> {
	let unit: string | null = null;
	try {
		const bootId = await deps.bootId().catch(() => "");
		const lifetime = await deps.readLifetime().catch(() => null);
		unit = hostedUnitOf(lifetime, bootId);
		if (!deps.flagOn()) {
			if (unit) return await fallback(deps, unit, refusal("flag", "off"));
			void deps.detectOnly().catch(() => undefined);
			return { result: "detect_only" };
		}
		if (!lifetime || !unit)
			return await fallback(deps, null, refusal("host", "no_hosted_sender"));
		const modem = await deps
			.modemGates()
			.catch(() => refusal("modem", "unreadable"));
		if (modem) return await fallback(deps, unit, modem);
		return await adopt(deps, lifetime, unit);
	} catch {
		return await fallback(deps, unit, refusal("takeover", "failed")).catch(
			() => ({
				result: "fallback" as const,
				check: "takeover",
				reason: "failed",
				stopped: "failed" as const,
			}),
		);
	}
}

async function adopt(
	deps: TakeoverDeps,
	lifetime: Lifetime,
	unit: string,
): Promise<TakeoverOutcome> {
	const pid = lifetime.pid;
	if (pid === null || lifetime.startTime === null)
		return fallback(deps, unit, refusal("lifetime", "never_started"));
	const intent = deps.captureIntent();
	// One pin for the collection and the takeover: the process the evidence
	// describes is the process the handle signals.
	const pin = await deps.pin(pid).catch(() => null);
	if (!pin?.pidfd) {
		pin?.close();
		return fallback(deps, unit, refusal("process", "pin_unavailable"));
	}
	let kept = false;
	try {
		const io = deps.adoptionIo();
		const shared: ProcessPin = { ...pin, close: () => undefined };
		const evidence = await collectSenderAdoptionEvidence({
			...io,
			pin: async (asked) => (asked === pid ? shared : io.pin(asked)),
		});
		const verdict = senderAdoptionVerdict(evidence);
		if (verdict.decision !== "adopt")
			return await fallback(deps, unit, refusal(verdict.check, verdict.reason));
		const outcome = await commit(deps, lifetime, unit, pin, evidence, intent);
		kept = outcome.result === "adopted";
		return outcome;
	} finally {
		if (!kept) pin.close();
	}
}

/** The commit, in order; each step can still abort into the fallback. */
async function commit(
	deps: TakeoverDeps,
	lifetime: Lifetime,
	unit: string,
	pin: ProcessPin,
	evidence: SenderAdoptionEvidence,
	intent: () => boolean,
): Promise<TakeoverOutcome> {
	const pid = lifetime.pid as number;
	const startTime = lifetime.startTime as string;
	// 1. Operator intent, the session and the armed configuration unchanged.
	if (!intent() || deps.sessionState() !== "reconciling")
		return fallback(deps, unit, refusal("commit", "operator_intent"));
	if (!sameArmedIntent(evidence, deps.readMarker(), deps.captureConfig()))
		return fallback(deps, unit, refusal("commit", "config_changed"));
	// 2. The pinned process, still the recorded one and still eligible.
	const stat = await deps.readStat(pid).catch(() => null);
	const fields = stat === null ? [] : statFields(stat);
	if (
		pin.alive() !== true ||
		fields[19] !== startTime ||
		!eligibleProcessState(fields[0] ?? null)
	)
		return fallback(deps, unit, refusal("commit", "sender_changed"));
	// 3. The engine session, on the connection that answered.
	const session = evidence.engineSession;
	const connection = evidence.engineConnection;
	if (
		!session ||
		connection === null ||
		connection === undefined ||
		!deps.adoptEngineSession(session.sessionId, connection)
	)
		return fallback(deps, unit, refusal("commit", "engine_changed"));
	// 4. The sender, supervised through the pin.
	const sender = deps.register(deps.hostedHandle(pid, startTime, unit, pin));
	noteAdoptedSender(sender);
	const live = () =>
		sender.proc.exitCode === null && sender.proc.signalCode === null;
	// 5. Publications continue above what the sender applied.
	if (evidence.appliedMap)
		deps.continueGeneration(evidence.appliedMap.generation);
	// 6. Telemetry and observations, from the recorded paths.
	deps.adoptLifetime(lifetime);
	await deps.attachTelemetry(lifetime, live).catch(() => undefined);
	// 7. One reconciliation: `streaming` only with this handle and this session.
	const state = await deps.reconcile().catch(() => "unknown" as const);
	if (state !== "streaming" || !live()) {
		clearAdoptedSender(sender);
		deps.stopTelemetry();
		await deps.stopAdopted(sender).catch(() => undefined);
		return fallback(deps, unit, refusal("commit", `reconciled_${state}`));
	}
	// 8. The session's listeners and reload verification.
	const generation = deps.sessionGeneration();
	const attached = await deps
		.attachSession(generation, evidence, live)
		.catch(() => false);
	if (!attached)
		logger.warn("sender takeover: session listeners not attached", {
			unit,
		});
	if (deps.flagOn()) await sweepUnits(deps, unit);
	logger.info("sender takeover: adopted the running sender", { unit });
	return { result: "adopted", unit };
}

/** Modem state that must be quiet before a takeover: in flight or unknown refuses. */
export async function defaultModemGates(
	given?: {
		readonly internalCallLeases: string;
		readonly nativeHosts: string;
	},
	listJournal: () => Promise<readonly unknown[]> = async () =>
		(await import("../modems/mutation-journal.ts")).listMutationEntries(
			undefined,
			true,
		),
): Promise<TakeoverRefusal | null> {
	const dirs = given ?? {
		internalCallLeases: (
			await import("../modems/internal-call-recovery.ts")
		).internalCallLeaseStore().dir,
		nativeHosts:
			process.env.CERALIVE_CELLULAR_HOST_STATE_DIR ??
			"/data/ceralive/cellular-host",
	};
	let journal: readonly unknown[];
	try {
		journal = await listJournal();
	} catch {
		return refusal("modem", "journal_unreadable");
	}
	if (journal.length > 0) return refusal("modem", "mutation_in_flight");
	const leases = await entriesOf(dirs.internalCallLeases);
	if (leases === null) return refusal("modem", "lease_unreadable");
	if (leases > 0) return refusal("modem", "internal_call_lease");
	const hosts = await entriesOf(dirs.nativeHosts);
	if (hosts === null) return refusal("modem", "host_record_unreadable");
	if (hosts > 0) return refusal("modem", "native_host_unverified");
	return null;
}

/** Entries in a directory; 0 when it does not exist, null when unreadable. */
async function entriesOf(dir: string): Promise<number | null> {
	try {
		return (await readdir(dir)).length;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
	}
}

export function takeoverFlagOn(): boolean {
	return getConfig().stream_continuity_takeover === true;
}

export function defaultTakeoverDeps(): TakeoverDeps {
	let io: SenderAdoptionIo | undefined;
	let captureConfig: () => ArmedStreamConfig = () => ({});
	const adoptionIo = () => {
		io ??= defaultSenderAdoptionIo(() => captureConfig());
		return io;
	};
	const lazy = async () => {
		const [
			restoration,
			orchestrator,
			engine,
			runner,
			host,
			writer,
			observer,
			telemetry,
			session,
			intent,
			streaming,
			exec,
			pinning,
			launch,
		] = await Promise.all([
			import("./stream-restoration.ts"),
			import("./stream-session-orchestrator.ts"),
			import("./streaming-engine.ts"),
			import("./streamloop/process-runner.ts"),
			import("./streamloop/sender-host.ts"),
			import("./bind-map-writer.ts"),
			import("./continuity-observer.ts"),
			import("./link-telemetry.ts"),
			import("./streamloop/session.ts"),
			import("./operator-stop-intent.ts"),
			import("./streaming.ts"),
			import("./streamloop/exec-paths.ts"),
			import("../../helpers/process-pin.ts"),
			import("./streamloop/start-stream.ts"),
		]);
		captureConfig = restoration.captureArmedStreamConfig;
		return {
			restoration,
			orchestrator,
			engine,
			runner,
			host,
			writer,
			observer,
			telemetry,
			session,
			intent,
			streaming,
			exec,
			pinning,
			launch,
		};
	};
	let modules: Awaited<ReturnType<typeof lazy>> | undefined;
	const m = () => {
		if (!modules) throw new Error("takeover modules not loaded");
		return modules;
	};
	return {
		flagOn: takeoverFlagOn,
		bootId: () => continuityObserverIo.bootId(),
		readLifetime: () =>
			readRecord(
				`${continuityObserverIo.directory}/lifetime.json`,
				lifetimeSchema,
			),
		modemGates: async () => {
			// Only a flagged takeover gets this far: load what it needs.
			modules ??= await lazy();
			return defaultModemGates();
		},
		captureIntent: () => m().intent.captureOperatorStopIntent(),
		sessionState: () => m().orchestrator.getStreamSessionSnapshot().state,
		sessionGeneration: () =>
			m().orchestrator.getStreamSessionSnapshot().generation,
		adoptionIo,
		pin: (pid) => m().pinning.pinProcess(pid),
		readStat: async (pid) => {
			try {
				return await Bun.file(`/proc/${pid}/stat`).text();
			} catch {
				return null;
			}
		},
		readMarker: () => adoptionIo().readMarker(),
		captureConfig: () => captureConfig(),
		adoptEngineSession: (sessionId, connection) =>
			m()
				.engine.getStreamingBackend()
				.adoptLaunchedSession?.(sessionId, connection) === true,
		hostedHandle: (pid, startTime, unit, pin) =>
			hostedSenderHandle(pid, startTime, unit, pin),
		register: (sender) =>
			m().runner.registerHostedSender(
				sender,
				m().exec.srtlaSendExec,
				m().launch.notifySenderError,
				m().host.followSenderOutput(sender.unit, "now"),
			),
		continueGeneration: (applied) =>
			m().writer.continueBindMapGenerationAbove(applied),
		adoptLifetime: (lifetime) => m().observer.adoptContinuityLifetime(lifetime),
		attachTelemetry: async (lifetime, current) => {
			const ips = await Bun.file(lifetime.ipsFile).text();
			if (!current()) return;
			m().telemetry.startLinkTelemetry(lifetime.statsFile, ips.split("\n"), {
				controlSocket: lifetime.controlSocket,
			});
		},
		reconcile: () => m().orchestrator.reconcileStreamSession(),
		attachSession: async (generation, evidence, current) => {
			if (!evidence.marker) return false;
			const resolved = await m().streaming.validateConfig({
				...evidence.marker.config,
			});
			if (!current()) return false;
			return m().session.attachAdoptedSession(
				generation,
				resolved.srtlaAddr,
				current,
			);
		},
		stopAdopted: async (sender) => {
			await m().runner.stopProcessAndWait(sender);
			if (sender.hosted)
				await m()
					.host.stopSenderUnit(sender.hosted.unit)
					.catch(() => undefined);
		},
		stopTelemetry: () => m().telemetry.stopLinkTelemetry(),
		stopUnit: async (unit) => {
			modules ??= await lazy();
			return m().host.stopSenderUnit(unit);
		},
		listUnits: async () => {
			modules ??= await lazy();
			return m().host.listSenderUnits();
		},
		detectOnly: () => observeSenderAdoption(),
	};
}
