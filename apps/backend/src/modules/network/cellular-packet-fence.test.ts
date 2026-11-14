import { expect, test } from "bun:test";
import {
	cellularFenceDefinition,
	cellularFenceInventory,
	cellularFenceReplace,
	inspectCellularFence,
} from "./cellular-packet-fence.ts";

const fence = {
	owner: "a".repeat(64),
	slot: 1,
	source: "192.0.2.2",
	ifindex: 17,
	translated: false,
	dns: ["192.0.2.53"],
};
test("native fences select a kernel device while translated source slots fence every egress", () => {
	expect(cellularFenceDefinition(fence, "withdrawn")).toContain(
		"ip saddr 192.0.2.2 meta oif 17 counter drop",
	);
	expect(
		cellularFenceDefinition(
			{ ...fence, translated: true, source: "198.18.255.1" },
			"withdrawn",
		),
	).toContain("ip saddr 198.18.255.1 counter drop");
	const probe = cellularFenceDefinition(fence, "probe");
	expect(probe).toContain("tcp dport 443 return");
	expect(probe).toContain("ip daddr 192.0.2.53 udp dport 53 return");
	expect(probe).toContain("counter drop");
	expect(cellularFenceDefinition(fence, "ready")).not.toContain("counter drop");
	expect(
		cellularFenceReplace(fence, "withdrawn").startsWith(
			"delete table inet ceracell_1\n",
		),
	).toBe(true);
	expect(probe).not.toContain("flush ruleset");
});
test("invalid identities and interpolated addresses cannot produce nft input", () => {
	expect(() =>
		cellularFenceDefinition(
			{ ...fence, source: "192.0.2.2; flush ruleset" },
			"ready",
		),
	).toThrow();
	expect(() =>
		cellularFenceDefinition({ ...fence, ifindex: -1 }, "ready"),
	).toThrow();
});

test("only the complete expected firewall inventory grants mutation authority", () => {
	for (const mode of ["ready", "probe", "withdrawn"] as const) {
		const entries = cellularFenceInventory(fence, mode),
			raw = { nftables: [{ metainfo: { version: "synthetic" } }, ...entries] };
		expect(inspectCellularFence(fence, raw)).toBe(mode);
		expect(inspectCellularFence({ ...fence, ifindex: 18 }, raw)).toBe(
			mode === "ready" ? "ready" : "foreign",
		);
		expect(inspectCellularFence({ ...fence, owner: "b".repeat(64) }, raw)).toBe(
			"foreign",
		);
		expect(
			inspectCellularFence(fence, {
				nftables: [...entries, { set: { name: "foreign" } }],
			}),
		).toBe("foreign");
	}
	const inventory = cellularFenceInventory(fence, "withdrawn"),
		raw = JSON.parse(JSON.stringify({ nftables: inventory }));
	raw.nftables[0].table.handle = 99;
	raw.nftables[1].chain.handle = 100;
	raw.nftables[2].rule.handle = 101;
	raw.nftables[2].rule.expr.at(-2).counter = { packets: 12, bytes: 512 };
	expect(inspectCellularFence(fence, raw)).toBe("withdrawn");
	raw.nftables[1].chain.prio = -149;
	expect(inspectCellularFence(fence, raw)).toBe("foreign");
	expect(
		inspectCellularFence(fence, { nftables: inventory, extra: true }),
	).toBe("foreign");
});
