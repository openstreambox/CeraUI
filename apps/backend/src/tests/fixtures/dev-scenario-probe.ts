// Bundled in both build modes and run in both launch modes.
// Exercise handlers, upgrade admission and actual route registration.
import { call } from "@orpc/server";
import { initMockService, stopMockService } from "../../mocks/mock-service.ts";
import {
	devScenarioApplyProcedure,
	devScenarioResetProcedure,
	devScenarioStatusProcedure,
} from "../../rpc/procedures/dev.procedure.ts";
import type { RPCContext } from "../../rpc/types.ts";

initMockService("streaming-active");
const ws = {
	data: { isAuthenticated: true, lastActive: 0, scenarioDriver: true },
	send: () => 0,
} as unknown as RPCContext["ws"];
const context: RPCContext = {
	ws,
	isAuthenticated: () => true,
	authenticate: () => undefined,
	deauthenticate: () => undefined,
	markActive: () => undefined,
	getLastActive: () => 0,
	setSenderId: () => undefined,
	getSenderId: () => undefined,
	clearSenderId: () => undefined,
};
const apply = await call(
	devScenarioApplyProcedure,
	{ seed: 1, t_ms: 0, events: [] },
	{ context },
);
const reset = await call(devScenarioResetProcedure, undefined, { context });
const status = await call(devScenarioStatusProcedure, undefined, { context });
const handlers = [apply, reset, status].map((result) => result.success);
const { appRouter } = await import("../../rpc/router.ts");
const { permitsScenarioDriver, SCENARIO_DRIVER_HEADER } = await import(
	"../../rpc/scenario-driver-admission.ts"
);
const secret = "a".repeat(64);
const admission =
	process.env.NODE_ENV !== "production" &&
	permitsScenarioDriver(
		new Request("http://localhost/ws", {
			headers: { [SCENARIO_DRIVER_HEADER]: secret },
		}),
		secret,
	);
const routes = Object.hasOwn(appRouter, "dev");
stopMockService();
process.stdout.write(
	`${JSON.stringify({ apply, admission, routes, handlers })}\n`,
);
process.exit(0);
