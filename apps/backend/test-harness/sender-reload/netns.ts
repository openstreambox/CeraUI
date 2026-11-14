import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	verifySenderReload,
	waitForReload,
} from "../../src/modules/streaming/sender-reload.ts";
import { senderSocketSources } from "../../src/modules/streaming/sender-sockets.ts";

// Invoke only through a root PID/mount/network gate, never against host networking.
assert.equal(process.env.CERALIVE_NETNS_ISOLATED, "1");
assert.equal(process.getuid?.(), 0);
const binary = process.env.SRTLA_SEND_BIN;
assert.ok(binary, "SRTLA_SEND_BIN must name the real sender under test");
const ip = (...args: string[]) => execFileSync("ip", args);
ip("link", "set", "lo", "up");
ip("link", "add", "mobile0", "type", "dummy");
ip("link", "set", "mobile0", "up");
ip("addr", "add", "192.0.2.1/24", "dev", "mobile0");
const dir = await mkdtemp(join(tmpdir(), "sender-adoption-"));
const ips = join(dir, "ips");
const map = join(dir, "map.json");
async function publish(address: string, generation: number) {
	const bytes = `${address}\n`;
	await writeFile(ips, bytes);
	await writeFile(
		map,
		JSON.stringify({
			schema_version: 1,
			generation,
			ips_file_sha256: createHash("sha256").update(bytes).digest("hex"),
			links: [{ link_id: "mobile", ip: address, iface: "mobile0" }],
		}),
		{ mode: 0o600 },
	);
}
await publish("192.0.2.1", 1);
const sender = Bun.spawn(
	[binary, "19001", "192.0.2.2", "19002", ips, "--bind-map", map],
	{ stdout: "ignore", stderr: "inherit" },
);
try {
	const ready = Date.now() + 5000;
	while (!(await senderSocketSources(sender.pid)).includes("192.0.2.1")) {
		assert.ok(Date.now() < ready, "sender must first bind the old address");
		await Bun.sleep(50);
	}
	ip("addr", "del", "192.0.2.1/24", "dev", "mobile0");
	ip("addr", "add", "192.0.2.3/24", "dev", "mobile0");
	await publish("192.0.2.3", 2);
	const signal = new AbortController();
	let signals = 0,
		restarts = 0,
		notices = 0;
	const started = Date.now();
	const result = await verifySenderReload(2, ["192.0.2.3"], {
		signal: signal.signal,
		now: Date.now,
		wait: (ms) => waitForReload(ms, signal.signal),
		hup: async () => {
			signals++;
			// Deliberately withhold the initial signal while claiming successful delivery.
			if (signals === 1) {
				assert.ok(
					(await senderSocketSources(sender.pid)).includes("192.0.2.1"),
				);
				return true;
			}
			sender.kill("SIGHUP");
			return true;
		},
		read: async () => ({ sources: await senderSocketSources(sender.pid) }),
		restart: async () => {
			restarts++;
			throw new Error("retry HUP should recover the same PID");
		},
		notice: () => {
			notices++;
		},
		log: (event, meta) => console.log(event, meta),
	});
	assert.equal(result, "adopted");
	assert.equal(signals, 2);
	assert.equal(restarts, 0);
	assert.equal(notices, 0);
	assert.ok(
		Date.now() - started < 13000,
		"withheld HUP must recover promptly after ten-second detection",
	);
	assert.deepEqual(await senderSocketSources(sender.pid), ["192.0.2.3"]);
	console.log(
		"PASS withheld-HUP adoption, same PID",
		sender.pid,
		Date.now() - started,
	);
} finally {
	sender.kill("SIGTERM");
	await sender.exited;
	await rm(dir, { recursive: true, force: true });
}
