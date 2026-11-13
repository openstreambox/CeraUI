/**
 * Scenario driver admission (dev only). A WebSocket whose upgrade carries the
 * driver secret may call `dev.scenario.*`; see mocks/scenario-control.ts.
 * server.ts consults this only behind a literal NODE_ENV check, so a
 * production build drops it.
 */

/** Upgrade header that marks a socket as the scenario driver. */
export const SCENARIO_DRIVER_HEADER = "x-ceraui-scenario-secret";

const SCENARIO_DRIVER_SECRET = /^[0-9a-f]{64}$/;

/**
 * Whether an upgrade request carries the scenario driver's secret. The secret
 * is a 64-hex value the driver passes to the backend's environment
 * (`CERAUI_SCENARIO_SECRET`). Browsers cannot set upgrade headers, so a page
 * never becomes the driver. No configured secret: no driver at all.
 */
export function permitsScenarioDriver(
	request: Request,
	expectedSecret: string | undefined,
): boolean {
	return (
		expectedSecret !== undefined &&
		SCENARIO_DRIVER_SECRET.test(expectedSecret) &&
		request.headers.get(SCENARIO_DRIVER_HEADER) === expectedSecret
	);
}
