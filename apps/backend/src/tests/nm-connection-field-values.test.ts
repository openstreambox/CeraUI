import { afterEach, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import { nmConnGetFields } from "../modules/network/network-manager.ts";

let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	spy?.mockRestore();
	spy = undefined;
});
const UUID = "091ca73b-9f75-42bd-a737-2c447ca44533";

test("NM's terminal newline is not an additional scalar property", async () => {
	spy = spyOn(runner, "run").mockResolvedValue("device\nsim\n");
	expect(
		await nmConnGetFields(UUID, ["gsm.device-id", "gsm.sim-id"] as const),
	).toEqual(["device", "sim"]);
});

test("a legitimately empty final property survives the protocol terminator", async () => {
	spy = spyOn(runner, "run").mockResolvedValue("device\n\n");
	expect(
		await nmConnGetFields(UUID, ["gsm.device-id", "gsm.network-id"] as const),
	).toEqual(["device", ""]);
});

test("an unterminated/mock tuple's final blank is preserved", async () => {
	spy = spyOn(runner, "run").mockResolvedValue("device\n");
	expect(
		await nmConnGetFields(UUID, ["gsm.device-id", "gsm.network-id"] as const),
	).toEqual(["device", ""]);
});
