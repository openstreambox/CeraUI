import { expect, test } from "bun:test";
import { createClatStatusReader } from "./clat-status.ts";

const snapshot = {
	schema_version: 1,
	interface: "cell0",
	tun: "clat3",
	prefix: "64:ff9b::/96",
	ipv4: "10.254.0.3",
	state: "up",
	last_error: "refresh diagnostic",
	updated_at: 100,
};
test("async refresh coalesces service probes and hot reads never spawn or read files", async () => {
	let probes = 0,
		reads = 0,
		now = 100_000;
	const reader = createClatStatusReader({
		now: () => now,
		active: async () => {
			probes++;
			return true;
		},
		read: async (path) => {
			reads++;
			return path.endsWith("ifindex") ? "3" : JSON.stringify(snapshot);
		},
		tunExists: async () => true,
	});
	await Promise.all([reader.refresh(["cell0"]), reader.refresh(["cell0"])]);
	const count = reads;
	for (let i = 0; i < 10; i++)
		expect(reader.read("cell0")?.iface).toBe("clat3");
	await reader.refresh(["cell0"]);
	expect(probes).toBe(1);
	expect(reads).toBe(count);
	now = 132_000;
	expect(reader.read("cell0")).toBeUndefined();
});
test("refresh fails closed on inactive service, missing TUN and malformed files", async () => {
	for (const failure of ["service", "tun", "json", "missing"]) {
		const reader = createClatStatusReader({
			now: () => 100_000,
			active: async () => failure !== "service",
			tunExists: async () => failure !== "tun",
			read: async (path) => {
				if (failure === "missing") throw Error("missing");
				return path.endsWith("ifindex")
					? "3"
					: failure === "json"
						? "{"
						: JSON.stringify(snapshot);
			},
		});
		await reader.refresh(["cell0", "../bad"]);
		expect(reader.read("cell0")).toBeUndefined();
		expect(reader.read("../bad")).toBeUndefined();
	}
});

test("multiple links share one bounded liveness result and withdraw on the next refresh", async () => {
	let now = 100_000,
		active = true,
		probes = 0;
	const reader = createClatStatusReader({
		now: () => now,
		active: async () => {
			probes++;
			return active;
		},
		read: async (path) => {
			if (path.endsWith("ifindex")) return path.includes("cell0") ? "3" : "4";
			const second = path.endsWith("4.json");
			return JSON.stringify({
				...snapshot,
				interface: second ? "cell1" : "cell0",
				tun: second ? "clat4" : "clat3",
				ipv4: second ? "10.254.0.4" : "10.254.0.3",
			});
		},
		tunExists: async () => true,
	});
	await reader.refresh(["cell0", "cell1"]);
	expect(probes).toBe(1);
	expect(reader.read("cell0")?.iface).toBe("clat3");
	expect(reader.read("cell1")?.iface).toBe("clat4");
	active = false;
	now += 2000;
	await reader.refresh(["cell0", "cell1"]);
	expect(probes).toBe(2);
	expect(reader.read("cell0")).toBeUndefined();
	expect(reader.read("cell1")).toBeUndefined();
});

test("the production reader uses async files and the registered bounded runner", async () => {
	const fs = await import("node:fs/promises");
	const runner = await import("../../helpers/run.ts");
	const { spyOn } = await import("bun:test");
	const { refreshClatStatus, readClatPath } = await import("./clat-status.ts");
	const read = spyOn(fs, "readFile").mockImplementation(
		async (path) =>
			(String(path).endsWith("ifindex")
				? "3"
				: JSON.stringify({
						...snapshot,
						updated_at: Math.floor(Date.now() / 1000),
					})) as never,
	);
	const tun = spyOn(fs, "access").mockResolvedValue(undefined);
	const active = spyOn(runner, "run").mockResolvedValue("active\n");
	try {
		await refreshClatStatus(["cell0"]);
		expect(active).toHaveBeenCalledWith(
			"systemctl",
			["is-active", "ceralive-clat.service"],
			{ timeout: 500 },
		);
		const reads = read.mock.calls.length;
		for (let i = 0; i < 10; i++)
			expect(readClatPath("cell0")?.iface).toBe("clat3");
		expect(active).toHaveBeenCalledTimes(1);
		expect(read.mock.calls.length).toBe(reads);
	} finally {
		read.mockRestore();
		tun.mockRestore();
		active.mockRestore();
	}
});
