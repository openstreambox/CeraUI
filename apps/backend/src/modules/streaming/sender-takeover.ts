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
	/** The recorded IP list's contents, for telemetry; throws when unreadable. */
	readonly readIps: (lifetime: Lifetime) => Promise<string>;
	/** The receiver address of the armed configuration; throws when invalid. */
	readonly resolveSrtlaAddr: (
		evidence: SenderAdoptionEvidence,
	) => Promise<string>;
	readonly adoptEngineSession: (
		sessionId: string,
		connection: number,
	) => boolean;
	readonly releaseEngineSession: (sessionId: string) => void;
	readonly hostedHandle: (
		pid: number,
		startTime: string,
		unit: string,
		pin: ProcessPin,
		invocation: string | null,
	) => HostedSender;
	readonly register: (sender: HostedSender) => StreamingProcess;
	/** Drop a registered hosted sender without signalling it (rollback). */
	readonly forgetSender: (sender: StreamingProcess) => void;
	/** True only when the sender's pidfd says alive right now. */
	readonly senderAlive: (sender: StreamingProcess) => boolean;
	readonly continueGeneration: (applied: number) => void;
	readonly adoptLifetime: (lifetime: Lifetime) => void;
	/** Throws when telemetry cannot attach. */
	readonly attachTelemetry: (lifetime: Lifetime, ips: string) => void;
	readonly reconcile: () => Promise<LifecycleState>;
	readonly attachSession: (
		generation: number,
		srtlaAddr: string,
		current: () => boolean,
	) => boolean;
	readonly detachSession: (generation: number) => void;
	readonly stopTelemetry: () => void;
	/**
	 * Stop a sender unit by name. With `invocation`, only that start of it:
	 * a unit that is not ours, or another invocation, is left alone.
	 */
	readonly stopUnit: (
		unit: string,
		invocation?: string | null,
	) => Promise<UnitStopOutcome>;
	readonly listUnits: () => Promise<string[] | null>;
	/** The detect-only observer, given the boot id and record already read. */
	readonly detectOnly: (
		bootId: string,
		lifetime: Lifetime | null,
	) => Promise<unknown>;
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

/** Systemd confirmed the unit is not running. Anything else is doubt. */
function confirmedGone(outcome: UnitStopOutcome | "none"): boolean {
	return outcome === "stopped" || outcome === "absent" || outcome === "none";
}

/**
 * Stop the recorded unit by name (and, with the flag, every other sender unit
 * except `keep`), and only once systemd confirms them gone, reconcile again.
 * Stop, see it gone, then reconcile: an unconfirmed stop leaves the session
 * as the startup reconciliation left it, protected.
 */
async function fallback(
	deps: TakeoverDeps,
	unit: string | null,
	why: TakeoverRefusal,
	invocation: string | null = null,
): Promise<TakeoverOutcome> {
	let stopped: UnitStopOutcome | "none" = "none";
	if (unit)
		stopped = await deps
			.stopUnit(unit, invocation)
			.catch(() => "failed" as const);
	const sweep = deps.flagOn()
		? await sweepUnits(deps, unit)
		: { asked: 0, confirmed: true };
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
	const changed = unit !== null || sweep.asked > 0;
	if (changed && confirmedGone(stopped) && sweep.confirmed)
		await deps.reconcile().catch(() => undefined);
	else if (changed)
		logger.warn("sender takeover: a sender unit is not confirmed stopped");
	return { result: "fallback", ...why, stopped };
}

/** Stop every loaded sender unit other than `keep`. */
async function sweepUnits(
	deps: TakeoverDeps,
	keep: string | null,
): Promise<{ asked: number; confirmed: boolean }> {
	const units = await deps.listUnits().catch(() => null);
	if (units === null) {
		logger.warn("sender takeover: sender units could not be listed");
		return { asked: 0, confirmed: true };
	}
	let asked = 0;
	let confirmed = true;
	for (const other of units) {
		if (other === keep) continue;
		asked++;
		const outcome = await deps.stopUnit(other).catch(() => "failed" as const);
		if (!confirmedGone(outcome) && outcome !== "not_ours") confirmed = false;
		logger.warn("sender takeover: stopped a sender unit with no record", {
			outcome,
		});
	}
	return { asked, confirmed };
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
	let invocation: string | null = null;
	try {
		const bootId = await deps.bootId().catch(() => "");
		const lifetime = await deps.readLifetime().catch(() => null);
		unit = hostedUnitOf(lifetime, bootId);
		invocation = unit ? (lifetime?.invocation ?? null) : null;
		if (!deps.flagOn()) {
			if (unit)
				return await fallback(deps, unit, refusal("flag", "off"), invocation);
			void deps.detectOnly(bootId, lifetime).catch(() => undefined);
			return { result: "detect_only" };
		}
		if (!lifetime || !unit)
			return await fallback(deps, null, refusal("host", "no_hosted_sender"));
		const modem = await deps
			.modemGates()
			.catch(() => refusal("modem", "unreadable"));
		if (modem) return await fallback(deps, unit, modem, invocation);
		return await adopt(deps, lifetime, unit);
	} catch {
		return await fallback(
			deps,
			unit,
			refusal("takeover", "failed"),
			invocation,
		).catch(() => ({
			result: "fallback" as const,
			check: "takeover",
			reason: "failed",
			stopped: "failed" as const,
		}));
	}
}

async function adopt(
	deps: TakeoverDeps,
	lifetime: Lifetime,
	unit: string,
): Promise<TakeoverOutcome> {
	const pid = lifetime.pid;
	const back = (why: TakeoverRefusal) =>
		fallback(deps, unit, why, lifetime.invocation ?? null);
	if (pid === null || lifetime.startTime === null)
		return back(refusal("lifetime", "never_started"));
	const intent = deps.captureIntent();
	// One pin for the collection and the takeover: the process the evidence
	// describes is the process the handle signals.
	const pin = await deps.pin(pid).catch(() => null);
	if (!pin?.pidfd) {
		pin?.close();
		return back(refusal("process", "pin_unavailable"));
	}
	let kept = false;
	try {
		const io = deps.adoptionIo();
		const shared: ProcessPin = { ...pin, close: () => undefined };
		// The collector judges this very record, never a fresh read of it.
		const evidence = await collectSenderAdoptionEvidence({
			...io,
			readLifetime: async () => lifetime,
			pin: async (asked) => (asked === pid ? shared : io.pin(asked)),
		});
		const verdict = senderAdoptionVerdict(evidence);
		if (verdict.decision !== "adopt")
			return await back(refusal(verdict.check, verdict.reason));
		const outcome = await commit(deps, lifetime, unit, pin, evidence, intent);
		kept = outcome.result === "adopted";
		return outcome;
	} finally {
		if (!kept) pin.close();
	}
}

/** A commit step that failed, with the reason the fallback reports. */
class CommitRefused extends Error {
	constructor(readonly refusal: TakeoverRefusal) {
		super(refusal.reason);
	}
}

/**
 * Everything that can change under a commit, read again: modem state, the
 * record, the pinned process, then (sampled last, after the slow reads)
 * operator intent, the session state and the armed configuration.
 */
async function validate(
	deps: TakeoverDeps,
	lifetime: Lifetime,
	pin: ProcessPin,
	evidence: SenderAdoptionEvidence,
	intent: () => boolean,
): Promise<TakeoverRefusal | null> {
	const modem = await deps
		.modemGates()
		.catch(() => refusal("modem", "unreadable"));
	if (modem) return modem;
	const record = await deps.readLifetime().catch(() => null);
	if (!record || canonicalRecord(record) !== canonicalRecord(lifetime))
		return refusal("commit", "record_changed");
	const stat = await deps.readStat(lifetime.pid as number).catch(() => null);
	const fields = stat === null ? [] : statFields(stat);
	if (
		pin.alive() !== true ||
		fields[19] !== lifetime.startTime ||
		!eligibleProcessState(fields[0] ?? null)
	)
		return refusal("commit", "sender_changed");
	if (!intent() || deps.sessionState() !== "reconciling")
		return refusal("commit", "operator_intent");
	if (!sameArmedIntent(evidence, deps.readMarker(), deps.captureConfig()))
		return refusal("commit", "config_changed");
	return null;
}

function canonicalRecord(record: Lifetime): string {
	return JSON.stringify(
		Object.keys(record)
			.sort()
			.map((key) => [key, (record as Record<string, unknown>)[key]]),
	);
}

/**
 * The commit, as a transaction. First everything that can fail is prepared
 * with no side effect; then each step registers its undo; any failure undoes
 * every step done, in reverse, and falls back. The adopted marker and the
 * one reconciliation (the only step that marks the session streaming) come
 * last, right after a final validation. The lifetime is adopted (which lets
 * telemetry write its report) only once reconciliation committed streaming.
 */
async function commit(
	deps: TakeoverDeps,
	lifetime: Lifetime,
	unit: string,
	pin: ProcessPin,
	evidence: SenderAdoptionEvidence,
	intent: () => boolean,
): Promise<TakeoverOutcome> {
	const back = (why: TakeoverRefusal) =>
		fallback(deps, unit, why, lifetime.invocation ?? null);
	const pid = lifetime.pid as number;
	const startTime = lifetime.startTime as string;
	// Prepare: no side effects.
	let ips: string;
	try {
		ips = await deps.readIps(lifetime);
	} catch {
		return back(refusal("commit", "ips_unreadable"));
	}
	let srtlaAddr: string;
	try {
		srtlaAddr = await deps.resolveSrtlaAddr(evidence);
	} catch {
		return back(refusal("commit", "config_invalid"));
	}
	const session = evidence.engineSession;
	const connection = evidence.engineConnection;
	if (!session || connection === null || connection === undefined)
		return back(refusal("commit", "engine_changed"));
	const prepared = await validate(deps, lifetime, pin, evidence, intent);
	if (prepared) return back(prepared);

	// Apply: each step undone if a later one fails.
	const undo: (() => void)[] = [];
	let committed = false;
	try {
		if (!deps.adoptEngineSession(session.sessionId, connection))
			throw new CommitRefused(refusal("commit", "engine_changed"));
		undo.push(() => deps.releaseEngineSession(session.sessionId));
		const sender = deps.register(
			deps.hostedHandle(pid, startTime, unit, pin, lifetime.invocation ?? null),
		);
		undo.push(() => deps.forgetSender(sender));
		deps.attachTelemetry(lifetime, ips);
		undo.push(() => deps.stopTelemetry());
		const generation = deps.sessionGeneration();
		// The listeners act only once the adoption is committed.
		const current = () => committed && deps.senderAlive(sender);
		if (!deps.attachSession(generation, srtlaAddr, current))
			throw new CommitRefused(refusal("commit", "listeners_unattached"));
		undo.push(() => deps.detachSession(generation));

		// Final validation, then the marker and the reconciliation.
		const last = await validate(deps, lifetime, pin, evidence, intent);
		if (last) throw new CommitRefused(last);
		if (!deps.senderAlive(sender))
			throw new CommitRefused(refusal("commit", "sender_changed"));
		if (evidence.appliedMap)
			deps.continueGeneration(evidence.appliedMap.generation);
		noteAdoptedSender(sender);
		undo.push(() => clearAdoptedSender(sender));
		const state = await deps.reconcile().catch(() => "unknown" as const);
		if (state !== "streaming")
			throw new CommitRefused(refusal("commit", `reconciled_${state}`));
		committed = true;
	} catch (error) {
		for (const step of undo.reverse()) {
			try {
				step();
			} catch {
				// Every remaining undo still runs.
			}
		}
		return back(
			error instanceof CommitRefused
				? error.refusal
				: refusal("commit", "failed"),
		);
	}
	deps.adoptLifetime(lifetime);
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
		readIps: (lifetime) => Bun.file(lifetime.ipsFile).text(),
		resolveSrtlaAddr: async (evidence) => {
			if (!evidence.marker) throw new Error("no armed configuration");
			const resolved = await m().streaming.validateConfig({
				...evidence.marker.config,
			});
			return resolved.srtlaAddr;
		},
		adoptEngineSession: (sessionId, connection) =>
			m()
				.engine.getStreamingBackend()
				.adoptLaunchedSession?.(sessionId, connection) === true,
		releaseEngineSession: (sessionId) =>
			m().engine.getStreamingBackend().releaseAdoptedSession?.(sessionId),
		hostedHandle: (pid, startTime, unit, pin, invocation) =>
			hostedSenderHandle(pid, startTime, unit, pin, { invocation }),
		register: (sender) =>
			m().runner.registerHostedSender(
				sender,
				m().exec.srtlaSendExec,
				m().launch.notifySenderError,
				m().host.followSenderOutput(sender.unit, "now"),
			),
		forgetSender: (sender) => m().runner.forgetHostedSender(sender),
		senderAlive: (sender) =>
			sender.hosted !== undefined &&
			sender.proc.exitCode === null &&
			sender.hosted.pin.alive() === true,
		continueGeneration: (applied) =>
			m().writer.continueBindMapGenerationAbove(applied),
		adoptLifetime: (lifetime) => m().observer.adoptContinuityLifetime(lifetime),
		attachTelemetry: (lifetime, ips) =>
			m().telemetry.startLinkTelemetry(lifetime.statsFile, ips.split("\n"), {
				controlSocket: lifetime.controlSocket,
			}),
		reconcile: () => m().orchestrator.reconcileStreamSession(),
		attachSession: (generation, srtlaAddr, current) =>
			m().session.attachAdoptedSession(generation, srtlaAddr, current),
		detachSession: (generation) => m().session.detachAdoptedSession(generation),
		stopTelemetry: () => m().telemetry.stopLinkTelemetry(),
		stopUnit: async (unit, invocation) => {
			modules ??= await lazy();
			return m().host.stopSenderUnit(unit, undefined, undefined, invocation);
		},
		listUnits: async () => {
			modules ??= await lazy();
			return m().host.listSenderUnits();
		},
		detectOnly: (bootId, lifetime) =>
			observeSenderAdoption(undefined, { bootId, lifetime }),
	};
}
