import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { createControlClient } from "@ceraui/srtla-send/control";
import { controlSocketPath } from "@ceraui/srtla-send/sender";
import {
	senderTelemetryPath,
	type Telemetry,
} from "@ceraui/srtla-send/telemetry";
import { z } from "zod";
import { logger } from "../../helpers/logger.ts";
import { type BondEntry, isValidIdPath } from "./bind-map.ts";
import { SRTLA_LISTEN_PORT } from "./constants.ts";
import {
	type ContinuityEvidence,
	continuityVerdict,
	hostContinuityVerdict,
	type Lifetime,
	lifetimeSchema,
	type Publication,
	publicationSchema,
	readRecord,
	type Witness,
	witnessSchema,
	writeRecord,
} from "./continuity-records.ts";
import { createLatestReportWriter } from "./latest-report-writer.ts";
import {
	captureProcessInvocation,
	type EngineSessionIdentity,
	processInvocationIo,
	senderHost,
} from "./sender-invocation.ts";

const liveSchema = z.object({
	version: z.literal(1),
	bootId: z.string(),
	lifetime: z.string(),
	capabilitiesDigest: z.string().nullable(),
	reads: z.array(
		z.object({
			available: z.boolean(),
			links: z.array(z.object({ linkId: z.string(), iface: z.string() })),
		}),
	),
});

const reportSchema = z.object({
	version: z.literal(1),
	bootId: z.string(),
	lifetime: z.string(),
	observedAt: z.number(),
	mapped: z.boolean(),
	links: z.array(z.object({ linkId: z.string(), iface: z.string() })),
});

export const CONTINUITY_DIR = "/run/ceralive/continuity";
// Leaf I/O boundary: tests isolate diagnostics even when running as root.
export const continuityObserverIo = {
	directory: process.env.CERALIVE_CONTINUITY_DIR ?? CONTINUITY_DIR,
	bootId,
	processIdentity,
	captureInvocation: (pid: number, ownChild?: () => boolean) =>
		captureProcessInvocation(pid, processInvocationIo, ownChild),
	senderHost: (pid: number) => senderHost(pid),
	writeRecord,
	captureWitness,
	createControlClient,
};
export function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
export async function bootId(): Promise<string> {
	try {
		return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
export async function observeSafely(
	effect: () => Promise<void>,
): Promise<void> {
	try {
		await effect();
	} catch {
		logger.warn("continuity: observation unavailable; recovery unchanged");
	}
}
async function processIdentity(pid: number) {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
	if (args.at(-1) === "") args.pop();
	return {
		pid,
		startTime: fields[19] ?? "",
		argsDigest: digest(JSON.stringify(args)),
		invocation: null,
		processCount: 1,
	};
}

/** Diagnostic observation records the existing paths; record storage never supplies sender paths. */
export function senderPaths() {
	return {
		statsFile: senderTelemetryPath(SRTLA_LISTEN_PORT),
		controlSocket: controlSocketPath(SRTLA_LISTEN_PORT),
	};
}
export async function recordSenderIntent(
	args: string[],
	paths: { statsFile: string; controlSocket: string },
	ipsFile: string,
): Promise<Lifetime | null> {
	const lifetime = randomUUID();
	intendedLifetime = lifetime;
	const epoch = ++telemetryEpoch;
	activeLifetime = null;
	telemetryWriter.discardPending();
	const currentBoot = await continuityObserverIo.bootId();
	if (!currentBoot || epoch !== telemetryEpoch) return null;
	const record: Lifetime = {
		version: 1,
		bootId: currentBoot,
		lifetime,
		pid: null,
		startTime: null,
		host: "backend-child",
		invocation: null,
		argsDigest: digest(JSON.stringify(args)),
		...paths,
		ipsFile,
		sidecarFile: args.includes("--bind-map")
			? (args[args.indexOf("--bind-map") + 1] ?? null)
			: null,
		// Required mode exists only when the vector asks for it.
		required: args.includes("--require-bind-map"),
		contract: 0,
		capabilitiesDigest: null,
		createdAt: Date.now(),
	};
	await continuityObserverIo.writeRecord(
		`${continuityObserverIo.directory}/lifetime.json`,
		lifetimeSchema,
		record,
		() => epoch === telemetryEpoch,
	);
	return record;
}
let activeLifetime: Lifetime | null = null;
let intendedLifetime: string | null = null;
let telemetryEpoch = 0;
export function clearContinuityTelemetry(): void {
	telemetryEpoch++;
	intendedLifetime = null;
	activeLifetime = null;
	telemetryWriter.discardPending();
}

/**
 * A takeover adopted the sender this record describes: later observations
 * (the engine session, telemetry reports) belong to it, as they would to a
 * sender this process started. Nothing is written.
 */
export function adoptContinuityLifetime(record: Lifetime): void {
	telemetryEpoch++;
	telemetryWriter.discardPending();
	intendedLifetime = record.lifetime;
	activeLifetime = record;
}

export async function recordSenderStarted(
	record: Lifetime,
	pid: number,
	ownChild?: () => boolean,
): Promise<void> {
	const epoch = telemetryEpoch;
	const currentIntent = () =>
		epoch === telemetryEpoch && intendedLifetime === record.lifetime;
	if (!currentIntent()) return;
	// PID, start time and boot id in one capture, bracketed by a pidfd where
	// available and tied to the spawning handle: a sender that already exited
	// records nothing, and the record keeps `pid: null`.
	const current = await continuityObserverIo.captureInvocation(pid, ownChild);
	if (!currentIntent()) return;
	if (!current || current.bootId !== record.bootId) return;
	const host = await continuityObserverIo.senderHost(pid);
	if (!currentIntent()) return;
	// The host was read from the same process: captured again, unchanged.
	const after = await continuityObserverIo.captureInvocation(pid, ownChild);
	if (!currentIntent()) return;
	if (after?.startTime !== current.startTime) return;
	const started: Lifetime = {
		...record,
		pid,
		startTime: current.startTime,
		pidfd: current.pidfd,
		...(host.host === "systemd"
			? {
					host: "systemd",
					invocation: host.invocation,
					cgroup: host.cgroup,
					unit: host.unit,
					unitManager: host.manager,
				}
			: { host: "backend-child", invocation: null }),
	};
	await continuityObserverIo.writeRecord(
		`${continuityObserverIo.directory}/lifetime.json`,
		lifetimeSchema,
		started,
		currentIntent,
	);
	if (!currentIntent()) return;
	activeLifetime = started;
}

/**
 * After the engine confirmed the start: record which engine session this
 * sender serves. `read` must return the session the engine's Start reply
 * named for this launch, confirmed live; `stillLaunched` fences the write to
 * that same launch. Only a sender with its own unit can outlive the backend,
 * so a backend child records nothing and asks the engine nothing.
 */
export async function recordEngineSession(
	record: Lifetime,
	read: () => Promise<EngineSessionIdentity | null>,
	stillLaunched: () => boolean = () => true,
): Promise<void> {
	const epoch = telemetryEpoch;
	const current = () =>
		epoch === telemetryEpoch &&
		intendedLifetime === record.lifetime &&
		activeLifetime?.lifetime === record.lifetime &&
		stillLaunched();
	const started = activeLifetime;
	if (!current() || started?.host !== "systemd") return;
	const engineSession = await read();
	if (!engineSession || !current()) return;
	const next: Lifetime = { ...started, engineSession };
	await continuityObserverIo.writeRecord(
		`${continuityObserverIo.directory}/lifetime.json`,
		lifetimeSchema,
		next,
		current,
	);
	if (current()) activeLifetime = next;
}
export async function captureWitness(p: Publication): Promise<Witness | null> {
	try {
		return await capturePresentWitness(p);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
async function capturePresentWitness(p: Publication): Promise<Witness> {
	const interfaces = networkInterfaces();
	return {
		version: 1,
		bootId: await continuityObserverIo.bootId(),
		generation: p.generation,
		links: await Promise.all(
			p.links.map(async (entry) => ({
				...entry,
				ifindex: Number(
					(
						await readFile(`/sys/class/net/${entry.iface}/ifindex`, "utf8")
					).trim(),
				),
				addressPresent:
					interfaces[entry.iface]?.some(
						(address) => address.address === entry.ip,
					) ?? false,
				// No host ownership API exists on this base. Never infer native ownership from an address.
				kind: "unsupported" as const,
				owner: null,
				epoch: null,
				stamp: null,
				ready: false,
			})),
		),
	};
}
export async function reservePublication(
	generation: number,
	sha256: string,
	entries: readonly BondEntry[],
): Promise<void> {
	// Invalidate old proofs before attempting a new observation, including a
	// mapping whose host identity cannot be represented by this record schema.
	for (const name of ["publication", "witness"])
		await unlink(`${continuityObserverIo.directory}/${name}.json`).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			},
		);
	const currentBoot = await continuityObserverIo.bootId();
	if (!currentBoot || entries.some((entry) => !entry.linkId)) return;
	const publication: Publication = {
		version: 1,
		bootId: currentBoot,
		generation,
		sha256,
		links: entries.map((entry) => ({
			linkId: entry.linkId ?? "",
			iface: entry.iface,
			ip: entry.ip,
			// The sidecar carries `id_path` only when it is valid; so does this.
			...(entry.idPath !== undefined && isValidIdPath(entry.idPath)
				? { idPath: entry.idPath }
				: {}),
		})),
	};
	await continuityObserverIo.writeRecord(
		`${continuityObserverIo.directory}/publication.json`,
		publicationSchema,
		publication,
	);
	const witness = await continuityObserverIo.captureWitness(publication);
	if (witness)
		await continuityObserverIo.writeRecord(
			`${continuityObserverIo.directory}/witness.json`,
			witnessSchema,
			witness,
		);
}

/**
 * The map the sender would read now: the bind-map sidecar (rows including
 * `id_path`) and the SHA-256 of the IP list's raw bytes, as a publication.
 * Null when either is missing or torn, or the sidecar's `ips_file_sha256` is
 * not the hash of that IP list (the sidecar names no path; the hash is the
 * binding).
 */
export async function readDiskPublication(
	lifetime: Pick<Lifetime, "sidecarFile" | "ipsFile">,
): Promise<Publication | null> {
	try {
		const sidecar = JSON.parse(
			await readFile(
				lifetime.sidecarFile ?? `${lifetime.ipsFile}.bindmap.json`,
				"utf8",
			),
		);
		const disk = publicationSchema.parse({
			version: sidecar.schema_version,
			bootId: await continuityObserverIo.bootId(),
			generation: sidecar.generation,
			// The raw bytes, as the writer and the sender hash them.
			sha256: digest(await readFile(lifetime.ipsFile)),
			links: sidecar.links.map(
				(l: {
					link_id: string;
					iface: string;
					ip: string;
					id_path?: string;
				}) => ({
					linkId: l.link_id,
					iface: l.iface,
					ip: l.ip,
					...(l.id_path === undefined ? {} : { idPath: l.id_path }),
				}),
			),
		});
		return sidecar.ips_file_sha256 === disk.sha256 ? disk : null;
	} catch {
		// Missing or torn sidecar is not proof.
		return null;
	}
}

/** Read-only snapshot before the existing orphan sweep. No stale stats-file proof. */
export async function observeStartup(
	engine: ContinuityEvidence["engine"],
): Promise<void> {
	const currentBoot = await continuityObserverIo.bootId();
	if (!currentBoot) return;
	const lifetime = await readRecord(
		`${continuityObserverIo.directory}/lifetime.json`,
		lifetimeSchema,
	);
	const publication = await readRecord(
		`${continuityObserverIo.directory}/publication.json`,
		publicationSchema,
	);
	const witness = await readRecord(
		`${continuityObserverIo.directory}/witness.json`,
		witnessSchema,
	);
	let disk: Publication | null = null;
	let system: Witness | null = null;
	let process: ContinuityEvidence["process"] = null;
	if (lifetime) {
		disk = await readDiskPublication(lifetime);
		try {
			if (lifetime.pid)
				process = await continuityObserverIo.processIdentity(lifetime.pid);
		} catch {
			/* Dead child. */
		}
	}
	if (publication) {
		try {
			system = await continuityObserverIo.captureWitness(publication);
		} catch {
			/* Unknown host. */
		}
	}
	// The installed binding does not expose contract-2 applied identity. Save only
	// projected live fields; never turn an old contract into an adoption proof.
	if (
		lifetime &&
		process &&
		lifetime.bootId === currentBoot &&
		process.pid === lifetime.pid &&
		process.startTime === lifetime.startTime &&
		process.argsDigest === lifetime.argsDigest
	) {
		const client = await continuityObserverIo.createControlClient({
			socketPath: lifetime.controlSocket,
			timeoutMs: 500,
		});
		if (client)
			try {
				const capabilities = await client.getCapabilities();
				const first = await client.getStats();
				const second = await client.getStats();
				await continuityObserverIo.writeRecord(
					`${continuityObserverIo.directory}/live.json`,
					liveSchema,
					{
						version: 1,
						bootId: await continuityObserverIo.bootId(),
						lifetime: lifetime.lifetime,
						capabilitiesDigest: capabilities
							? digest(JSON.stringify(capabilities))
							: null,
						reads: [first, second].map((s) => ({
							available: s !== null,
							links:
								s?.links.map((l) => ({
									linkId: l.link_id ?? "",
									iface: l.iface ?? "",
								})) ?? [],
						})),
					},
				);
			} catch {
				// A failed live read remains unavailable; always log the verdict.
			} finally {
				client.close();
			}
	}
	const verdict = continuityVerdict({
		bootId: await continuityObserverIo.bootId(),
		lifetime,
		publication,
		witness,
		disk,
		system,
		process,
		sender: null,
		engine,
		now: Date.now(),
		journalClear: false,
		inventoryReadable: false,
		isolated: false,
	});
	logger.info("continuity: dry-run verdict (recovery unchanged)", verdict);
	for (const index of witness?.links.keys() ?? [])
		logger.info("continuity: host dry-run verdict (recovery unchanged)", {
			index,
			...hostContinuityVerdict(
				await continuityObserverIo.bootId(),
				witness,
				system,
				index,
			),
		});
}

const telemetryWriter = createLatestReportWriter<z.infer<typeof reportSchema>>(
	async (report) => {
		if (activeLifetime?.lifetime !== report.lifetime) return;
		await continuityObserverIo.writeRecord(
			`${continuityObserverIo.directory}/report.json`,
			reportSchema,
			report,
			() => activeLifetime?.lifetime === report.lifetime,
		);
	},
	() => logger.warn("continuity: observation unavailable; recovery unchanged"),
);
/** Test seam: await the bounded writer instead of assuming a storage latency. */
export async function flushContinuityTelemetryForTest(): Promise<void> {
	await telemetryWriter.flush();
}

/** Project telemetry only. This durable report is never evidence of liveness. */
export function recordSenderTelemetry(telemetry: Telemetry): void {
	const lifetime = activeLifetime;
	if (!lifetime) return;
	const report = {
		version: 1 as const,
		bootId: lifetime.bootId,
		lifetime: lifetime.lifetime,
		observedAt: Date.now(),
		links: telemetry.connections.map((l) => ({
			linkId: l.link_id ?? "",
			iface: l.iface ?? "",
		})),
		mapped: telemetry.disposition?.state === "mapped",
	};
	telemetryWriter.submit(report);
}
