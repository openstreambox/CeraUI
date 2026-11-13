import { expect, test } from "bun:test";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		["systemctl", "daemon-reload"],
		["systemctl", "try-reload-or-restart", "example.service"],
	])
		expect(() => assertSafeCommand(command)).toThrow(
			"Unsafe test process command",
		);
	expect(takeSafetyViolations()).toHaveLength(9);
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

// Review bypasses. Every command names a process that cannot exist and every
// host is TEST-NET or .invalid, so an unguarded baseline run harms nothing.
const NO_SUCH = "ceraui-test-no-such-process";

test("shell positional exec, env -S, xargs and wrapped shells reach the guard", () => {
	for (const command of [
		["bash", "-c", 'exec "$@"', "x", "killall", NO_SUCH],
		["sh", "-c", '"$0" "$1"', "pkill", NO_SUCH],
		["env", "-S", `killall ${NO_SUCH}`],
		["env", `--split-string=killall ${NO_SUCH}`],
		["xargs", "killall"],
		["busybox", "killall", NO_SUCH],
		["find", "/nonexistent", "-exec", "kill", "{}", ";"],
		["timeout", "-s", "KILL", "10", "killall", NO_SUCH],
	])
		expect(() => assertSafeCommand(command)).toThrow(
			"Unsafe test process command",
		);
	expect(takeSafetyViolations()).toHaveLength(8);
	// Data after the wrapped executable is not a command.
	assertSafeCommand(["setsid", "--wait", "python3", "-c", "pass", "kill", "0"]);
	assertSafeCommand(["timeout", "5", "printf", "%s", "killall"]);
});

test("a symlink to a signal command is judged by its target", () => {
	const real = Bun.which("killall") ?? Bun.which("kill");
	if (!real) return;
	const dir = mkdtempSync(join(tmpdir(), "ceraui-safety-link-"));
	try {
		const link = join(dir, "harmless-name");
		symlinkSync(realpathSync(real), link);
		expect(() => assertSafeCommand([link, NO_SUCH])).toThrow(
			"Unsafe test process command",
		);
		expect(takeSafetyViolations()).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a shell script file that signals by absolute path is rejected before it runs", () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-safety-script-"));
	try {
		const script = join(dir, "k.sh");
		writeFileSync(script, `#!/bin/sh\n/usr/bin/killall ${NO_SUCH}\n`);
		expect(() => assertSafeCommand(["sh", script])).toThrow(
			"Unsafe test process command",
		);
		expect(takeSafetyViolations()).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Bun shell commands are checked like sh -c", () => {
	expect(() => Bun.$`killall ${NO_SUCH}`.quiet()).toThrow(
		"Unsafe test process command",
	);
	expect(
		() => Bun.$.nothrow()`systemctl --user stop ${NO_SUCH}.service`,
	).toThrow("Unsafe test process command");
	expect(takeSafetyViolations()).toHaveLength(2);
});

test("by-name calls the spawn layer cannot see hit the recording PATH stubs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-safety-stub-"));
	try {
		const script = join(dir, "k.sh");
		writeFileSync(script, `#!/bin/sh\nkillall ${NO_SUCH}\n`);
		const viaScript = Bun.spawnSync(["sh", script], { stderr: "pipe" });
		const viaPython = spawnSync("python3", [
			"-c",
			`import subprocess; raise SystemExit(subprocess.call(["pkill", "-x", "${NO_SUCH}"]))`,
		]);
		expect(viaScript.exitCode).toBe(97);
		if (!viaPython.error) expect(viaPython.status).toBe(97);
		const recorded = takeSafetyViolations();
		expect(recorded.some((line) => line.includes(`killall ${NO_SUCH}`))).toBe(
			true,
		);
		expect(recorded.every((line) => line.includes("reached a PATH stub"))).toBe(
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("process.kill reaches only this process and the processes it spawned", async () => {
	// SIGCONT is a no-op on a running process, so a baseline without the guard is harmless.
	expect(() => process.kill(process.ppid, "SIGCONT")).toThrow(
		"Unsafe test signal",
	);
	expect(() => process.kill(-1, "SIGCONT")).toThrow("Unsafe test signal");
	expect(takeSafetyViolations()).toHaveLength(2);
	const child = Bun.spawn(["sleep", "30"]);
	process.kill(child.pid, 0);
	process.kill(child.pid, "SIGTERM");
	await child.exited;
	process.kill(process.pid, 0);
	expect(takeSafetyViolations()).toHaveLength(0);
});

test("the unit-test preload installs the network guard for every route the backend uses", async () => {
	const check = (globalThis as Record<symbol, unknown>)[
		Symbol.for("ceraui.outboundCheck")
	];
	expect(typeof check).toBe("function");
	const checkOutbound = check as (url: string, socketClass?: unknown) => void;
	// A ws test double opens nothing and passes; the real class is checked.
	checkOutbound("ws://192.0.2.1:9/ws", class FakeSocket {});
	const attempts: Array<() => unknown> = [
		() => checkOutbound("ws://192.0.2.1:9/ws"),
		() => fetch("http://192.0.2.1:9/"),
		() =>
			Bun.connect({ hostname: "192.0.2.1", port: 9, socket: { data() {} } }),
		() => dns.lookup("example.invalid", () => {}),
		() => dns.resolve4("example.invalid", () => {}),
		() => dnsPromises.lookup("example.invalid"),
		() => dnsPromises.resolve6("example.invalid"),
		() => new dns.Resolver().resolve4("example.invalid", () => {}),
		() => new dnsPromises.Resolver().resolve4("example.invalid"),
		() => Bun.dns.lookup("example.invalid"),
	];
	for (const attempt of attempts)
		expect(attempt).toThrow(/Unsafe test (outbound connection|DNS query)/);
	expect(takeSafetyViolations()).toHaveLength(attempts.length);
});

test("UDP to a non-loopback host is refused; loopback and literal lookups stay allowed", async () => {
	const socket = createSocket("udp4");
	try {
		expect(() => socket.send("x", 9, "192.0.2.1")).toThrow(
			"Unsafe test outbound connection",
		);
		expect(() => socket.connect(9, "192.0.2.1")).toThrow(
			"Unsafe test outbound connection",
		);
		await new Promise<void>((resolve, reject) =>
			socket.send("x", 9, "127.0.0.1", (error) =>
				error ? reject(error) : resolve(),
			),
		);
	} finally {
		socket.close();
	}
	expect(() =>
		Bun.udpSocket({ connect: { hostname: "192.0.2.1", port: 9 } }),
	).toThrow("Unsafe test outbound connection");
	const bunUdp = await Bun.udpSocket({});
	try {
		expect(() => bunUdp.send("x", 9, "192.0.2.1")).toThrow(
			"Unsafe test outbound connection",
		);
		bunUdp.send("x", 9, "127.0.0.1");
	} finally {
		bunUdp.close();
	}
	await dnsPromises.lookup("localhost");
	await dnsPromises.lookup("127.0.0.1");
	expect(takeSafetyViolations()).toHaveLength(4);
});

test("backend source opens client ws sockets only through the guarded helper", async () => {
	const root = new URL("../", import.meta.url).pathname;
	const offenders: string[] = [];
	for await (const file of new Bun.Glob("**/*.ts").scan(root)) {
		if (file.startsWith("tests/") || file.endsWith(".test.ts")) continue;
		if (file === "helpers/outbound-websocket.ts") continue;
		const text = await Bun.file(join(root, file)).text();
		if (/^import\s+(?!type\b)[^;]*\bfrom\s+["']ws["']/m.test(text))
			offenders.push(file);
	}
	expect(offenders).toEqual([]);
});
