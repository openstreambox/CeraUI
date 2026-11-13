import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildSrtlaSendArgs } from "@ceraui/srtla-send/sender";
import { resolveBindMapArgs } from "../modules/streaming/bind-map-spawn.ts";
import {
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import {
	classifyCapabilityDocument,
	probeSrtlaSenderCapabilities,
} from "../modules/streaming/srtla-capabilities.ts";

const fixture = (name: string) =>
	join(import.meta.dir, "fixtures", `sender-${name}.ts`);

describe("sender contract discovery", () => {
	test("a contract-2 process reports all strict capabilities without changing launch policy", async () => {
		const result = await probeSrtlaSenderCapabilities(fixture("contract2"));
		expect(result).toEqual({
			bindMap: true,
			bindMapSchemaVersion: 1,
			bindMapRequired: true,
			bindMapRequiredEmptyReload: true,
			bindMapContract: 2,
		});
		expect(
			await resolveBindMapArgs("unused", {
				getBond: () => ({
					entries: [],
					publication: {
						ok: true,
						generation: 1,
						ipsFileSha256: "a".repeat(64),
						changed: true,
						sidecarPath: "/tmp/map.json",
					},
				}),
				probe: async () => result,
				announce: () => {},
			}),
		).toEqual(["--bind-map", "/tmp/map.json"]);
	});
	test("an old process retains the exact legacy argument vector", async () => {
		const result = await probeSrtlaSenderCapabilities(fixture("legacy"));
		expect(result).toEqual({ bindMap: false, reason: "nonzero-exit" });
		const fragment = await resolveBindMapArgs("unused", {
			getBond: () => ({
				entries: [],
				publication: {
					ok: true,
					generation: 1,
					ipsFileSha256: "a".repeat(64),
					changed: true,
					sidecarPath: "/tmp/map.json",
				},
			}),
			probe: async () => result,
			announce: () => {},
		});
		expect([
			"/usr/bin/srtla_send",
			...buildSrtlaSendArgs({
				listenPort: 5000,
				srtlaHost: "192.0.2.10",
				srtlaPort: 5001,
				ipsFile: "/tmp/ips",
				statsFile: "/tmp/stats",
				controlSocket: "/tmp/control",
			}),
			...fragment,
		]).toEqual([
			"/usr/bin/srtla_send",
			"5000",
			"192.0.2.10",
			"5001",
			"/tmp/ips",
			"--conn-timeout-ms",
			"15000",
			"--stats-file",
			"/tmp/stats",
			"--control-socket",
			"/tmp/control",
		]);
	});
	test.each(["2", 1, 3, 2.5, null, -1, 0, true, Number.MAX_SAFE_INTEGER + 1])(
		"does not accept malformed contract version %p",
		(version) => {
			const result = classifyCapabilityDocument(
				0,
				JSON.stringify({
					capabilities: {
						bind_map: true,
						bind_map_contract: version,
						bind_map_required: "true",
						bind_map_required_empty_reload: 1,
					},
				}),
			);
			expect(result).toEqual({ bindMap: true, bindMapSchemaVersion: 1 });
		},
	);
});

test("empty publication has exact identity; failed no-op retry requests a reload", async () => {
	resetBindMapWriter();
	let fail = false;
	const files = new Map<string, string>();
	const deps = {
		ipsFile: "/tmp/ips",
		sidecarFile: "/tmp/sidecar",
		writeFile: async (path: string, bytes: string) => {
			if (fail && path.startsWith("/tmp/sidecar"))
				throw new Error("write failed");
			files.set(path, bytes);
		},
		renameFile: async (from: string, to: string) => {
			files.set(to, files.get(from) ?? "");
		},
		removeFile: async (path: string) => {
			files.delete(path);
		},
	};
	const first = await publishBondMapping([], deps);
	expect(first.ok && first.ipsFileSha256).toBe(
		createHash("sha256").update("").digest("hex"),
	);
	expect(await publishBondMapping([], deps)).toEqual({
		...first,
		changed: false,
	});
	fail = true;
	expect((await publishBondMapping([], deps)).ok).toBe(false);
	fail = false;
	const retry = await publishBondMapping([], deps);
	expect(retry.ok && retry.generation).toBe(2);
	expect(retry.changed).toBe(true);
	const moved = await publishBondMapping([], {
		...deps,
		sidecarFile: "/tmp/other",
	});
	expect(moved.ok && moved.generation).toBe(3);
	expect(moved.changed).toBe(true);
});

test("a failed IP write invalidates stable publication reuse", async () => {
	resetBindMapWriter();
	let fail = false;
	const deps = {
		ipsFile: "/tmp/ips",
		sidecarFile: "/tmp/sidecar",
		writeFile: async () => {
			if (fail) throw new Error("write failed");
		},
		renameFile: async () => {},
		removeFile: async () => {},
	};
	expect((await publishBondMapping([], deps)).ok).toBe(true);
	fail = true;
	expect((await publishBondMapping([], deps)).ok).toBe(false);
	fail = false;
	const retry = await publishBondMapping([], deps);
	expect(retry.changed).toBe(true);
	expect(retry.ok && retry.generation).toBe(2);
});

test("publication captures caller-owned rows before asynchronous file writes", async () => {
	resetBindMapWriter();
	const row = { ip: "192.0.2.1", iface: "eth0", linkId: "lnk_example" };
	const entries = [row];
	let sidecar = "";
	const deps = {
		ipsFile: "/tmp/ips",
		sidecarFile: "/tmp/sidecar",
		writeFile: async (path: string, bytes: string) => {
			if (path.startsWith("/tmp/ips")) row.iface = "eth9";
			else sidecar = bytes;
		},
		renameFile: async () => {},
		removeFile: async () => {},
	};
	const first = await publishBondMapping(entries, deps);
	expect(JSON.parse(sidecar).links[0].iface).toBe("eth0");
	const next = await publishBondMapping(entries, deps);
	expect(next.changed).toBe(true);
	expect(first.ok && next.ok && next.generation > first.generation).toBe(true);
});

test("overlapping same-IP X/Y/X publications commit distinct identities and reloads", async () => {
	resetBindMapWriter();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let hold = false;
	const documents: {
		generation: number;
		ips_file_sha256: string;
		links: { iface: string }[];
	}[] = [];
	const deps = {
		ipsFile: "/tmp/ips",
		sidecarFile: "/tmp/map",
		writeFile: async (path: string, bytes: string) => {
			if (hold && path.startsWith("/tmp/ips")) {
				hold = false;
				entered.resolve();
				await release.promise;
			}
			if (path.startsWith("/tmp/map")) documents.push(JSON.parse(bytes));
		},
		renameFile: async () => {},
		removeFile: async () => {},
	};
	const x = [{ ip: "192.0.2.1", iface: "eth0", linkId: "lnk_example" }];
	await publishBondMapping(x, deps);
	hold = true;
	const p1 = publishBondMapping(
		[{ ...x[0], ip: "192.0.2.1", iface: "wwan0", linkId: "lnk_example" }],
		deps,
	);
	await entered.promise;
	const p2 = publishBondMapping(x, deps);
	release.resolve();
	const [first, second] = await Promise.all([p1, p2]);
	expect(documents.map((row) => [row.generation, row.links[0]?.iface])).toEqual(
		[
			[1, "eth0"],
			[2, "wwan0"],
			[3, "eth0"],
		],
	);
	expect(first.ok && first.generation).toBe(documents[1]?.generation);
	expect(second.ok && second.generation).toBe(documents[2]?.generation);
	expect(first.changed).toBe(true);
	expect(second.changed).toBe(true);
	expect(new Set(documents.map((row) => row.ips_file_sha256)).size).toBe(1);
	expect(await publishBondMapping(x, deps)).toEqual({
		...second,
		changed: false,
	});
});

test("a rejected publication does not strand later queued publications", async () => {
	resetBindMapWriter();
	const deps = {
		ipsFile: "/tmp/ips",
		sidecarFile: "/tmp/map",
		writeFile: async () => {},
		renameFile: async () => {},
		removeFile: async () => {},
	};
	await publishBondMapping([], deps);
	const broken = publishBondMapping([], {
		...deps,
		get ipsFile(): string {
			throw new Error("unavailable path");
		},
	});
	const next = publishBondMapping([], deps);
	await expect(broken).rejects.toThrow("unavailable path");
	expect((await next).ok).toBe(true);
});
