import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logRedact } from "../helpers/logger.ts";
import { getConfig } from "../modules/config.ts";
import { setModemCapabilityEvidenceReader } from "../modules/modems/capability-gates.ts";
import { type EsimDeps, runEsimOperation } from "../modules/modems/esim.ts";
import {
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { beginModemMutation } from "../modules/modems/mutation-lease.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { isSensitiveProcedure } from "../rpc/rpc-logging.ts";

const key = "usb-synthetic-port";
const inspect = { device: "0", action: "inspect", acknowledged: true } as const;
const snapshot = { token: "a".repeat(64), profiles: [] };
let dir = "";
let calls = 0;
let deps: EsimDeps;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "esim-test-"));
	setMutationJournalDeps({ dir });
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	getConfig().modem_capabilities = { esim: true };
	setModemCapabilityEvidenceReader(() => ({ capability: { esim: "present" } }));
	calls = 0;
	deps = {
		resolve: async () => ({
			stableKey: key,
			vidPid: "1234:5678",
			model: "Synthetic modem",
			firmwareRevision: "test",
			physicalUid: "synthetic",
			currentMode: undefined,
			ifname: "wwan0",
			ports: [],
		}),
		available: async () => true,
		execute: async () => {
			calls++;
			return { success: true, snapshot };
		},
	};
});

afterEach(async () => {
	delete getConfig().modem_capabilities;
	setModemCapabilityEvidenceReader(null);
	resetMutationJournalDeps();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	await rm(dir, { recursive: true, force: true });
});

test("gate off and unconfigured hosts execute nothing", async () => {
	delete getConfig().modem_capabilities;
	expect(await runEsimOperation(inspect, deps)).toEqual({
		success: false,
		error: "module_disabled",
	});
	getConfig().modem_capabilities = { esim: true };
	deps.available = async () => false;
	expect(await runEsimOperation(inspect, deps)).toEqual({
		success: false,
		error: "not_configured",
	});
	expect(calls).toBe(0);
});

test("unresolved physical identity is refused before journaling", async () => {
	deps.resolve = async () => undefined;
	expect(await runEsimOperation(inspect, deps)).toEqual({
		success: false,
		error: "identity_unresolved",
	});
	expect(await readdir(dir)).toEqual([]);
	expect(calls).toBe(0);
});

test("even inspecting profiles refuses a concurrent modem mutation", async () => {
	const lease = beginModemMutation(key);
	if (!lease.ok) throw new Error("fixture lease");
	try {
		expect(await runEsimOperation(inspect, deps)).toEqual({
			success: false,
			error: "mutation_in_progress",
		});
		expect(calls).toBe(0);
	} finally {
		lease.lease.release();
	}
});

test("stream admission and eUICC management share the lifecycle interlock", async () => {
	const lease = tryAcquireLifecycle("start");
	if (!lease.admitted) throw new Error("fixture lifecycle");
	try {
		expect((await runEsimOperation(inspect, deps)).success).toBe(false);
		expect(calls).toBe(0);
	} finally {
		lease.lease.release();
	}
});

test("journal is executing before helper access and retires after verified readback", async () => {
	deps.execute = async () => {
		const files = await readdir(dir);
		expect(files.length).toBe(1);
		const entry = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
		expect(entry.state).toBe("executing");
		expect(entry.kind).toBe("esim");
		return { success: true, snapshot };
	};
	expect(await runEsimOperation(inspect, deps)).toEqual({
		success: true,
		snapshot,
	});
	expect(await readdir(dir)).toEqual([]);
});

test("writes need positive capability evidence", async () => {
	setModemCapabilityEvidenceReader(() => ({ capability: {} }));
	expect(
		await runEsimOperation(
			{
				device: "0",
				acknowledged: true,
				action: "enable",
				snapshot: snapshot.token,
				profileId: snapshot.token,
			},
			deps,
		),
	).toEqual({ success: false, error: "module_unavailable" });
	expect(calls).toBe(0);
});

test("missing confirmation is refused without helper access", async () => {
	expect(
		await runEsimOperation(
			{
				device: "0",
				acknowledged: true,
				action: "download",
				snapshot: snapshot.token,
				activationCode: "LPA:1$rsp.example.com$TEST$$1",
			},
			deps,
		),
	).toEqual({ success: false, error: "confirmation_required" });
	expect(calls).toBe(0);
});

test("helper failures retain a failed journal, redact credentials and block replay", async () => {
	deps.execute = async () => {
		calls++;
		throw new Error("LPA:1$rsp.example.com$SECRET");
	};
	const request = {
		device: "0",
		acknowledged: true,
		action: "download",
		snapshot: snapshot.token,
		activationCode: "LPA:1$rsp.example.com$SECRET",
	} as const;
	expect(await runEsimOperation(request, deps)).toEqual({
		success: false,
		error: "outcome_unknown",
	});
	const files = await readdir(dir);
	const entry = await readFile(join(dir, files[0]!), "utf8");
	expect(JSON.parse(entry).state).toBe("failed");
	expect(entry).not.toContain("SECRET");
	expect(entry).not.toContain("activationCode");
	expect((await runEsimOperation(request, deps)).success).toBe(false);
	expect(calls).toBe(1);
});

test("eSIM RPC inputs are excluded from tracing", () => {
	expect(isSensitiveProcedure(["modems", "esimOperation"])).toBe(true);
});

test("activation credentials are redacted even in malformed RPC frames", () => {
	const result = JSON.stringify(
		logRedact({
			activationCode: "UNIQUE-ACTIVATION",
			confirmationCode: "UNIQUE-CONFIRMATION",
			matchingId: "UNIQUE-MATCH",
		}),
	);
	expect(result).not.toContain("UNIQUE-");
});

test("activation URIs are redacted under unrelated field names", () => {
	expect(
		JSON.stringify(logRedact({ preview: "LPA:1$rsp.example.com$PRIVATE" })),
	).not.toContain("PRIVATE");
});
