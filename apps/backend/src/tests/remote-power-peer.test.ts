import { expect, spyOn, test } from "bun:test";
import {
	getRemoteWebSocket,
	initRemote,
	isRemotePowerPeerAuthenticated,
} from "../modules/remote/remote.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import { useRemotePrivacySocket } from "./helpers/remote-privacy-socket.ts";
import { StubRemoteSocket } from "./helpers/status-client.ts";

usePrivacyConfig();
useRemotePrivacySocket();
test("power peer authentication belongs to the current socket and clears on close", async () => {
	expect(isRemotePowerPeerAuthenticated()).toBe(false);
	await initRemote();
	const first = getRemoteWebSocket();
	if (!(first instanceof StubRemoteSocket)) throw Error("missing socket");
	expect(isRemotePowerPeerAuthenticated()).toBe(false);
	first.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
	expect(isRemotePowerPeerAuthenticated()).toBe(true);
	// Replace the socket before its predecessor closes: authentication must not transfer.
	await initRemote();
	const second = getRemoteWebSocket();
	if (!(second instanceof StubRemoteSocket)) throw Error("missing new socket");
	expect(second).not.toBe(first);
	expect(isRemotePowerPeerAuthenticated()).toBe(false);
	second.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
	expect(isRemotePowerPeerAuthenticated()).toBe(true);
	const timers = spyOn(globalThis, "setTimeout");
	try {
		second.emit("close");
		expect(isRemotePowerPeerAuthenticated()).toBe(false);
		expect(getRemoteWebSocket()).toBeUndefined();
	} finally {
		for (const result of timers.mock.results)
			if (result.type === "return") clearTimeout(result.value);
		timers.mockRestore();
	}
});
