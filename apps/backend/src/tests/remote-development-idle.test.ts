import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import * as dns from "../modules/network/dns.ts";
import { initRemote } from "../modules/remote/remote.ts";
import { setup } from "../modules/setup.ts";
import { StubRemoteSocket } from "./helpers/status-client.ts";

const dialled: string[] = [];
class RecordingSocket extends StubRemoteSocket {
	terminate(): void {}
	constructor(url: string) {
		super();
		dialled.push(url);
	}
}
mock.module("ws", () => ({ default: RecordingSocket }));

const saved = {
	key: getConfig().remote_key,
	host: setup.remote_endpoint_host,
	mockMode: process.env.MOCK_MODE,
};
let intervalSpy: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
let timeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
let resolveSpy: ReturnType<typeof spyOn<typeof dns, "dnsCacheResolve">>;

beforeEach(() => {
	dialled.length = 0;
	process.env.MOCK_MODE = "true";
	// The mock seed holds a pairing key; it must never be offered to a real endpoint.
	getConfig().remote_key = "mock-pairing-key";
	setup.remote_endpoint_host = undefined;
	resolveSpy = spyOn(dns, "dnsCacheResolve").mockResolvedValue({
		addrs: ["127.0.0.1"],
		fromCache: false,
	});
	intervalSpy = spyOn(globalThis, "setInterval");
	timeoutSpy = spyOn(globalThis, "setTimeout");
});

afterEach(() => {
	for (const spy of [intervalSpy, timeoutSpy])
		for (const result of spy.mock.results)
			if (result.type === "return") clearTimeout(result.value);
	getConfig().remote_key = saved.key;
	setup.remote_endpoint_host = saved.host;
	if (saved.mockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = saved.mockMode;
	mock.restore();
});

test("under mocks the remote client neither resolves nor dials the provider", async () => {
	await initRemote();
	expect(resolveSpy).not.toHaveBeenCalled();
	expect(dialled).toEqual([]);
});

test("under mocks a loopback remote endpoint is the only one dialled", async () => {
	setup.remote_endpoint_host = "127.0.0.1";
	await initRemote();
	expect(resolveSpy).toHaveBeenCalledWith("127.0.0.1");
	expect(dialled).toHaveLength(1);
	expect(new URL(dialled[0] ?? "").hostname).toBe("127.0.0.1");
});
