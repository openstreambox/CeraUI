import { expect, spyOn, test } from "bun:test";
import {
	getRemoteWebSocket,
	initRemote,
	isRemotePowerPeerAuthenticated,
} from "../modules/remote/remote.ts";
import * as sensors from "../modules/system/sensors.ts";
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

test("initial authenticated sensors keep hardware and allowlisted power fields only", async () => {
	const allowed = {
		"SoC temperature": "45.0 °C",
		Power: "Power data not available",
		"Bank A": "30.0 °C",
		"Bank B": "31.0 °C",
		"Reserve pack": "29.0 °C",
	};
	const snapshot = spyOn(sensors, "getSensors").mockReturnValue({
		...allowed,
		"Power sample": "4242",
	});
	try {
		await initRemote();
		const socket = getRemoteWebSocket();
		if (!(socket instanceof StubRemoteSocket)) throw Error("missing socket");
		socket.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
		const frames = socket.sent.map((frame) => JSON.parse(frame));
		expect(frames.filter((frame) => frame.sensors !== undefined)).toEqual([
			{ sensors: allowed },
		]);
	} finally {
		snapshot.mockRestore();
	}
});
