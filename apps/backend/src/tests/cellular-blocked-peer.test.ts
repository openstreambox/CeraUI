import { afterEach, expect, test } from "bun:test";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";
import { initCellularRuntimeAdmission } from "../modules/modems/cellular-runtime-host.ts";
import { refreshMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import { resolvePhysicalDevice } from "../modules/modems/physical-identity.ts";
import {
	captureCellularSourcePublication,
	cellularSourceReady,
	resetCellularSourcesForTest,
} from "../modules/network/cellular-source-state.ts";
import { setBondIdentityResolverForTest } from "../modules/streaming/bond-entry.ts";
import {
	resetLifecycleInterlock,
	setMutationBlocks,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { publishedBondNeedsRequiredBinding } from "../modules/streaming/srtla.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";

afterEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetCellularSourcesForTest();
	setBondIdentityResolverForTest(null);
});

test("a blocked cellular peer cannot prevent a stream from using independently qualified healthy links", async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setMutationBlocks([
		{
			stableKey: deriveModemStableKey("wwanBad"),
			refusal: "mutation_blocked",
			blocksStreaming: true,
		},
	]);
	setBondIdentityResolverForTest((ifname) =>
		resolvePhysicalDevice({ ifname, idPath: ifname }),
	);
	initCellularRuntimeAdmission();
	const sent: string[] = [];
	const healthy = ["wwanA", "wwanB"];
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "attempt-healthy",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		blockingMutation: streamSessionProductionDeps.blockingMutation,
	});
	const result = await session.start({
		origin: "ui",
		launch: async () => {
			expect(cellularSourceReady("wwanBad", "192.0.2.3")).toBe(false);
			expect(publishedBondNeedsRequiredBinding()).toBe(true);
			sent.push(
				...healthy.filter((iface) => cellularSourceReady(iface, "192.0.2.2")),
			);
		},
	});
	expect(result.result).toBe("started");
	expect(sent).toEqual(healthy);
	const stuck = tryAcquireModemMutation(deriveModemStableKey("wwanBad"));
	expect(stuck.admitted).toBe(false);
});

test("quarantine revokes a queued unmanaged publication and fails closed on unproved identity", () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setBondIdentityResolverForTest((ifname) =>
		resolvePhysicalDevice({ ifname, idPath: ifname }),
	);
	initCellularRuntimeAdmission();
	const before = captureCellularSourcePublication(
		"wwanBad",
		"192.0.2.3",
		"wwanBad",
	);
	expect(before()).toBe(true);
	setMutationBlocks([
		{
			stableKey: deriveModemStableKey("wwanBad"),
			refusal: "mutation_blocked",
			blocksStreaming: true,
		},
	]);
	expect(before()).toBe(false);
	expect(cellularSourceReady("wwanGood", "192.0.2.2")).toBe(true);
	setBondIdentityResolverForTest((ifname) => resolvePhysicalDevice({ ifname }));
	expect(cellularSourceReady("wwanUnknown", "192.0.2.4")).toBe(false);
	setMutationBlocks([]);
	expect(before()).toBe(false);
});

test("published journal blocks describe per-device quarantine while retaining the mutation refusal", async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetCellularSourcesForTest();
	const key = deriveModemStableKey("wwanBad");
	if (!key) throw new Error("Synthetic physical key unavailable");
	const deps = {
		listEntries: async () => [
			{
				version: 1 as const,
				stableKey: key,
				kind: "modem-config" as const,
				state: "failed" as const,
				attemptId: "blocked-attempt",
				startedAt: 1,
				updatedAt: 1,
				preState: {},
				history: [{ state: "failed" as const, at: 1 }],
			},
		],
		presentStableKeys: async () => new Set([key]),
	};
	expect((await refreshMutationBlocks(deps))[0]?.blocksStreaming).toBe(true);
	initCellularRuntimeAdmission();
	expect((await refreshMutationBlocks(deps))[0]?.blocksStreaming).toBe(false);
	expect(tryAcquireModemMutation(key)).toEqual({
		admitted: false,
		refusal: "mutation_blocked",
	});
	expect(publishedBondNeedsRequiredBinding()).toBe(true);
});
