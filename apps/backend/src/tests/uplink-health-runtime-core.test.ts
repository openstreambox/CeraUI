import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import { UplinkHealthRuntimeCore } from "../modules/network/uplink-health/runtime-core.ts";

it("constructs isolated runtimes without running ports and rejects late probe success", async () => {
	let finish!: (value: "success") => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let calls = 0;
	const interfaces = { wan0: { ip: "192.0.2.1", error: 0 } } as Record<
		string,
		NetworkInterface
	>;
	const deps = {
		now: () => 100,
		interfaces: () => interfaces,
		streaming: () => false,
		telemetry: () => undefined,
		resolveTarget: async () => "192.0.2.2",
		probe: async () => {
			calls++;
			entered();
			return new Promise<"success">((resolve) => {
				finish = resolve;
			});
		},
		publish: () => {
			calls++;
		},
		exclusionReason: (entry: NetworkInterface | undefined) =>
			entry?.ip ? undefined : "no address",
		candidates: () =>
			interfaces.wan0?.ip
				? [
						{
							name: "wan0",
							ip: interfaces.wan0.ip,
							binding: { kind: "device" as const, ifname: "wan0" },
						},
					]
				: [],
		identity: () => ({ kind: "ethernet" as const }),
	};
	const runtime = new UplinkHealthRuntimeCore(deps);
	const independent = new UplinkHealthRuntimeCore(deps);
	expect(calls).toBe(0);
	const pending = runtime.tick();
	await started;
	delete interfaces.wan0?.ip;
	await runtime.tick();
	const before = structuredClone(runtime.records());
	expect(before).toMatchObject([{ state: "down", reason: "definitive_loss" }]);
	finish("success");
	await pending;
	expect(runtime.records()).toEqual(before);
	expect(independent.records()).toEqual([]);
});

it("imports the core without setup and preserves production setup validation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "health-runtime-"));
	const run = async (module: string, construct: boolean) => {
		const url = new URL(
			`../modules/network/uplink-health/${module}.ts`,
			import.meta.url,
		).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`try { const m = await import(${JSON.stringify(url)}); ${construct ? "new m.UplinkHealthRuntime();" : ""} console.log("ok"); } catch (error) { console.log(JSON.stringify({ name: error.name, issues: error.issues })); }`,
			],
			{ cwd, stdout: "pipe", stderr: "pipe" },
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		return output.trim();
	};
	try {
		expect(await run("runtime-core", false)).toBe("ok");
		const result = JSON.parse(
			(await run("runtime", true))
				.split("\n")
				.find((line) => line.startsWith('{"name":')) ?? "null",
		);
		expect(result.name).toBe("ZodError");
		expect(result.issues).toEqual([
			{
				expected: "object",
				code: "invalid_type",
				path: [],
				message: "Invalid input: expected object, received undefined",
			},
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
