import { afterEach, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import {
	getMockState,
	initMockService,
	mockModems,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getGsmConnections,
	resetGsmConnections,
} from "../modules/modems/gsm-connections.ts";

const previousMode = process.env.MOCK_MODE;
afterEach(() => {
	stopMockService();
	resetGsmConnections();
	if (previousMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = previousMode;
});
test("saved mock GSM profiles cross the real NM reader with exact device and SIM binding", async () => {
	process.env.MOCK_MODE = "true";
	initMockService("multi-modem-wifi");
	resetGsmConnections();
	const run = spyOn(runner, "run").mockRejectedValue(
		new Error("Mock fixture escaped to host"),
	);
	try {
		const profiles = await getGsmConnections();
		const modem = mockModems[0];
		if (!modem) throw new Error("Fixture missing modem");
		expect(Object.keys(profiles?.byUuid ?? {}).length).toBeGreaterThan(0);
		const saved = profiles?.byDevice[modem.imei.slice(0, 8)]?.[modem.iccid];
		expect(saved?.uuid).toBe("c3110000-0000-4000-8000-000000000001");
		expect(saved?.apn).toBe(getMockState().modemConfigs.get("0")?.apn);
		expect(saved?.autoconfig).toBe(false);
		expect(run).not.toHaveBeenCalled();
	} finally {
		run.mockRestore();
	}
});
