import { expect, test } from "bun:test";
import {
	ownedPauseTable,
	PauseLease,
	pauseRules,
} from "../modules/network/heat-client-pause.ts";

const target = {
	iface: "ap0",
	address: "192.0.2.3",
	phone: false,
	management: false,
	ipv6Absent: true,
} as const;
test("only a bounded per-client forward lease is generated", () => {
	const rules = pauseRules(target);
	expect(rules).toContain("hook forward");
	expect(rules).toContain("timeout 5s");
	expect(rules).toContain("iifname . ip saddr");
	expect(rules).toContain("oifname . ip daddr");
	expect(rules).not.toContain("hook input");
	expect(rules).not.toContain("hook output");
});
test("unsafe selectors never reach nft", () => {
	for (const t of [
		{ ...target, iface: 'ap0"; drop;' },
		{ ...target, address: "0.0.0.0/0" },
		{ ...target, address: "192.0.2.999" },
	])
		expect(() => pauseRules(t)).toThrow();
});
test("fresh revalidation occurs after ownership read", async () => {
	let allowed = true;
	const writes: string[] = [];
	const owner = new PauseLease({
		owns: async () => {
			allowed = false;
			return true;
		},
		apply: async (s: string) => {
			writes.push(s);
		},
	});
	await owner.update(() => (allowed ? target : null));
	expect(writes.every((s) => !s.includes("192.0.2.3"))).toBe(true);
});
test("recovery clears the lease and foreign ownership refuses all writes", async () => {
	const writes: string[] = [];
	let owned = true;
	const owner = new PauseLease({
		owns: async () => owned,
		apply: async (s: string) => {
			writes.push(s);
		},
	});
	await owner.update(() => target);
	expect(writes.at(-1)).toContain("192.0.2.3");
	await owner.update(() => null);
	expect(writes.at(-1)).not.toContain("192.0.2.3");
	owned = false;
	const count = writes.length;
	await expect(owner.update(() => target)).rejects.toThrow();
	expect(writes).toHaveLength(count);
});

test("phone, management and unknown IPv6 bindings are refused", () => {
	for (const t of [
		{ ...target, phone: true },
		{ ...target, management: true },
		{ ...target, ipv6Absent: false },
	])
		expect(() => pauseRules(t as unknown as typeof target)).toThrow();
});

test("restart clears retained state before accepting a new selector", async () => {
	const writes: string[] = [];
	const owner = new PauseLease({
		owns: async () => true,
		apply: async (s: string) => {
			writes.push(s);
		},
	});
	await owner.update(() => target);
	expect(writes[0]).not.toContain("192.0.2.3");
	expect(writes[1]).toContain("192.0.2.3");
	await owner.stop();
	await owner.update(() => target);
	expect(writes.at(-1)).not.toContain("192.0.2.3");
});
test("failed publication can retry without losing serialized cleanup", async () => {
	let fail = true;
	const writes: string[] = [];
	const owner = new PauseLease({
		owns: async () => true,
		apply: async (s: string) => {
			if (fail) {
				fail = false;
				throw new Error("nft refused");
			}
			writes.push(s);
		},
	});
	await expect(owner.update(() => target)).rejects.toThrow("nft refused");
	await owner.clear();
	expect(writes.every((s) => !s.includes("192.0.2.3"))).toBe(true);
});
test("unrecognized inventory and foreign objects fail closed", () => {
	expect(ownedPauseTable(null)).toBe(false);
	expect(ownedPauseTable({ nftables: [] })).toBe(false);
	expect(
		ownedPauseTable({
			nftables: [
				{
					table: {
						family: "inet",
						name: "ceralive_heat_client",
						comment: "foreign",
					},
				},
			],
		}),
	).toBe(false);
	const table = {
		table: {
			family: "inet",
			name: "ceralive_heat_client",
			comment: "ceralive-heat-client-v1",
		},
	};
	expect(ownedPauseTable({ nftables: [table] })).toBe(true);
	expect(
		ownedPauseTable({
			nftables: [
				table,
				{ map: { table: "ceralive_heat_client", name: "foreign" } },
			],
		}),
	).toBe(false);
});

test.skipIf(process.env.CERALIVE_NETNS_ISOLATED !== "1")(
	"kernel lease isolates two veth clients and expires after owner crash",
	async () => {
		const { mkdtemp, rm, readlink } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { netnsPrivilegePrefix, netnsUnshareFlag } = await import(
			"./helpers/netns-privilege.ts"
		);
		const fixture = new URL(
			"./fixtures/heat-client-pause-netns.sh",
			import.meta.url,
		).pathname;
		const driver = new URL(
			"./fixtures/heat-client-pause-driver.ts",
			import.meta.url,
		).pathname;
		const dir = await mkdtemp(join(tmpdir(), "client-pause-"));
		try {
			const prefix = await netnsPrivilegePrefix(fixture);
			const proc = Bun.spawn(
				[
					...prefix,
					"unshare",
					netnsUnshareFlag(prefix),
					"--mount",
					"bash",
					fixture,
					driver,
					join(dir, "ready"),
					await readlink("/proc/self/ns/net"),
					await readlink("/proc/self/ns/mnt"),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code, err).toBe(0);
			expect(out).toContain("PASS two clients");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	30_000,
);

test("malformed retained inventory refuses without throwing", () => {
	for (const row of [
		null,
		7,
		"table",
		{},
		{ table: null },
		{
			table: {
				family: "inet",
				name: "ceralive_heat_client",
				comment: "ceralive-heat-client-v1",
			},
			chain: {},
		},
	])
		expect(ownedPauseTable({ nftables: [row] })).toBe(false);
});
test("stop invalidates queued restrictions before their asynchronous reads finish", async () => {
	const writes: string[] = [];
	const owner = new PauseLease({
		owns: async () => true,
		apply: async (s: string) => {
			writes.push(s);
		},
	});
	await Promise.all([
		owner.update(() => target),
		owner.update(() => target),
		owner.stop(),
	]);
	expect(writes.every((s) => !s.includes("192.0.2.3"))).toBe(true);
});
