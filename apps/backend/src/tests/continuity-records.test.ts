import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ContinuityEvidence,
	continuityVerdict,
	hostContinuityVerdict,
	lifetimeSchema,
	publicationSchema,
	readRecord,
	witnessSchema,
	writeRecord,
} from "../modules/streaming/continuity-records.ts";

function fixture(): ContinuityEvidence {
	const links = [{ linkId: "link-a", iface: "eth0", ip: "192.0.2.1" }];
	const publication = {
		version: 1 as const,
		bootId: "boot",
		generation: 3,
		sha256: "a".repeat(64),
		links,
	};
	const witness = {
		version: 1 as const,
		bootId: "boot",
		generation: 3,
		links: links.map((l) => ({
			...l,
			ifindex: 4,
			addressPresent: true,
			kind: "native" as const,
			owner: "owner",
			epoch: "epoch",
			stamp: "mm:nm:bearer:connection",
			ready: true,
		})),
	};
	return {
		bootId: "boot",
		lifetime: {
			version: 1,
			bootId: "boot",
			lifetime: "7302a030-b93c-4e93-8fb2-a1d0e27c485d",
			pid: 42,
			startTime: "100",
			host: "systemd",
			invocation: "invocation",
			argsDigest: "digest",
			statsFile: "/run/example.json",
			controlSocket: "/run/example.sock",
			ipsFile: "/run/ips",
			sidecarFile: "/run/ips.bindmap.json",
			required: true,
			contract: 2,
			capabilitiesDigest: "caps",
			createdAt: 1000,
		},
		publication,
		witness,
		disk: structuredClone(publication),
		system: structuredClone(witness),
		process: {
			pid: 42,
			startTime: "100",
			argsDigest: "digest",
			invocation: "invocation",
			processCount: 1,
		},
		sender: {
			contract: 2,
			required: true,
			capabilitiesDigest: "caps",
			samples: [10, 20].map((bytes) => ({
				generation: 3,
				sha256: "a".repeat(64),
				mapped: true,
				pending: false,
				bytes,
				links: [{ linkId: "link-a", iface: "eth0" }],
			})),
		},
		engine: "streaming",
		now: 2000,
		journalClear: true,
		inventoryReadable: true,
		isolated: false,
	};
}
describe("continuity dry run", () => {
	test("agreement adopts without changing input", () => {
		const e = fixture();
		const before = structuredClone(e);
		expect(continuityVerdict(e)).toEqual({
			decision: "adopt",
			record: "all",
			reason: "agreement",
		});
		expect(e).toEqual(before);
	});
	test("per-host proof is independent of sender absence", () => {
		const e = fixture();
		expect(
			hostContinuityVerdict(e.bootId, e.witness, e.system, 0).decision,
		).toBe("adopt");
		if (e.system) for (const host of e.system.links) host.ifindex++;
		expect(hostContinuityVerdict(e.bootId, e.witness, e.system, 0).reason).toBe(
			"host_witness_mismatch",
		);
		expect(hostContinuityVerdict("other", e.witness, e.system, 0).reason).toBe(
			"previous_boot",
		);
		expect(hostContinuityVerdict(e.bootId, null, e.system, 0).reason).toBe(
			"missing_or_invalid",
		);
	});

	const cases: Array<[string, string, (e: ContinuityEvidence) => void]> = [
		[
			"lifetime",
			"missing_or_invalid",
			(e) => {
				e.lifetime = null;
			},
		],
		[
			"publication",
			"missing_or_invalid",
			(e) => {
				e.publication = null;
			},
		],
		[
			"witness",
			"missing_or_invalid",
			(e) => {
				e.witness = null;
			},
		],
		...(["lifetime", "publication", "witness", "disk"] as const).map(
			(key) =>
				[
					key,
					"previous_boot",
					(e: ContinuityEvidence) => {
						if (e[key]) e[key].bootId = "old";
					},
				] as [string, string, (e: ContinuityEvidence) => void],
		),
		[
			"system",
			"sender_absent",
			(e) => {
				e.process = null;
			},
		],
		[
			"lifetime",
			"process_identity",
			(e) => {
				if (e.process) e.process.pid++;
			},
		],
		[
			"lifetime",
			"process_identity",
			(e) => {
				if (e.process) e.process.startTime = "new";
			},
		],
		[
			"lifetime",
			"unsupervised_sender",
			(e) => {
				if (e.process) e.process.invocation = "other";
			},
		],
		[
			"lifetime",
			"unsupervised_sender",
			(e) => {
				if (e.process) e.process.processCount++;
			},
		],
		[
			"lifetime",
			"unsupervised_sender",
			(e) => {
				if (e.lifetime) e.lifetime.host = "backend-child";
			},
		],
		[
			"lifetime",
			"arguments_changed",
			(e) => {
				if (e.process) e.process.argsDigest = "other";
			},
		],
		[
			"lifetime",
			"unsupervised_age",
			(e) => {
				e.now = 122000;
			},
		],
		[
			"disk",
			"missing_or_invalid",
			(e) => {
				e.disk = null;
			},
		],
		[
			"publication",
			"record_ahead_of_disk",
			(e) => {
				if (e.disk) e.disk.generation--;
			},
		],
		[
			"disk",
			"publication_mismatch",
			(e) => {
				if (e.disk) e.disk.generation++;
			},
		],
		[
			"disk",
			"publication_mismatch",
			(e) => {
				if (e.disk) e.disk.sha256 = "b".repeat(64);
			},
		],
		[
			"disk",
			"publication_mismatch",
			(e) => {
				if (e.disk) e.disk.links = [];
			},
		],
		[
			"sender",
			"live_report_unavailable",
			(e) => {
				e.sender = null;
			},
		],
		[
			"sender",
			"required_contract_missing",
			(e) => {
				if (e.sender) e.sender.contract = 1;
			},
		],
		[
			"sender",
			"required_contract_missing",
			(e) => {
				if (e.sender) e.sender.required = false;
			},
		],
		[
			"sender",
			"capabilities_changed",
			(e) => {
				if (e.sender) e.sender.capabilitiesDigest = "other";
			},
		],
		[
			"sender",
			"two_fresh_reads_required",
			(e) => {
				if (e.sender) e.sender.samples.pop();
			},
		],
		[
			"sender",
			"pending_apply",
			(e) => {
				if (e.sender) for (const s of e.sender.samples) s.pending = true;
			},
		],
		[
			"sender",
			"not_mapped",
			(e) => {
				if (e.sender) for (const s of e.sender.samples) s.mapped = false;
			},
		],
		[
			"sender",
			"applied_identity_mismatch",
			(e) => {
				if (e.sender) for (const s of e.sender.samples) s.generation++;
			},
		],
		[
			"sender",
			"applied_identity_mismatch",
			(e) => {
				if (e.sender)
					for (const s of e.sender.samples) s.sha256 = "b".repeat(64);
			},
		],
		[
			"sender",
			"links_mismatch",
			(e) => {
				if (e.sender) for (const s of e.sender.samples) s.links = [];
			},
		],
		[
			"sender",
			"no_progress",
			(e) => {
				if (e.sender) for (const s of e.sender.samples) s.bytes = 10;
			},
		],
		[
			"engine",
			"not_streaming",
			(e) => {
				e.engine = "idle";
			},
		],
		[
			"engine",
			"not_streaming",
			(e) => {
				e.engine = "unknown";
			},
		],
		[
			"system",
			"inventory_unreadable",
			(e) => {
				e.inventoryReadable = false;
			},
		],
		[
			"system",
			"journal_block",
			(e) => {
				e.journalClear = false;
			},
		],
		[
			"system",
			"isolated_host",
			(e) => {
				e.isolated = true;
			},
		],
		[
			"witness",
			"publication_mismatch",
			(e) => {
				if (e.witness) e.witness.generation++;
			},
		],
		[
			"witness",
			"unsupported_host",
			(e) => {
				if (e.witness) for (const h of e.witness.links) h.kind = "unsupported";
			},
		],
		[
			"witness",
			"host_identity_missing",
			(e) => {
				if (e.witness) for (const h of e.witness.links) h.stamp = null;
			},
		],
		[
			"witness",
			"host_not_ready",
			(e) => {
				if (e.witness) for (const h of e.witness.links) h.ready = false;
			},
		],
		[
			"system",
			"host_witness_mismatch",
			(e) => {
				if (e.system) for (const h of e.system.links) h.ifindex++;
			},
		],
		[
			"system",
			"host_witness_mismatch",
			(e) => {
				e.system = null;
			},
		],
	];
	for (const [index, [record, reason, mutate]] of cases.entries())
		test(`${record}: ${reason} (${index})`, () => {
			const e = fixture();
			mutate(e);
			expect(continuityVerdict(e)).toEqual({
				decision: "tear_down",
				record,
				reason,
			});
		});
	test("readers reject missing, torn, old and incomplete records; durable roundtrip strips secrets", async () => {
		const dir = await mkdtemp(join(tmpdir(), "continuity-"));
		const path = join(dir, "record.json");
		try {
			for (const [schema, value] of [
				[lifetimeSchema, fixture().lifetime],
				[publicationSchema, fixture().publication],
				[witnessSchema, fixture().witness],
			] as const) {
				expect(await readRecord(path, schema)).toBeNull();
				// All public writer schemas explicitly project fields.
				await writeRecord(
					path,
					schema as typeof lifetimeSchema,
					{
						...value,
						passphrase: "must-not-persist",
						streamid: "secret",
					} as never,
				);
				expect(await readRecord(path, schema)).toEqual(value);
				expect(await readFile(path, "utf8")).not.toContain("secret");
				expect((await stat(path)).mode & 0o777).toBe(0o600);
				for (const invalid of [
					'{"version":',
					JSON.stringify({ ...value, version: 0 }),
					"{}",
				]) {
					await writeFile(path, invalid);
					expect(await readRecord(path, schema)).toBeNull();
				}
				await rm(path);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

test("publication reserves before file writes and observation failure never gates publication", async () => {
	const { publishBondMapping, resetBindMapWriter } = await import(
		"../modules/streaming/bind-map-writer.ts"
	);
	for (const fail of [false, true]) {
		resetBindMapWriter();
		const events: string[] = [];
		const result = await publishBondMapping(
			[{ ip: "192.0.2.1", iface: "eth0", linkId: "link-a" }],
			{
				ipsFile: "/fixture/ips",
				sidecarFile: "/fixture/map",
				reserve: async (generation, sha256) => {
					events.push("reserve");
					expect(generation).toBe(1);
					expect(sha256).toHaveLength(64);
					if (fail) throw new Error("private data must not be logged");
				},
				writeFile: async () => {
					events.push("write");
				},
				renameFile: async () => {
					events.push("rename");
				},
				removeFile: async () => {
					events.push("remove");
				},
			},
		);
		expect(result.ok).toBe(true);
		expect(events).toEqual(["reserve", "write", "rename", "write", "rename"]);
	}
});
