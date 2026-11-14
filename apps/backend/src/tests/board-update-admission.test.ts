import { afterEach, expect, spyOn, test } from "bun:test";
import {
	boardUpdateAdmissionAllowed,
	setUpdateReleaseReaderForTest,
} from "../modules/system/board-update-admission.ts";
import { resolveBoardUpdates } from "../modules/system/board-updates.ts";
import { defaultDeviceDetectionDeps } from "../modules/system/device-detection.ts";
import {
	runSoftwareUpdateCheck,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import {
	checkUpdatesNow,
	installUpdatesNow,
} from "../modules/system/update-orchestrator/runtime.ts";

afterEach(() => setUpdateReleaseReaderForTest(null));
for (const record of [
	'ID=ceralive\nBOARD=example\nFAMILY=rk3588\nCAPABILITIES=""\n',
	'ID=ceralive\n BOARD=example\n FAMILY=rk3588\n CAPABILITIES="os-updates"\n',
	'ID=ceralive\nBOARD =example\nFAMILY =rk3588\nCAPABILITIES ="os-updates"\n',
	"ID=ceralive\nBOARD=broken\n",
	'id=ceralive\nboard=example\nfamily=rk3588\ncapabilities="os-updates"\n',
	"ID =ceralive\n",
	"garbage\n",
	"ID=ceralive\nUPDATE_BOARD=example\n",
])
	test("record denial refuses every update submission before effects", async () => {
		setUpdateReleaseReaderForTest(() => record);
		expect(boardUpdateAdmissionAllowed()).toBe(false);
		expect(resolveBoardUpdates(record)).toBeNull();
		expect(startSoftwareUpdate()).toMatchObject({ started: false });
		expect(await runSoftwareUpdateCheck()).toBe("discovery_failed");
		expect(await checkUpdatesNow()).toEqual({ started: false, reason: "busy" });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
	});
test("recordless legacy images retain update admission", () => {
	setUpdateReleaseReaderForTest(() => "ID=ceralive\nVERSION_ID=1\n");
	expect(boardUpdateAdmissionAllowed()).toBe(true);
});
test("denied admission never submits package, RAUC or routing work", async () => {
	const updates = await import("../modules/system/software-updates.ts");
	const { stageOsBundle, armOsActivation } = await import(
		"../modules/system/update-orchestrator/os-agent.ts"
	);
	let effects = 0;
	const forbidden = () => {
		effects++;
		throw new Error("unexpected update effect");
	};
	updates.setSoftwareUpdateRunner(forbidden);
	updates.setSoftwareUpdateCheckRunner(forbidden);
	setUpdateReleaseReaderForTest(
		() => 'ID=ceralive\nBOARD=example\nFAMILY=rk3566\nCAPABILITIES=""\n',
	);
	try {
		expect(updates.startSoftwareUpdate()).toMatchObject({ started: false });
		expect(await updates.runSoftwareUpdateCheck()).toBe("discovery_failed");
		await expect(stageOsBundle({} as never, forbidden)).rejects.toThrow(
			"board_updates_not_offered",
		);
		await expect(
			armOsActivation(true, { held: forbidden } as never),
		).rejects.toThrow("board_updates_not_offered");
		expect(effects).toBe(0);
	} finally {
		updates.resetSoftwareUpdateRunner();
		updates.resetSoftwareUpdateCheckRunner();
	}
});

for (const mode of ["development", "override"] as const) {
	test(`independent admission fences denied records under ${mode}`, async () => {
		const development = spyOn(
			defaultDeviceDetectionDeps,
			"isDevelopment",
		).mockReturnValue(mode === "development");
		const override = spyOn(
			defaultDeviceDetectionDeps,
			"getDeviceTypeOverride",
		).mockReturnValue(mode === "override" ? "real" : undefined);
		setUpdateReleaseReaderForTest(
			() => 'ID=ceralive\nBOARD=example\nFAMILY=rk3588\nCAPABILITIES=""\n',
		);
		try {
			expect(boardUpdateAdmissionAllowed()).toBe(false);
			expect(startSoftwareUpdate()).toMatchObject({ started: false });
			expect(await checkUpdatesNow()).toEqual({
				started: false,
				reason: "busy",
			});
			expect(await installUpdatesNow()).toEqual({
				started: false,
				reason: "not_available",
			});
		} finally {
			development.mockRestore();
			override.mockRestore();
		}
	});
}
