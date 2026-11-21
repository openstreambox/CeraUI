import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import {
	createReachability,
	parseTarget,
	type ReachabilityTarget,
	tcpConnect,
} from "./network-reachability.ts";

describe("probe targets", () => {
	it("parses URLs and host:port, defaulting the port by scheme", () => {
		expect(parseTarget("wss://hub.example.net/ws")).toEqual([
			{ host: "hub.example.net", port: 443 },
		]);
		expect(parseTarget("ws://relay.example.net:8080/x")).toEqual([
			{ host: "relay.example.net", port: 8080 },
		]);
		expect(parseTarget("relay.example.net:7000")).toEqual([
			{ host: "relay.example.net", port: 7000 },
		]);
		expect(parseTarget("ws://[2001:db8::1]:9000")).toEqual([
			{ host: "2001:db8::1", port: 9000 },
		]);
		for (const bad of [undefined, "", "  ", "ws://", "::::"])
			expect(parseTarget(bad), String(bad)).toEqual([]);
	});
});

describe("the box's outside reachability", () => {
	it("one fresh connection to any endpoint is enough; duplicates are probed once", async () => {
		const tried: string[] = [];
		const reach = createReachability({
			targets: () => [
				{ host: "a.example", port: 443 },
				{ host: "b.example", port: 443 },
				{ host: "a.example", port: 443 },
			],
			connector: async (target: ReachabilityTarget) => {
				tried.push(target.host);
				return target.host === "b.example";
			},
		});
		expect(await reach.available()).toBe(true);
		expect(await reach.probe()).toBe(true);
		expect(tried.sort()).toEqual(["a.example", "b.example"]);
	});

	it("no endpoint reachable, or a connector that throws, is unreachable", async () => {
		const reach = createReachability({
			targets: () => [{ host: "a.example", port: 443 }],
			connector: async () => {
				throw new Error("ENETUNREACH");
			},
		});
		expect(await reach.probe()).toBe(false);
	});

	it("nothing to probe is not available, and never reachable", async () => {
		const reach = createReachability({ targets: async () => [] });
		expect(await reach.available()).toBe(false);
		expect(await reach.probe()).toBe(false);
		const broken = createReachability({
			targets: async () => {
				throw new Error("config unreadable");
			},
		});
		expect(await broken.available()).toBe(false);
	});

	it("a real TCP connect succeeds against a listener and fails on a closed port", async () => {
		const server = createServer((socket) => socket.end());
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		const port = (server.address() as { port: number }).port;
		expect(await tcpConnect({ host: "127.0.0.1", port }, 1_000)).toBe(true);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(await tcpConnect({ host: "127.0.0.1", port }, 1_000)).toBe(false);
	});
});
