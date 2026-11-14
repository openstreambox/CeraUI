import { afterEach, expect, test } from "bun:test";
import {
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { dnsCacheResolve } from "../modules/network/dns.ts";

const savedMockMode = process.env.MOCK_MODE;

afterEach(() => {
	resetMockState();
	stopMockService();
	if (savedMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMockMode;
});

// The unit preload's network guard records any real query for a public name
// and fails the test afterwards, so passing here also proves no query left.
test("a mock backend answers public names as refused without asking a resolver", async () => {
	process.env.MOCK_MODE = "true";
	initMockService("multi-modem-wifi");
	await expect(dnsCacheResolve("relay.mock-refusal.invalid")).rejects.toBe(
		"DNS query failed and no cached value is available",
	);
});

test("address literals still resolve to themselves under mocks", async () => {
	process.env.MOCK_MODE = "true";
	initMockService("multi-modem-wifi");
	expect(await dnsCacheResolve("127.0.0.1")).toEqual({
		addrs: ["127.0.0.1"],
		fromCache: false,
	});
});
