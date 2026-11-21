import { describe, expect, it } from "bun:test";
import {
	createTailnetReachability,
	isTailnetAddress,
	type LocalApiFetch,
} from "./network-reachability.ts";

const PEER = { kind: "tailnet-peer", peer: "100.101.102.103" } as const;

function localApi(answer: { ok?: boolean; body?: unknown; throws?: boolean }) {
	const calls: Array<{ socket: string; path: string }> = [];
	const fetch: LocalApiFetch = async (socket, path) => {
		calls.push({ socket, path });
		if (answer.throws) throw new Error("connection refused");
		return { ok: answer.ok ?? true, json: async () => answer.body };
	};
	return { calls, fetch };
}

describe("tailnet addresses", () => {
	it("accepts only Tailscale's ranges", () => {
		for (const a of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"])
			expect(isTailnetAddress(a), a).toBe(true);
		for (const a of [
			"100.63.255.255",
			"100.128.0.1",
			"10.0.0.1",
			"fd7a:115c:a1e1::1",
			"127.0.0.1",
			"--help",
			"",
		])
			expect(isTailnetAddress(a), a).toBe(false);
	});
});

describe("testing the requester's own tailnet path", () => {
	it("asks tailscaled for a TSMP ping to exactly that peer", async () => {
		const api = localApi({ body: { IP: PEER.peer, LatencySeconds: 0.031 } });
		const reach = createTailnetReachability({
			exists: (p) => p === "/run/tailscale/tailscaled.sock",
			fetch: api.fetch,
		});
		expect(reach.available(PEER)).toBe(true);
		expect(await reach.probe(PEER)).toBe(true);
		expect(api.calls).toEqual([
			{
				socket: "/run/tailscale/tailscaled.sock",
				path: "/localapi/v0/ping?ip=100.101.102.103&type=TSMP",
			},
		]);
	});

	it("an error, a missing pong or a failed call is unreachable", async () => {
		for (const answer of [
			{ body: { Err: "timeout", LatencySeconds: 0 } },
			{ body: { Err: "no matching peer" } },
			{ body: {} },
			{ ok: false, body: { LatencySeconds: 0.01 } },
			{ throws: true },
		]) {
			const reach = createTailnetReachability({
				exists: () => true,
				fetch: localApi(answer).fetch,
			});
			expect(await reach.probe(PEER), JSON.stringify(answer)).toBe(false);
		}
	});

	it("without tailscaled, or for a peer outside the tailnet, there is nothing to test", async () => {
		const api = localApi({ body: { LatencySeconds: 0.01 } });
		const none = createTailnetReachability({
			exists: () => false,
			fetch: api.fetch,
		});
		expect(none.available(PEER)).toBe(false);
		expect(await none.probe(PEER)).toBe(false);
		const outside = createTailnetReachability({
			exists: () => true,
			fetch: api.fetch,
		});
		const lan = { kind: "tailnet-peer", peer: "192.0.2.7" } as const;
		expect(outside.available(lan)).toBe(false);
		expect(await outside.probe(lan)).toBe(false);
		expect(api.calls).toEqual([]);
	});
});
