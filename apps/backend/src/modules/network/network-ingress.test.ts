import { describe, expect, it } from "bun:test";
import { createIngressEvidence, ingressRuleset } from "./network-ingress.ts";

/** Shape of `nft -j list set` as printed by nftables 1.1.3 for a timed set. */
function nftSet(elems: Array<[string, number, string]>) {
	return JSON.stringify({
		nftables: [
			{ metainfo: { version: "1.1.3", json_schema_version: 1 } },
			{
				set: {
					family: "inet",
					name: "v4",
					table: "ceralive_ingress",
					elem: elems.map((concat) => ({
						elem: { val: { concat }, timeout: 600, expires: 599 },
					})),
				},
			},
		],
	});
}

describe("trusted arrival-interface evidence", () => {
	it("records the arrival interface in the kernel, not in the mark uplink steering owns", () => {
		const rules = ingressRuleset([80, 443]);
		expect(rules).toContain(
			"tcp dport { 80, 443 } ct state new add @v4 { ip saddr . tcp sport . iifname }",
		);
		expect(rules).toContain("add @v6 { ip6 saddr . tcp sport . iifname }");
		expect(rules).not.toContain("ct mark");
		expect(rules).not.toContain("meta mark");
		expect(() => ingressRuleset([])).toThrow();
		expect(() => ingressRuleset([80], "1d; drop")).toThrow();
	});
	it("returns the one interface the peer's connection arrived on", async () => {
		const calls: string[][] = [];
		const evidence = createIngressEvidence(async (bin, args) => {
			calls.push([bin, ...args]);
			return nftSet([
				["10.10.1.2", 39628, "lan0"],
				["10.10.2.2", 47014, "wan0"],
			]);
		});
		expect(await evidence.lookup("10.10.1.2", 39628)).toBe("lan0");
		expect(calls[0]).toEqual([
			"nft",
			"-j",
			"list",
			"set",
			"inet",
			"ceralive_ingress",
			"v4",
		]);
	});
	it("maps IPv4-mapped IPv6 peers to the IPv4 set", async () => {
		const sets: string[] = [];
		const evidence = createIngressEvidence(async (_bin, args) => {
			sets.push(args.at(-1) as string);
			return nftSet([["10.10.1.2", 1000, "lan0"]]);
		});
		expect(await evidence.lookup("::ffff:10.10.1.2", 1000)).toBe("lan0");
		expect(sets).toEqual(["v4"]);
	});
	it("is unknown with no record, with several interfaces, or without readable state", async () => {
		const none = createIngressEvidence(async () => nftSet([]));
		expect(await none.lookup("10.10.1.2", 1000)).toBeUndefined();
		// A reused or spoofed source port seen on two interfaces is ambiguous.
		const two = createIngressEvidence(async () =>
			nftSet([
				["10.10.1.2", 1000, "lan0"],
				["10.10.1.2", 1000, "wlan0"],
			]),
		);
		expect(await two.lookup("10.10.1.2", 1000)).toBeUndefined();
		const broken = createIngressEvidence(async () => {
			throw new Error("No such file or directory");
		});
		expect(await broken.lookup("10.10.1.2", 1000)).toBeUndefined();
		const garbage = createIngressEvidence(async () => "{");
		expect(await garbage.lookup("10.10.1.2", 1000)).toBeUndefined();
		expect(await none.lookup("10.10.1.2", 0)).toBeUndefined();
	});
	it("never matches another peer port or address", async () => {
		const evidence = createIngressEvidence(async () =>
			nftSet([["10.10.1.2", 1000, "lan0"]]),
		);
		expect(await evidence.lookup("10.10.1.2", 1001)).toBeUndefined();
		expect(await evidence.lookup("10.10.1.3", 1000)).toBeUndefined();
	});
});
