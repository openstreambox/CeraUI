import { expect, test } from "bun:test";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
	assertLoopbackHost,
	assertSafeCommand,
	takeSafetyViolations,
} from "../../../../scripts/test-safety.ts";

test("empty safety allowlist rejects name signals, absolute paths, shell wrappers and unit mutations", () => {
	for (const command of [
		["killall", "srtla_send"],
		["timeout", "10", "killall", "srtla_send"],
		["/usr/bin/pkill", "-x", "ffmpeg"],
		["kill", "123"],
		["bash", "-c", "killall ceracoder"],
		["sudo", "systemctl", "restart", "ssh"],
		["systemctl", "--user", "stop", "example.service"],
	])
		expect(() => assertSafeCommand(command)).toThrow(
			"Unsafe test process command",
		);
	expect(takeSafetyViolations()).toHaveLength(7);
	assertSafeCommand(["systemctl", "show", "example.service"]);
	assertSafeCommand(["printf", "killall"]);
	assertSafeCommand([
		"env",
		"VALUE=1",
		"bash",
		"-c",
		'exec "$@"',
		"fixture",
		"python3",
		"-c",
		'print("kill")',
	]);
});

test("loopback guard rejects external hosts and permits local fixtures", () => {
	for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]"])
		assertLoopbackHost(host);
	for (const host of ["example.com", "192.0.2.1", "0.0.0.0"])
		expect(() => assertLoopbackHost(host)).toThrow("Unsafe test outbound");
	expect(takeSafetyViolations()).toHaveLength(3);
});

test("real Bun spawn boundary rejects even a swallowed name signal", () => {
	expect(() => Bun.spawn(["killall", "srtla_send"])).toThrow(
		"Unsafe test process command",
	);
	expect(() =>
		Bun.spawnSync(["systemctl", "restart", "example.service"]),
	).toThrow("Unsafe test process command");
	expect(takeSafetyViolations()).toHaveLength(2);
});

test("development backend guard terminates even when an outbound rejection is caught", async () => {
	const preload = new URL("../../../../scripts/dev-safety.ts", import.meta.url)
		.pathname;
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			preload,
			"--eval",
			`
   const net = await import('node:net');
   try { net.connect(9, '192.0.2.1'); } catch {}
   setTimeout(() => {}, 1000);
 `,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(await child.exited).toBe(1);
	expect(await new Response(child.stderr).text()).toContain(
		"Unsafe test outbound connection",
	);
});

test("Node named process imports share the guarded spawn boundary", () => {
	for (const execute of [
		() => spawnSync("killall", ["srtla_send"]),
		() => execFileSync("systemctl", ["stop", "example.service"]),
		() => execSync("pkill -x ffmpeg"),
	]) {
		try {
			execute();
		} catch {
			/* Node APIs may throw or return a spawn error. */
		}
		expect(takeSafetyViolations()).toHaveLength(1);
	}
});
