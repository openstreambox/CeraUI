import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	probeSourceBoundHttps,
	sourceBoundHttpsAvailable,
} from "../helpers/source-bound-https.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_CELLULAR_HTTPS_CHILD === "1";
const missing = ["unshare", "ip", "openssl"].some(
	(binary) => !Bun.which(binary),
);
const privilege =
	child || missing
		? undefined
		: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = missing || (privilege?.code !== 0 && !child);
if (unavailable && process.env.CERALIVE_REQUIRE_CELLULAR_NETNS === "1")
	throw new Error("Required cellular HTTPS namespace unavailable");
(unavailable ? test.skip : test)(
	"native HTTPS proves source plus device binding, verified TLS and bounded headers in a disconnected namespace",
	async () => {
		if (!child) {
			const result = await runTestCommand(
				[
					"unshare",
					"-Urn",
					process.execPath,
					"test",
					fileURLToPath(import.meta.url),
				],
				{
					env: {
						CERALIVE_CELLULAR_HTTPS_CHILD: "1",
						CELLULAR_HOST_NETNS: readlinkSync("/proc/self/ns/net"),
					},
				},
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			return;
		}
		if (
			!process.env.CELLULAR_HOST_NETNS ||
			readlinkSync("/proc/self/ns/net") === process.env.CELLULAR_HOST_NETNS
		)
			throw new Error("HTTPS fixture must not use the host namespace");
		const command = async (argv: string[]) => {
			const result = await runTestCommand(argv);
			if (result.code !== 0) throw new Error(result.stderr);
			return result.stdout;
		};
		await command(["ip", "link", "set", "lo", "up"]);
		await command(["ip", "addr", "add", "1.1.1.1/32", "dev", "lo"]);
		await command(["ip", "link", "add", "wwan0", "type", "dummy"]);
		await command(["ip", "link", "set", "wwan0", "up"]);
		await command(["ip", "addr", "add", "192.0.2.2/32", "dev", "wwan0"]);
		const dir = await mkdtemp(join(tmpdir(), "cellular-https-")),
			cert = join(dir, "ca.pem"),
			key = join(dir, "key.pem");
		try {
			await command([
				"openssl",
				"req",
				"-new",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:P-256",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=cellular-fixture",
				"-addext",
				"subjectAltName=IP:1.1.1.1",
			]);
			let requests = 0,
				largeHeaders = false;
			const server = Bun.serve({
				hostname: "1.1.1.1",
				port: 443,
				tls: { cert: Bun.file(cert), key: Bun.file(key) },
				fetch: () => {
					requests++;
					return new Response(null, {
						status: 301,
						headers: {
							location: "https://example.invalid/",
							...(largeHeaders ? { "x-fixture": "x".repeat(5000) } : {}),
						},
					});
				},
			});
			try {
				expect(await sourceBoundHttpsAvailable()).toBe(true);
				const path = { device: "lo", ifindex: 1, source: "127.0.0.2" },
					trust = { caFile: cert };
				expect(await probeSourceBoundHttps(path)).toBe("failed"); // Untrusted test CA.
				expect(requests).toBe(0);
				expect(await probeSourceBoundHttps(path, trust)).toBe("ok");
				expect(requests).toBe(1); // Redirect is never followed.
				expect(
					await probeSourceBoundHttps({ ...path, ifindex: 99999 }, trust),
				).toBe("unavailable");
				expect(
					await probeSourceBoundHttps(
						{ device: "no-such-link", source: "127.0.0.2" },
						trust,
					),
				).toBe("unavailable");
				expect(
					await probeSourceBoundHttps(
						{ device: "lo", source: "192.0.2.99" },
						trust,
					),
				).toBe("unavailable");
				expect(
					await probeSourceBoundHttps(
						{ device: "wwan0", source: "192.0.2.2" },
						trust,
					),
				).not.toBe("ok");
				expect(requests).toBe(1); // A working loopback path cannot hide the bad device.
				largeHeaders = true;
				expect(await probeSourceBoundHttps(path, trust)).toBe("failed");
				largeHeaders = false;
				expect(await probeSourceBoundHttps(path, trust)).toBe("ok");
			} finally {
				await server.stop(true);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	30_000,
);
