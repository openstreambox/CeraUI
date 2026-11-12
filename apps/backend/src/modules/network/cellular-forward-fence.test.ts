import { expect, test } from "bun:test";
import type { CellularFirewallIO } from "./cellular-firewall.ts";
import {
	CellularForwardFence,
	cellularForwardDefinition,
	cellularForwardInventory,
} from "./cellular-forward-fence.ts";

const input = {
	owner: "a".repeat(64),
	slot: 1,
	tunIndex: 18,
	physicalIndex: 17,
	mapped: "2001:db8:1::1234",
	nat64: "2001:db8:64::/96",
	isolatePhysical: true,
};
test("forward confinement selects both directions, admits router errors and leaves an existing shared policy outside its selectors", () => {
	const active = cellularForwardDefinition(input, "active");
	expect(active).toContain(
		"meta iif 18 meta oif 17 ip6 saddr 2001:db8:1::1234 ip6 daddr 2001:db8:64::/96 return",
	);
	expect(active).toContain(
		"meta iif 17 meta oif 18 ip6 daddr 2001:db8:1::1234 return",
	);
	expect(active).toContain("meta nfproto ipv6 meta iif 17 counter drop");
	expect(
		cellularForwardDefinition({ ...input, isolatePhysical: false }, "active"),
	).not.toContain("meta nfproto ipv6 meta iif 17 counter drop");
	expect(cellularForwardDefinition(input, "withdrawn")).not.toContain("return");
	expect(() =>
		cellularForwardDefinition({ ...input, tunIndex: 17 }, "active"),
	).toThrow();
	expect(() =>
		cellularForwardDefinition(
			{ ...input, mapped: "2001:db8::1%wwan0" },
			"active",
		),
	).toThrow();
});
test("full forward-table authority rejects foreign edits, old device indices and uncertain names", async () => {
	let raw: unknown,
		current = true;
	const writes: string[] = [];
	const io: CellularFirewallIO = {
		current: async () => current,
		index: async (name) =>
			name === "wwan0" ? 17 : name === "cclat1" ? 18 : undefined,
		read: async (argv) =>
			JSON.stringify(
				argv.at(-1) === "tables"
					? {
							nftables: raw
								? [{ table: { family: "inet", name: "ceracell_forward_1" } }]
								: [],
						}
					: raw,
			),
		write: async (text) => {
			writes.push(text);
			raw = text.includes("table inet ceracell_forward_1 {")
				? {
						nftables: cellularForwardInventory(
							input,
							text.includes(" return") ? "active" : "withdrawn",
						),
					}
				: undefined;
		},
	};
	const fence = new CellularForwardFence(input, io);
	await fence.create("withdrawn");
	await fence.transition("active");
	expect(await fence.inspect()).toBe("active");
	const named = JSON.parse(
		JSON.stringify({ nftables: cellularForwardInventory(input, "active") }),
	);
	for (const row of named.nftables)
		for (const expr of row.rule?.expr ?? []) {
			if (["iif", "oif"].includes(expr.match?.left?.meta?.key))
				expr.match.right = expr.match.right === 17 ? "wwan0" : "cclat1";
		}
	raw = named;
	expect(await fence.inspect()).toBe("active");
	expect(
		await new CellularForwardFence(
			{ ...input, physicalIndex: 19 },
			io,
		).remove(),
	).toBe(false);
	expect(
		await new CellularForwardFence(input, {
			...io,
			index: async () => undefined,
		}).remove(),
	).toBe(false);
	const before = writes.length;
	raw = {
		nftables: [
			...cellularForwardInventory(input, "active"),
			{ chain: { name: "operator" } },
		],
	};
	expect(await fence.remove()).toBe(false);
	expect(writes.length).toBe(before);
	raw = named;
	current = false;
	await expect(fence.transition("active")).rejects.toThrow("ownership changed");
	await fence.transition("withdrawn");
	expect(await fence.remove()).toBe(true);
});
