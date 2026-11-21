import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const identity = z.object({
	generation: z.number().int().positive(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const link = z.object({
	linkId: z.string().min(1),
	iface: z.string().min(1),
	ip: z.string().min(1),
});
const base = { version: z.literal(1), bootId: z.string().min(1) };
export const lifetimeSchema = z.object({
	...base,
	lifetime: z.string().uuid(),
	pid: z.number().int().positive().nullable(),
	startTime: z.string().nullable(),
	host: z.enum(["backend-child", "systemd"]),
	invocation: z.string().nullable(),
	argsDigest: z.string(),
	statsFile: z.string(),
	controlSocket: z.string(),
	ipsFile: z.string(),
	sidecarFile: z.string().nullable(),
	required: z.boolean(),
	contract: z.number().int().nonnegative(),
	capabilitiesDigest: z.string().nullable(),
	createdAt: z.number().nonnegative(),
});
export const publicationSchema = z.object({
	...base,
	...identity.shape,
	links: z.array(link),
});
export const witnessSchema = z.object({
	...base,
	generation: z.number().int().positive(),
	links: z.array(
		z.object({
			...link.shape,
			ifindex: z.number().int().positive(),
			addressPresent: z.boolean(),
			kind: z.enum(["ordinary", "native", "unsupported"]),
			owner: z.string().nullable(),
			epoch: z.string().nullable(),
			stamp: z.string().nullable(),
			ready: z.boolean(),
		}),
	),
});
export type Lifetime = z.infer<typeof lifetimeSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type Witness = z.infer<typeof witnessSchema>;
export type Verdict = {
	decision: "adopt" | "tear_down";
	record: string;
	reason: string;
};
export interface ContinuityEvidence {
	bootId: string;
	lifetime: Lifetime | null;
	publication: Publication | null;
	witness: Witness | null;
	disk: Publication | null;
	system: Witness | null;
	process: {
		pid: number;
		startTime: string;
		argsDigest: string;
		invocation: string | null;
		processCount: number;
	} | null;
	sender: {
		contract: number;
		required: boolean;
		capabilitiesDigest: string;
		samples: Array<{
			generation: number;
			sha256: string;
			mapped: boolean;
			pending: boolean;
			bytes: number;
			links: Array<{ linkId: string; iface: string }>;
		}>;
	} | null;
	engine: "streaming" | "idle" | "unknown";
	now: number;
	journalClear: boolean;
	inventoryReadable: boolean;
	isolated: boolean;
}

/** Pure, ordered proof. This result must never drive recovery in slice zero. */
export function continuityVerdict(e: ContinuityEvidence): Verdict {
	const refuse = (record: string, reason: string): Verdict => ({
		decision: "tear_down",
		record,
		reason,
	});
	for (const [name, value] of [
		["lifetime", e.lifetime],
		["publication", e.publication],
		["witness", e.witness],
	] as const) {
		if (!value) return refuse(name, "missing_or_invalid");
		if (value.bootId !== e.bootId) return refuse(name, "previous_boot");
	}
	const l = e.lifetime;
	const p = e.publication;
	const w = e.witness;
	if (!l || !p || !w) return refuse("records", "missing_or_invalid");
	if (!e.process) return refuse("system", "sender_absent");
	if (e.process.pid !== l.pid || e.process.startTime !== l.startTime)
		return refuse("lifetime", "process_identity");
	if (
		l.host !== "systemd" ||
		!l.invocation ||
		e.process.invocation !== l.invocation ||
		e.process.processCount !== 1
	)
		return refuse("lifetime", "unsupervised_sender");
	if (e.process.argsDigest !== l.argsDigest)
		return refuse("lifetime", "arguments_changed");
	if (e.now < l.createdAt || e.now - l.createdAt > 120_000)
		return refuse("lifetime", "unsupervised_age");
	if (!e.disk) return refuse("disk", "missing_or_invalid");
	if (e.disk.bootId !== e.bootId) return refuse("disk", "previous_boot");
	if (p.generation > e.disk.generation)
		return refuse("publication", "record_ahead_of_disk");
	if (
		p.generation !== e.disk.generation ||
		p.sha256 !== e.disk.sha256 ||
		JSON.stringify(p.links) !== JSON.stringify(e.disk.links)
	)
		return refuse("disk", "publication_mismatch");
	if (!e.sender) return refuse("sender", "live_report_unavailable");
	if (
		!l.required ||
		!e.sender.required ||
		l.contract < 2 ||
		e.sender.contract < 2
	)
		return refuse("sender", "required_contract_missing");
	if (
		!l.capabilitiesDigest ||
		l.capabilitiesDigest !== e.sender.capabilitiesDigest
	)
		return refuse("sender", "capabilities_changed");
	if (e.sender.samples.length !== 2)
		return refuse("sender", "two_fresh_reads_required");
	for (const sample of e.sender.samples) {
		if (sample.pending) return refuse("sender", "pending_apply");
		if (!sample.mapped) return refuse("sender", "not_mapped");
		if (sample.generation !== p.generation || sample.sha256 !== p.sha256)
			return refuse("sender", "applied_identity_mismatch");
		if (
			JSON.stringify(sample.links) !==
			JSON.stringify(p.links.map(({ linkId, iface }) => ({ linkId, iface })))
		)
			return refuse("sender", "links_mismatch");
	}
	if ((e.sender.samples[1]?.bytes ?? 0) <= (e.sender.samples[0]?.bytes ?? 0))
		return refuse("sender", "no_progress");
	if (e.engine !== "streaming") return refuse("engine", "not_streaming");
	if (!e.inventoryReadable) return refuse("system", "inventory_unreadable");
	if (!e.journalClear) return refuse("system", "journal_block");
	if (e.isolated) return refuse("system", "isolated_host");
	if (
		w.generation !== p.generation ||
		JSON.stringify(
			w.links.map(({ linkId, iface, ip }) => ({ linkId, iface, ip })),
		) !== JSON.stringify(p.links)
	)
		return refuse("witness", "publication_mismatch");
	for (const host of w.links) {
		if (host.kind === "unsupported")
			return refuse("witness", "unsupported_host");
		if (host.kind === "native" && (!host.owner || !host.epoch || !host.stamp))
			return refuse("witness", "host_identity_missing");
		if (!host.ready || !host.addressPresent)
			return refuse("witness", "host_not_ready");
	}
	if (
		!e.system ||
		e.system.bootId !== e.bootId ||
		JSON.stringify(w) !== JSON.stringify(e.system)
	)
		return refuse("system", "host_witness_mismatch");
	return { decision: "adopt", record: "all", reason: "agreement" };
}

export async function readRecord<T>(
	path: string,
	schema: z.ZodType<T>,
): Promise<T | null> {
	try {
		return schema.parse(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return null;
	}
}

/** Crash durable replace: unique sibling, file fsync, rename, directory fsync. */
export async function writeRecord<T>(
	path: string,
	schema: z.ZodType<T>,
	value: T,
	current: () => boolean = () => true,
): Promise<void> {
	const clean = schema.parse(value); // Strip unrecognised fields, including credentials.
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temp, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(clean));
			await file.sync();
		} finally {
			await file.close();
		}
		if (!current()) return;
		await rename(temp, path);
		const dir = await open(dirname(path), "r");
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
	} finally {
		await unlink(temp).catch(() => {
			/* Already renamed or absent. */
		});
	}
}

/** Per-source diagnostic independent of a dead sender's global refusal. */
export function hostContinuityVerdict(
	bootId: string,
	saved: Witness | null,
	current: Witness | null,
	index: number,
): Verdict {
	const refuse = (record: string, reason: string): Verdict => ({
		decision: "tear_down",
		record,
		reason,
	});
	if (!saved) return refuse("witness", "missing_or_invalid");
	if (saved.bootId !== bootId) return refuse("witness", "previous_boot");
	const host = saved.links[index];
	if (!host) return refuse("witness", "missing_or_invalid");
	if (host.kind === "unsupported") return refuse("witness", "unsupported_host");
	if (host.kind === "native" && (!host.owner || !host.epoch || !host.stamp))
		return refuse("witness", "host_identity_missing");
	if (!host.ready || !host.addressPresent)
		return refuse("witness", "host_not_ready");
	if (
		!current ||
		current.bootId !== bootId ||
		JSON.stringify(host) !== JSON.stringify(current.links[index])
	)
		return refuse("system", "host_witness_mismatch");
	return { decision: "adopt", record: "host", reason: "agreement" };
}
