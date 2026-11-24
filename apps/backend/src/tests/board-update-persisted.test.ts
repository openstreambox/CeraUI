import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	boardUpdateAdmissionAllowed,
	setUpdateReleaseReaderForTest,
} from "../modules/system/board-update-admission.ts";
import { resolveBoardUpdates } from "../modules/system/board-updates.ts";
import { defaultDeviceDetectionDeps } from "../modules/system/device-detection.ts";
import { defaultKernelEffects } from "../modules/system/update-orchestrator/kernel-runtime.ts";
import { readBoardIdentity } from "../modules/system/update-orchestrator/os-identity.ts";
import {
	checkOsManifestResult,
	checkUpdatesNow,
	getOrchestratorState,
	getOsUpdateSummary,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	kernelCapabilities,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";
import {
	fakeDeps,
	quarantineDirs,
} from "./helpers/orchestrator-runtime-harness.ts";

const identity =
	'ID=ceralive\nBOARD=example\nFAMILY=rk3588\nCAPABILITIES="os-updates"\n';
const fields = [
	"UPDATE_BOARD=example",
	"UPDATE_COMPATIBLE=ceralive-example",
	"KERNEL_ARCH=arm64",
];
const records = [
	identity,
	...fields.flatMap((_, missing) =>
		[false, true].map(
			(empty) =>
				identity +
				fields
					.map((field, index) =>
						index === missing
							? empty
								? `${field.split("=")[0]}=`
								: ""
							: field,
					)
					.join("\n") +
				"\n",
		),
	),
];

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setUpdateReleaseReaderForTest(null);
	for (const dir of quarantineDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

for (const [index, record] of records.entries()) {
	test(`persisted incomplete update record ${index} has no kernel candidate`, async () => {
		const reader = spyOn(
			defaultDeviceDetectionDeps,
			"readCeraliveRelease",
		).mockResolvedValue(record);
		setUpdateReleaseReaderForTest(() => record);
		try {
			expect(boardUpdateAdmissionAllowed()).toBe(true);
			expect(resolveBoardUpdates(record)).toBeNull();
			await expect(
				defaultKernelEffects.discover(kernelCapabilities),
			).resolves.toBeNull();
		} finally {
			reader.mockRestore();
		}
	});
	for (const mode of ["manual", "scheduled"] as const) {
		test(`${mode} check calmly refuses persisted incomplete update record ${index}`, async () => {
			const reader = spyOn(
				defaultDeviceDetectionDeps,
				"readCeraliveRelease",
			).mockResolvedValue(record);
			setUpdateReleaseReaderForTest(() => record);
			let packageChecks = 0;
			let osChecks = 0;
			let mutations = 0;
			const forbidden = async () => {
				mutations++;
				throw new Error("unexpected update mutation");
			};
			setOrchestratorRuntimeDepsForTest(
				fakeDeps({
					loadCapabilities: async () => ({
						...kernelCapabilities,
						features: [
							...kernelCapabilities.features,
							"rauc-verity-streaming",
							"slot-sync",
						],
					}),
					isUpdateAdmissionReady: async () => true,
					readSlotSyncEvidence: async () => ({
						healthyState: {
							boot_id: "boot",
							slot: "A",
							build_id: "build",
							dpkg_status_sha256: "sha",
							recorded_at: "2026-10-20",
						},
						bootId: "boot",
						buildId: "build",
						statusSha256: "sha",
						receiptStateSha256: null,
						receiptTarget: "not-other",
						receiptTargetSlot: null,
					}),
					readRootSlots: async () => [
						{
							name: "rootfs.0",
							bootname: "A",
							state: "booted",
							bootStatus: "good",
							version: "1",
							lastSyncedAt: null,
						},
					],
					runPackageCheck: async () => {
						packageChecks++;
						return null;
					},
					checkOsManifest: async () => {
						osChecks++;
						return checkOsManifestResult("stable", async () => {
							await readBoardIdentity();
							throw new Error("unexpected supported board");
						});
					},
					kernel: {
						...defaultKernelEffects,
						readState: async () => kernelState,
						readOverlay: async () => null,
						download: forbidden,
						launch: forbidden,
						arm: forbidden,
					},
					stageOs: forbidden,
					startSlotSync: forbidden,
				}),
			);
			setOrchestratorStateForTest(initialOrchestratorState(0));
			try {
				if (mode === "manual")
					expect(await checkUpdatesNow()).toEqual({ started: true });
				else {
					await runOrchestratorTick();
					await runOrchestratorTick();
				}
				expect(packageChecks).toBe(1);
				expect(osChecks).toBe(1);
				expect(getOsUpdateSummary().boardNotOffered).toBe(true);
				expect(getOrchestratorState()).toMatchObject({
					phase: "idle",
					failureReason: null,
				});
				expect(await installUpdatesNow({ scope: "kernel" })).toEqual({
					started: false,
					reason: "not_available",
				});
				expect(await installUpdatesNow({ scope: "os" })).toEqual({
					started: false,
					reason: "not_available",
				});
				expect(mutations).toBe(0);
			} finally {
				reader.mockRestore();
			}
		});
	}
}
