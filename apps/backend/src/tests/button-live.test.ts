import { expect, spyOn, test } from "bun:test";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { powerButton } from "../modules/system/power-button-client.ts";

test("stream transitions publish advisory live state without awaiting an absent service", async () => {
	const publish = spyOn(powerButton, "setLive").mockResolvedValue(false);
	updateStatus(true);
	await new Promise((r) => setTimeout(r, 10));
	expect(publish).toHaveBeenLastCalledWith(true);
	updateStatus(false);
	await new Promise((r) => setTimeout(r, 10));
	expect(publish).toHaveBeenLastCalledWith(false);
	publish.mockRestore();
});
