import { runtimeAllowsDevelopment } from "../runtime-mode.ts";
/**
 * Dev-only Procedures
 *
 * `dev.emit` triggers an arbitrary backend broadcast on demand so a test client
 * (Playwright) can inject a conflicting `config`/`status` echo at a known time —
 * deterministic QA of the field-lock race-condition fix.
 *
 * Delivery is scoped to the CALLING socket (`only: context.ws`). The echo is for
 * the requesting page alone, preventing an injected state (for example, a
 * `sim_lock` that auto-opens a dialog) from reaching another authenticated page
 * attached to the same worker backend.
 *
 * HARD-GATED: this procedure is only registered when `NODE_ENV !== 'production'`
 * (see ../router.ts). It must never be reachable in a production build.
 */

import {
	type DevScenarioOutput,
	devEmitInputSchema,
	devEmitOutputSchema,
	devScenarioApplyInputSchema,
	devScenarioEmptyInputSchema,
	devScenarioOutputSchema,
	wifiScanInputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { mockWifiRadios, shouldUseMocks } from "../../mocks/mock-service.ts";
import { rebindMockWifi } from "../../mocks/providers/wifi-incarnation.ts";
import { broadcastWifiState } from "../../modules/wifi/wifi.ts";
import { broadcast } from "../events.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Emit an arbitrary broadcast to the calling authenticated client (dev-only).
 * Mirrors the real broadcast envelope (e.g. broadcastMsg("config", config)),
 * but uses a caller-supplied type and payload with socket-scoped delivery.
 */
export const devEmitProcedure = authedProcedure
	.input(devEmitInputSchema)
	.output(devEmitOutputSchema)
	.handler(({ input, context }) => {
		// Defense-in-depth: never emit in production even if somehow registered.
		if (process.env.NODE_ENV === "production" || !runtimeAllowsDevelopment()) {
			return { success: false };
		}

		broadcast(input.type, input.payload, { only: context.ws });
		return { success: true };
	});

/** Rotate only the mock wire token so E2E can observe a replacement radio. */
export const devRebindWifiProcedure = authedProcedure
	.input(wifiScanInputSchema)
	.output(devEmitOutputSchema)
	.handler(({ input }) => {
		if (
			process.env.NODE_ENV === "production" ||
			!runtimeAllowsDevelopment() ||
			!shouldUseMocks()
		) {
			return { success: false };
		}
		const radio = mockWifiRadios.find(
			(row, index) =>
				row.device === input.device || String(index) === input.device,
		);
		if (!radio || !rebindMockWifi(radio.device)) return { success: false };
		broadcastWifiState();
		return { success: true };
	});

/**
 * `dev.scenario.*`: scripted mock scenarios (mocks/scenario-control.ts). Three
 * gates on every call, beyond registration outside production: not a
 * production process, the backend runs on mocks, and the calling socket is the
 * scenario driver (its upgrade carried the driver secret, which a browser page
 * cannot send). The production check stays a literal first statement in each
 * handler: a production build inlines it, the rest of the handler becomes
 * unreachable, and the scenario control, imported inside the handler after
 * that check, drops out of the bundle
 * (dev-scenario-production-build.test.ts).
 */
const PRODUCTION_REFUSAL = { success: false, refused: "production" } as const;

function scenarioRefusal(
	context: RPCContext,
): DevScenarioOutput["refused"] | undefined {
	if (!shouldUseMocks()) return "not_mock";
	if (context.ws.data.scenarioDriver !== true) return "not_driver";
	return undefined;
}

export const devScenarioApplyProcedure = authedProcedure
	.input(devScenarioApplyInputSchema)
	.output(devScenarioOutputSchema)
	.handler(async ({ input, context }) => {
		if (process.env.NODE_ENV === "production" || !runtimeAllowsDevelopment())
			return PRODUCTION_REFUSAL;
		const refused = scenarioRefusal(context);
		if (refused) return { success: false, refused };
		const { applyScenarioStep } = await import(
			"../../mocks/scenario-control.ts"
		);
		return { success: true, status: await applyScenarioStep(input) };
	});

export const devScenarioResetProcedure = authedProcedure
	.input(devScenarioEmptyInputSchema)
	.output(devScenarioOutputSchema)
	.handler(async ({ context }) => {
		if (process.env.NODE_ENV === "production" || !runtimeAllowsDevelopment())
			return PRODUCTION_REFUSAL;
		const refused = scenarioRefusal(context);
		if (refused) return { success: false, refused };
		const { resetScenario } = await import("../../mocks/scenario-control.ts");
		return { success: true, status: resetScenario() };
	});

export const devScenarioStatusProcedure = authedProcedure
	.input(devScenarioEmptyInputSchema)
	.output(devScenarioOutputSchema)
	.handler(async ({ context }) => {
		if (process.env.NODE_ENV === "production" || !runtimeAllowsDevelopment())
			return PRODUCTION_REFUSAL;
		const refused = scenarioRefusal(context);
		if (refused) return { success: false, refused };
		const { getScenarioStatus } = await import(
			"../../mocks/scenario-control.ts"
		);
		return { success: true, status: getScenarioStatus() };
	});
