import { expect, spyOn, test } from "bun:test";
import { pinMockClock, unpinMockClock } from "../mocks/mock-clock.ts";
import * as mocks from "../mocks/mock-service.ts";
import {
	resetSoftwareUpdateCheckRunner,
	setSoftwareUpdateCheckRunner,
} from "../modules/system/software-updates.ts";
import { defaultOrchestratorRuntimeDeps } from "../modules/system/update-orchestrator/runtime.ts";

test("mock scenarios keep repeated package discovery independent of host update effects", async () => {
	const priorMode = process.env.MOCK_MODE;
	process.env.MOCK_MODE = "true";
	mocks.initMockService("multi-modem-wifi");
	let calls = 0;
	setSoftwareUpdateCheckRunner(() => {
		calls++;
		return false;
	});
	try {
		// Repeated checks across a story must not inspect the host or emit a refusal.
		const runs = [];
		for (let run = 0; run < 2; run++) {
			const results = [];
			for (const [step, modemState] of [
				[0, "connected"],
				[15_000, "connected"],
				[30_000, "searching"],
				[90_000, "connected"],
				[120_000, "connected"],
			] as const) {
				pinMockClock(2048, step);
				await mocks.setMockModemState("1", modemState);

				const result = await defaultOrchestratorRuntimeDeps.runPackageCheck();
				expect(result).toBeNull();
				results.push(result);
			}
			runs.push(results);
		}
		expect(runs[0]).toEqual(runs[1]);
		expect(calls).toBe(0);
	} finally {
		resetSoftwareUpdateCheckRunner();
		unpinMockClock();
		mocks.resetMockState();
		if (priorMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = priorMode;
	}
});

test("real package discovery still reports a busy runner", async () => {
	const gate = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	let calls = 0;
	setSoftwareUpdateCheckRunner(() => {
		calls++;
		return false;
	});
	try {
		expect(await defaultOrchestratorRuntimeDeps.runPackageCheck()).toBe("busy");
		expect(calls).toBe(1);
	} finally {
		resetSoftwareUpdateCheckRunner();
		gate.mockRestore();
	}
});
