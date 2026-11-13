import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
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
		).toEqual([]);
	});
	test.each(["2", 2.5, null, -1, 0, true, Number.MAX_SAFE_INTEGER + 1])(
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
