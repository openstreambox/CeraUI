import { afterEach, beforeEach, expect, test } from "bun:test";
import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import {
	UNSAFE_POWER_PROOF_TTL_MS,
	UnsafePowerRelease,
} from "../modules/system/update-orchestrator/os-unsafe-power-release.ts";
import {
	getOrchestratorDisruptionBusyReasons,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

const CANDIDATE =
	"2026.11.11241|2|beta|rock-5b-plus|ceralive-rock-5b-plus|https://updates.example.test/bundle.raucb|8515b4a542dc9f41695e831562bbacefb5725cb754a4db9382e0bb7cf892e4bb";

function unsafeRecord(
	overrides: Partial<OsStageRecovery> = {},
): OsStageRecovery {
	return {
		candidateKey: CANDIDATE,
		activeAttemptId: null,
		attemptId: "a1e35b7c-431b-4cc1-85b7-69c4025dca48",
		failedRounds: 1,
		nextRetryAt: null,
		mode: "unsafe",
		reason: "rauc_recovery_unproven",
		...overrides,
	};
}

// The persisted state a finished install left behind: RAUC wrote the slot,
// then the attempt settled unsafe (synthetic URL).
function failedUnsafeState(
	record: OsStageRecovery = unsafeRecord(),
): OrchestratorState {
	return {
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
		osStageRecovery: record,
	};
}

let now = 1_000_000;
let quiet = true;
let proofs = 0;

function install(): void {
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			now: () => now,
			isOsStageReady: async () => {
				proofs++;
				return quiet;
			},
			isUpdateAdmissionReady: async () => true,
			// An attempt still being observed sees RAUC busy and waits.
			inspectOsOperation: async () => "running" as const,
		}),
	);
}

beforeEach(() => {
	resetOrchestratorRuntimeForTest();
	now = 1_000_000;
	quiet = true;
	proofs = 0;
	install();
});
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorRuntimeDepsForTest(null);
});

test("a settled unsafe install stops refusing power actions once RAUC is proven quiet", async () => {
	// Given the state a finished install left: failed / unsafe, no attempt running.
	setOrchestratorStateForTest(failedUnsafeState());
	// Before any proof the record still holds the gate (fail closed).
	expect(getOrchestratorDisruptionBusyReasons()).toContain("update-recovery");
	// When the tick observes RAUC idle, the booted slot primary and nothing armed.
	await runOrchestratorTick();
	// Then reboot and restart actions are no longer refused for this record...
	expect(proofs).toBeGreaterThan(0);
	expect(getOrchestratorDisruptionBusyReasons()).not.toContain(
		"update-recovery",
	);
	// ...while the outcome stays unknown: no automatic round, record kept.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		osStageRecovery: { mode: "unsafe", reason: "rauc_recovery_unproven" },
	});
});

test("an unproven or unreadable physical state keeps the gate closed", async () => {
	setOrchestratorStateForTest(failedUnsafeState());
	await runOrchestratorTick();
	expect(getOrchestratorDisruptionBusyReasons()).not.toContain(
		"update-recovery",
	);
	// When a later observation no longer proves quiet (RAUC busy, target armed...).
	quiet = false;
	await runOrchestratorTick();
	// Then the gate closes again at once.
	expect(getOrchestratorDisruptionBusyReasons()).toContain("update-recovery");
});

test("the proof expires when the tick stops refreshing it", async () => {
	setOrchestratorStateForTest(failedUnsafeState());
	await runOrchestratorTick();
	expect(getOrchestratorDisruptionBusyReasons()).not.toContain(
		"update-recovery",
	);
	now += UNSAFE_POWER_PROOF_TTL_MS;
	expect(getOrchestratorDisruptionBusyReasons()).toContain("update-recovery");
});

test("a proof belongs to its exact record", async () => {
	setOrchestratorStateForTest(failedUnsafeState());
	await runOrchestratorTick();
	expect(getOrchestratorDisruptionBusyReasons()).not.toContain(
		"update-recovery",
	);
	// A new unsafe record (another attempt) is unproven until observed again.
	setOrchestratorStateForTest(
		failedUnsafeState(unsafeRecord({ failedRounds: 2 })),
	);
	expect(getOrchestratorDisruptionBusyReasons()).toContain("update-recovery");
});

test("an attempt that is still active always holds the gate", async () => {
	setOrchestratorStateForTest({
		...failedUnsafeState(unsafeRecord({ activeAttemptId: "attempt-1" })),
		phase: "os-staged",
		failureReason: null,
	});
	await runOrchestratorTick();
	expect(proofs).toBe(0);
	expect(getOrchestratorDisruptionBusyReasons()).toContain("update-recovery");
});

test("a record that changes during the observation is not released", async () => {
	const release = new UnsafePowerRelease();
	const first = unsafeRecord();
	let current: OsStageRecovery | undefined = first;
	await release.refresh({
		record: () => current,
		writerActive: () => false,
		proveQuiet: async () => {
			current = unsafeRecord({ failedRounds: 2 });
			return true;
		},
		now: () => now,
	});
	expect(release.holds(first, now)).toBe(true);
	expect(release.holds(current, now)).toBe(true);
});

test("a throwing proof or an active writer is not a proof", async () => {
	const release = new UnsafePowerRelease();
	const record = unsafeRecord();
	await release.refresh({
		record: () => record,
		writerActive: () => false,
		proveQuiet: async () => {
			throw new Error("rauc status unreadable");
		},
		now: () => now,
	});
	expect(release.holds(record, now)).toBe(true);
	let observed = false;
	await release.refresh({
		record: () => record,
		writerActive: () => true,
		proveQuiet: async () => {
			observed = true;
			return true;
		},
		now: () => now,
	});
	expect(observed).toBe(false);
	expect(release.holds(record, now)).toBe(true);
});

test("operator and automatic records never held power actions", () => {
	const release = new UnsafePowerRelease();
	expect(release.holds(undefined, now)).toBe(false);
	expect(release.holds(unsafeRecord({ mode: "operator" }), now)).toBe(false);
	expect(release.holds(unsafeRecord({ mode: "automatic" }), now)).toBe(false);
});
