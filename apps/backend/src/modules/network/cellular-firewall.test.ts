import { expect, test } from "bun:test";
import {
	CellularFirewall,
	type CellularFirewallIO,
} from "./cellular-firewall.ts";
import {
	type CellularFenceMode,
	cellularFenceInventory,
} from "./cellular-packet-fence.ts";

const input = {
	owner: "a".repeat(64),
	slot: 1,
	source: "192.0.2.2",
	ifindex: 17,
	translated: false,
	dns: ["192.0.2.53"],
};
function fixture() {
	let raw: unknown,
		current = true;
	let index: number | "absent" | undefined = 17;
	const writes: string[] = [];
	const io: CellularFirewallIO = {
		current: async () => current,
		index: async () => index,
		read: async (argv) =>
			JSON.stringify(
				argv.at(-1) === "tables"
					? {
							nftables: raw
								? [{ table: { family: "inet", name: "ceracell_1" } }]
								: [],
						}
					: raw,
			),
		write: async (text) => {
			writes.push(text);
			const mode: CellularFenceMode = text.includes("tcp dport")
				? "probe"
				: text.includes("counter drop")
					? "withdrawn"
					: "ready";
			raw = text.includes("table inet ceracell_1 {")
				? { nftables: cellularFenceInventory(input, mode) }
				: undefined;
		},
	};
	return {
		firewall: new CellularFirewall(input, io),
		writes,
		set: (value: unknown) => {
			raw = value;
		},
		index: (value: number | "absent" | undefined) => {
			index = value;
		},
		current: (value: boolean) => {
			current = value;
		},
	};
}
test("birth refuses matching residue; foreign edits retain the firewall and withdrawal can fence a lost USB device", async () => {
	const f = fixture();
	f.set({ nftables: cellularFenceInventory(input, "ready") });
	await expect(f.firewall.create("probe")).rejects.toThrow("birth slot");
	expect(f.writes).toEqual([]);
	f.set(undefined);
	await f.firewall.create("probe");
	await f.firewall.transition("ready");
	f.current(false);
	await expect(f.firewall.transition("probe")).rejects.toThrow(
		"ownership changed",
	);
	await f.firewall.transition("withdrawn");
	expect(await f.firewall.inspect()).toBe("withdrawn");
	const foreign = {
		nftables: [
			...cellularFenceInventory(input, "withdrawn"),
			{ chain: { name: "operator" } },
		],
	};
	f.set(foreign);
	const before = f.writes.length;
	expect(await f.firewall.remove()).toBe(false);
	await expect(f.firewall.transition("withdrawn")).rejects.toThrow(
		"ownership changed",
	);
	expect(f.writes.length).toBe(before);
	f.set({ nftables: cellularFenceInventory(input, "withdrawn") });
	expect(await f.firewall.remove()).toBe(true);
});
test("a vanished decimal oif requires positive numeric-name absence; unknown and conflicting names retain the fence", async () => {
	const f = fixture(),
		raw = JSON.parse(
			JSON.stringify({ nftables: cellularFenceInventory(input, "withdrawn") }),
		);
	raw.nftables[2].rule.expr[1].match.right = "17";
	f.set(raw);
	f.index("absent");
	expect(await f.firewall.inspect()).toBe("withdrawn");
	f.index(undefined);
	expect(await f.firewall.remove()).toBe(false);
	f.index(18); // An actual interface called "17" cannot be mistaken for index 17.
	expect(await f.firewall.remove()).toBe(false);
	expect(f.writes).toEqual([]);
});
test("named JSON oifs require fresh kernel-index evidence; a reused name grants no cleanup", async () => {
	const f = fixture(),
		raw = JSON.parse(
			JSON.stringify({ nftables: cellularFenceInventory(input, "withdrawn") }),
		);
	raw.nftables[2].rule.expr[1].match.right = "wwan0";
	f.set(raw);
	expect(await f.firewall.inspect()).toBe("withdrawn");
	f.index(18);
	expect(await f.firewall.remove()).toBe(false);
	expect(f.writes).toEqual([]);
});
test("an unreadable inventory is never treated as absence", async () => {
	const io: CellularFirewallIO = {
		current: async () => true,
		index: async () => 17,
		read: async () => "{}",
		write: async () => {
			throw new Error("must not write");
		},
	};
	await expect(new CellularFirewall(input, io).create("probe")).rejects.toThrow(
		"Unknown firewall inventory",
	);
});
