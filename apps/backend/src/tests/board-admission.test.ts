import { afterEach, expect, spyOn, test } from "bun:test";
import {
	mintStubDeviceControlToken,
	verifyDeviceControlToken,
} from "../modules/pairing/device-token.ts";
import { initControlChannel } from "../modules/remote-control/channel.ts";
import { boardAdmissionDeps } from "../modules/system/board-capabilities.ts";
import { defaultDeviceDetectionDeps } from "../modules/system/device-detection.ts";
import {
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateRunner,
	runUpdateDiscoveryAndReport,
	setAptReachabilityProbeForTest,
	setSoftwareUpdateRunner,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";

const saved = { ...process.env };
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = saved.NODE_ENV;
	if (saved.MOCK_MODE === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = saved.MOCK_MODE;
	if (saved.CERALIVE_DEVICE_TYPE === undefined)
		delete process.env.CERALIVE_DEVICE_TYPE;
	else process.env.CERALIVE_DEVICE_TYPE = saved.CERALIVE_DEVICE_TYPE;
	resetSoftwareUpdateRunner();
	resetAptReachabilityProbeForTest();
	if (saved.PASETO_PUBLIC_KEY === undefined)
		delete process.env.PASETO_PUBLIC_KEY;
	else process.env.PASETO_PUBLIC_KEY = saved.PASETO_PUBLIC_KEY;
});
for (const record of [
	'ID=ceralive\nBOARD=example\nFAMILY=future\nCAPABILITIES=""\n',
	'ID=ceralive\n BOARD=example\n FAMILY=future\n CAPABILITIES=""\n',
]) {
	test(`denied board has no control or update effects: ${JSON.stringify(record)}`, async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		const asyncRead = spyOn(
			defaultDeviceDetectionDeps,
			"readCeraliveRelease",
		).mockResolvedValue(record);
		const syncRead = spyOn(boardAdmissionDeps, "readRelease").mockReturnValue(
			record,
		);
		restores.push(
			() => asyncRead.mockRestore(),
			() => syncRead.mockRestore(),
		);
		let effects = 0;
		await initControlChannel({
			canDial: () => true,
			createSocket: () => {
				effects++;
				throw new Error("unexpected dial");
			},
			resolveEndpoint: () => {
				effects++;
				throw new Error("unexpected endpoint");
			},
		});
		setSoftwareUpdateRunner(() => {
			effects++;
			return { started: true };
		});
		setAptReachabilityProbeForTest(async () => {
			effects++;
			throw new Error("unexpected network");
		});
		expect(startSoftwareUpdate()).toEqual({
			started: false,
			reason: "updates_disabled",
		});
		expect(triggerManualUpdateCheck()).toBe(false);
		expect(await runUpdateDiscoveryAndReport()).toBe("discovery_failed");
		const runtime = await import(
			"../modules/system/update-orchestrator/runtime.ts"
		);
		expect(
			await runtime.defaultOrchestratorRuntimeDeps.isOsStageReady?.(),
		).toBe(false);
		expect(
			await runtime.defaultOrchestratorRuntimeDeps.isUpdateAdmissionReady?.(),
		).toBe(false);
		expect(
			await runtime.defaultOrchestratorRuntimeDeps.restartStale(true, false),
		).toBe(false);
		await expect(
			runtime.defaultOrchestratorRuntimeDeps.stageOs({} as never, () => {}),
		).rejects.toThrow("updates_disabled");
		await expect(
			runtime.defaultOrchestratorRuntimeDeps.startSlotSync(),
		).rejects.toThrow("updates_disabled");
		expect((await runtime.checkUpdatesNow()).started).toBe(false);
		for (const scope of ["packages", "os", "kernel"] as const)
			expect((await runtime.installUpdatesNow({ scope })).started).toBe(false);
		expect(effects).toBe(0);
	});
}
test("production cannot opt into unsigned control authentication", () => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.PASETO_PUBLIC_KEY;
	const token = mintStubDeviceControlToken({
		deviceId: "test-device",
		tenantId: "test-tenant",
		serial: "TEST0001",
		jti: "test-jti",
		now: Date.now(),
	});

	expect(
		verifyDeviceControlToken(token, undefined, {
			requireVerifiedControl: false,
		}),
	).toBeNull();
});

test("ingest RPC uses network-ingest independently of client internet", async () => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	const { call } = await import("@orpc/server");
	const { setNetworkIngestEnabledProcedure } = await import(
		"../rpc/procedures/network.procedure.ts"
	);
	const { defaultNetworkIngestControlDeps: deps } = await import(
		"../modules/network/network-ingest-control.ts"
	);
	const { runtimeConfigSchema } = await import("../helpers/config-schemas.ts");
	const config = runtimeConfigSchema.parse({});
	const actions: string[][] = [];
	for (const [key, value] of Object.entries({
		getConfig: () => config,
		saveConfig: () => {},
		systemctl: async (args: string[]) => {
			actions.push(args);
			return { stdout: "", stderr: "" };
		},
		isActive: async () => false,
		readMediamtxSrt: async () => true,
		srtUnitPresent: async () => false,
		refreshAndBroadcast: async () => {},
		broadcastSources: () => {},
	})) {
		const spy = spyOn(deps, key as keyof typeof deps).mockImplementation(
			value as never,
		);
		restores.push(() => spy.mockRestore());
	}
	const read = spyOn(defaultDeviceDetectionDeps, "readCeraliveRelease");
	restores.push(() => read.mockRestore());
	const context = {
		isAuthenticated: () => true,
		markActive: () => {},
		ws: { data: { isAuthenticated: true } },
	};
	for (const capability of ["client-internet", "network-ingest"]) {
		read.mockResolvedValue(
			`ID=ceralive\nBOARD=example\nFAMILY=future\nCAPABILITIES="${capability}"\n`,
		);
		const result = await call(
			setNetworkIngestEnabledProcedure,
			{ protocol: "srt", enabled: true },
			{ context: context as never },
		);
		expect(result.success).toBe(capability === "network-ingest");
		expect(actions.length).toBe(capability === "network-ingest" ? 1 : 0);
	}
});

test("unrecognized production host without a record never dials", async () => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	for (const key of [
		"readCeraliveRelease",
		"readDeviceTreeCompatible",
		"readDeviceTreeModel",
		"readDmiProductName",
		"readDmiBoardName",
	] as const) {
		const spy = spyOn(defaultDeviceDetectionDeps, key).mockResolvedValue("");
		restores.push(() => spy.mockRestore());
	}
	let dials = 0;
	await initControlChannel({
		canDial: () => true,
		resolveEndpoint: () => {
			dials++;
			throw new Error("unexpected dial");
		},
	});
	expect(dials).toBe(0);
});
