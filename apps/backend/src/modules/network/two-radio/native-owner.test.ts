import { expect, test } from "bun:test";
import { type NativeDeps, NativeOwner } from "./native-owner.ts";
import { config, state } from "./synthetic.fixture.ts";

function fake() {
	const tables = new Map<string, Record<string, unknown>[]>();
	const rules: Record<string, unknown>[] = [];
	let unsettled = false;
	const calls: string[][] = [];
	const deps: NativeDeps = {
		run: async (f) => f(),
		observe: async (r) => {
			if (unsettled) throw new Error("NM activating");
			return state(r);
		},
		runner: async (bin, input) => {
			expect(bin).toBe("ip");
			const args = input.filter((a) => a !== "-N" && a !== "-4" && a !== "-j");
			calls.push(args);
			if (args[0] === "rule") {
				if (args[1] === "show") return JSON.stringify(rules);
				const val = (k: string) => args[args.indexOf(k) + 1];
				rules.push({
					priority: Number(val("priority")),
					src: "all",
					table: val("lookup"),
					protocol: "186",
					...(args.includes("oif")
						? { oif: val("oif") }
						: { fwmark: val("fwmark") }),
				});
				return "";
			}
			const table = args[args.indexOf("table") + 1] as string;
			const rows = tables.get(table) ?? [];
			tables.set(table, rows);
			if (args[1] === "show") return JSON.stringify(rows);
			const dst = args[args.indexOf("table") + 2] as string;
			const row = {
				dst: dst.replace(/\/32$/, ""),
				dev: args[args.indexOf("dev") + 1],
				protocol: "186",
				flags: [],
				...(args.includes("via")
					? { gateway: args[args.indexOf("via") + 1] }
					: { scope: "link" }),
			};
			if (args[1] === "replace") {
				const i = rows.findIndex((x) => x.dst === row.dst);
				if (i >= 0) rows.splice(i, 1);
			}
			rows.push(row);
			return "";
		},
	};
	return {
		deps,
		tables,
		rules,
		calls,
		setUnsettled: (v: boolean) => {
			unsettled = v;
		},
	};
}
test("native plan retains both associations, reads back policy and never touches defaults", async () => {
	const f = fake(),
		owner = new NativeOwner(config, f.deps),
		signal = AbortSignal.timeout(1000);
	await owner.prepare(false, signal);
	const identity = state("b").identity;
	expect(
		await owner.apply(
			{
				identity,
				effect: {
					action: "promote",
					radio: "b",
					epoch: identity.epoch,
					operation: 1,
					command: 2,
					restore: null,
				},
			},
			"scope",
			signal,
		),
	).toBe(true);
	await owner.verify(signal, "b");
	expect(f.calls.filter((a) => a[1] === "replace")).toHaveLength(1);
	expect(f.calls.flat()).not.toContain("default");
	expect(f.rules).toHaveLength(3);
	for (const action of ["demote", "disconnect"] as const)
		expect(
			await owner.apply(
				{
					identity: state("a").identity,
					effect: {
						action,
						radio: "a",
						epoch: state("a").identity.epoch,
						operation: 1,
						command: 3,
						restore: null,
					},
				},
				"scope",
				signal,
			),
		).toBe(true);
	await owner.restore({ radio: "a", identity: state("a").identity }, signal);
	await owner.verify(signal, "a");
});
test("native admission refuses foreign ownership, delayed NM, changed identity and route drift", async () => {
	const f = fake(),
		owner = new NativeOwner(config, f.deps),
		signal = AbortSignal.timeout(1000);
	f.setUnsettled(true);
	await expect(owner.prepare(false, signal)).rejects.toThrow();
	f.setUnsettled(false);
	const fresh = AbortSignal.timeout(1000);
	await owner.prepare(false, fresh);
	await expect(owner.prepare(false, fresh)).rejects.toThrow("Foreign");
	const rows = f.tables.get(String(config.table)) as Record<string, unknown>[];
	rows.push({ dst: "default", dev: "foreign", protocol: "186" });
	await expect(owner.verify(fresh)).rejects.toThrow("readback");
	expect(rows.at(-1)?.dev).toBe("foreign");
});

test("native NM observer brackets activation and physical identity without fallback to interface names", async () => {
	const { mkdtemp, mkdir, symlink, writeFile, rm } = await import(
		"node:fs/promises"
	);
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { nativeObserver } = await import("./native-owner.ts");
	const root = await mkdtemp(join(tmpdir(), "nm-observer-"));
	try {
		const sys = join(root, "net");
		const phy = join(root, "phy-a");
		const device = join(root, "usb-a");
		await mkdir(join(sys, "renamed"), { recursive: true });
		await mkdir(phy);
		await mkdir(device);
		await symlink(phy, join(sys, "renamed", "phy80211"));
		await symlink(device, join(sys, "renamed", "device"));
		await writeFile(join(phy, "macaddress"), config.radios.a.permanentMac);
		await writeFile(join(sys, "renamed", "ifindex"), "9");
		const c = structuredClone(config);
		c.radios.a.usbPath = device;
		let query = 0,
			mutate = false;
		const observe = nativeObserver(
			c,
			async (bin) => {
				if (bin === "nmcli") {
					query++;
					return `100 (connected)\n/org/active/${mutate ? query : 1}\n198.18.1.2/24\n198.18.1.1\n`;
				}
				if (bin === "iw") return `Connected to ${config.radios.a.permanentMac}`;
				if (bin === "ip") return JSON.stringify([{ dst: "198.18.1.0/24" }]);
				throw new Error("mutation attempted");
			},
			sys,
			async () => "synthetic-bus|synthetic-owner",
		);
		const identity = await observe("a", AbortSignal.timeout(1000));
		expect(identity.ifname).toBe("renamed");
		expect(identity.identity.epoch.routeGeneration).toBe(9);
		mutate = true;
		await expect(observe("a", AbortSignal.timeout(1000))).rejects.toThrow(
			"Unsettled",
		);
		mutate = false;
		await writeFile(join(phy, "macaddress"), config.radios.b.permanentMac);
		await expect(observe("a", AbortSignal.timeout(1000))).rejects.toThrow(
			"identity unavailable",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("NM settling retries until confirmed; an expiring observation cannot acknowledge", async () => {
	const f = fake();
	let remaining = 2;
	const observe = f.deps.observe;
	f.deps.observe = async (r, signal) => {
		if (remaining-- > 0) throw new Error("NM still associating");
		return observe(r, signal);
	};
	const owner = new NativeOwner(config, f.deps);
	await owner.prepare(false, AbortSignal.timeout(1000));
	expect(remaining).toBeLessThan(0);
	const writes = f.calls.filter((x) =>
		["add", "replace"].includes(x[1] ?? ""),
	).length;
	f.setUnsettled(true);
	await expect(
		owner.apply(
			{
				identity: state("b").identity,
				effect: {
					radio: "b",
					epoch: state("b").identity.epoch,
					action: "promote",
					operation: 1,
					command: 1,
					restore: null,
				},
			},
			"scope",
			AbortSignal.timeout(100),
		),
	).rejects.toThrow();
	expect(
		f.calls.filter((x) => ["add", "replace"].includes(x[1] ?? "")).length,
	).toBe(writes);
});

test("retained-holder startup refuses a different live carrying path", async () => {
	const { TwoRadioCoordinator } = await import("./coordinator.ts");
	const f = fake(),
		owner = new NativeOwner(config, f.deps);
	await owner.prepare(false, AbortSignal.timeout(1000));
	const coordinator = new TwoRadioCoordinator(
		owner,
		{
			load: async () => ({
				version: 1,
				session: "previous",
				holder: { radio: "b", identity: state("b").identity },
				operations: [],
			}),
			save: async () => {},
		},
		{
			resolve: () => null,
			absent: () => false,
			bound: () => false,
			traffic: () => false,
		},
		"current",
		() => 0,
	);
	await expect(coordinator.start()).rejects.toThrow("Holder readback");
	await expect(
		coordinator.submit(
			JSON.stringify({ version: 1, at: 0, event: { type: "swap" } }),
		),
	).rejects.toThrow("reconciliation required");
});
