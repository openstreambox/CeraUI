// Bundled by dev-scenario-production-build.test.ts with NODE_ENV inlined as
// production or development, then run with a development runtime
// environment. It reports what the bundle does, not what the runtime env says.
// (The router is left out: importing it starts the update gates, which need a
// device's setup. Its dev routes are checked in the shipped bundle instead.)
import { call } from "@orpc/server";
import { initMockService, stopMockService } from "../../mocks/mock-service.ts";
import { devScenarioApplyProcedure } from "../../rpc/procedures/dev.procedure.ts";
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
stopMockService();
process.stdout.write(`${JSON.stringify({ apply })}\n`);
process.exit(0);
