import { expect, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import { getRemoteWebSocket } from "../modules/remote/remote.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";

usePrivacyConfig();
useRemotePrivacySocket();

test("an expired remote socket closes and schedules a reconnect", async () => {
	const intervals = spyOn(globalThis, "setInterval");
	const timeouts = spyOn(globalThis, "setTimeout");
	const socket = await authenticateRemote();
	const closed = spyOn(socket, "emit");
	const keepalive = intervals.mock.calls.find(
		([callback, delay]) =>
			callback.name === "remoteKeepalive" && delay === 1000,
	)?.[0];
	if (typeof keepalive !== "function") throw new Error("missing keepalive");
	spyOn(time, "getms").mockReturnValue(Number.MAX_SAFE_INTEGER);

	expect(() => keepalive()).not.toThrow();
	expect(socket.readyState).toBe(3);
	expect(closed).toHaveBeenCalledWith("close");
	expect(getRemoteWebSocket()).toBeUndefined();
	keepalive();
	socket.terminate();
	expect(closed).toHaveBeenCalledTimes(1);
	expect(
		timeouts.mock.calls.some(
			([fn, ms]) => fn.name === "remoteConnect" && ms === 1000,
		),
	).toBe(true);
});
