import { expect, it } from "vitest";
import { rpcCallTimeoutMs } from "./rpc-timeouts";

it("allows boot sweep, pre-open sweep, open rollback and retirement", () => {
	expect(rpcCallTimeoutMs("wifi.portal")).toBeGreaterThanOrEqual(
		4 * 120000 + 2 * 9000 + 3 * 2000 + 6000,
	);
});
