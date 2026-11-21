import { expect, test } from "bun:test";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerThreads from "node:worker_threads";
import * as safety from "../../../../scripts/test-safety.ts";
import {
	assertLoopbackHost,
	assertOwnedSignalTarget,
	assertSafeCommand,
	takeSafetyViolations,
	writePathStubs,
} from "../../../../scripts/test-safety.ts";

const signalBinary = Bun.which("killall") ?? Bun.which("kill");
const python = Bun.which("python3");

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
	assertSafeCommand(["setsid", "--wait", "cat", "-", "kill", "0"]);
	assertSafeCommand(["timeout", "5", "printf", "%s", "killall"]);
});

test.skipIf(!signalBinary)(
	"a symlink to a signal command is judged by its target (needs killall or kill)",
	() => {
		const real = signalBinary ?? "";
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
	},
);

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
		writeFileSync(
			script,
			`#!/bin/sh\nsystemctl --user stop ${NO_SUCH}.service\n`,
		);
		const viaScript = Bun.spawnSync(["sh", script], { stderr: "pipe" });
		expect(viaScript.exitCode).toBe(97);
		const recorded = takeSafetyViolations();
		expect(
			recorded.some((line) =>
				line.includes(`systemctl --user stop ${NO_SUCH}.service`),
			),
		).toBe(true);
		expect(recorded.every((line) => line.includes("reached a PATH stub"))).toBe(
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(!python)(
	"an interpreter's by-name call hits the PATH stubs (needs python3)",
	() => {
		const viaPython = spawnSync(python ?? "python3", [
			"-c",
			`import subprocess; raise SystemExit(subprocess.call(["pkill", "-x", "${NO_SUCH}"]))`,
		]);
		expect(viaPython.status).toBe(97);
		const recorded = takeSafetyViolations();
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toContain(`reached a PATH stub: pkill -x ${NO_SUCH}`);
	},
);

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
		if (
			/^import\s+(?!type\b)[^;]*\bfrom\s+["']ws["']/m.test(text) ||
			/^export\s+[^;]*\bfrom\s+["']ws["']/m.test(text) ||
			/\b(?:require|await\s+import)\(\s*["']ws["']\s*\)|\bimport\(\s*["']ws["']\s*\)\s*\.then\b/.test(
				text,
			)
		)
			offenders.push(file);
	}
	expect(offenders).toEqual([]);
});

test("backend source uses the guarded global fetch, never Bun's read-only one", async () => {
	// Bun.fetch and `import { fetch } from "bun"` cannot be wrapped from outside.
	const root = new URL("../", import.meta.url).pathname;
	const offenders: string[] = [];
	for await (const file of new Bun.Glob("**/*.ts").scan(root)) {
		if (file.startsWith("tests/") || file.endsWith(".test.ts")) continue;
		const text = await Bun.file(join(root, file)).text();
		if (
			/\bBun\.fetch\b/.test(text) ||
			/import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*["']bun["']/.test(text)
		)
			offenders.push(file);
	}
	expect(offenders).toEqual([]);
});

// Second review round. A "stranger" is this test's parent (the runner or the
// namespace init); SIGCONT to a running process is a no-op, so a baseline
// without the guard harms nothing.
const stranger = () => process.ppid;
// In a container the runner can be PID 1 with no foreign process to aim at.
const noStranger = process.ppid <= 0;

test("PATH stubs without a real systemctl answer read-only queries like a missing binary", () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-safety-nosystemctl-"));
	try {
		const recordFile = join(dir, "calls.log");
		writeFileSync(recordFile, "");
		writePathStubs(dir, recordFile, undefined);
		const query = Bun.spawnSync(
			["sh", join(dir, "systemctl"), "is-enabled", "ssh"],
			{ stderr: "pipe" },
		);
		expect(query.exitCode).toBe(127);
		expect(readFileSync(recordFile, "utf8")).toBe("");
		const mutation = Bun.spawnSync(
			["sh", join(dir, "systemctl"), "--user", "stop", `${NO_SUCH}.service`],
			{ stderr: "pipe" },
		);
		expect(mutation.exitCode).toBe(97);
		expect(readFileSync(recordFile, "utf8")).toContain("systemctl --user stop");
		writeFileSync(recordFile, "");
		const realQuery = join(dir, "query-fixture");
		writeFileSync(realQuery, "#!/bin/sh\nexit 0\n");
		chmodSync(realQuery, 0o755);
		writePathStubs(dir, recordFile, realQuery);
		const passThrough = Bun.spawnSync([
			"sh",
			join(dir, "systemctl"),
			"is-active",
			"ssh",
		]);
		expect(passThrough.exitCode).toBe(0);
		expect(readFileSync(recordFile, "utf8")).toBe("");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(noStranger)(
	"process._kill is guarded like process.kill (needs a parent process)",
	() => {
		const internal = process as unknown as {
			_kill?: (pid: number, signal: number) => unknown;
		};
		if (typeof internal._kill !== "function") return;
		expect(() => internal._kill?.(stranger(), 18)).toThrow(
			"Unsafe test signal",
		);
		expect(takeSafetyViolations()).toHaveLength(1);
	},
);

test("tests may not start Worker threads, where the guards do not run", () => {
	expect(() => new Worker("data:text/javascript,0")).toThrow(
		"Unsafe test worker",
	);
	expect(() => new workerThreads.Worker("0", { eval: true })).toThrow(
		"Unsafe test worker",
	);
	expect(takeSafetyViolations()).toHaveLength(2);
});

test.skipIf(noStranger)(
	"a script's builtin kill may target only processes this test owns (needs a parent process)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "ceraui-safety-builtin-kill-"));
		try {
			const viaShell = join(dir, "s1.sh");
			writeFileSync(viaShell, '#!/bin/sh\nkill -CONT "$1"\n');
			const direct = join(dir, "s2.sh");
			writeFileSync(direct, '#!/bin/sh\nkill -CONT "$1"\n');
			chmodSync(direct, 0o755);
			const literal = join(dir, "s3.sh");
			writeFileSync(literal, `#!/bin/sh\nkill -CONT ${stranger()}\n`);
			const named = join(dir, "s4.sh");
			writeFileSync(
				named,
				`#!/usr/bin/env bash\n# halt is only a comment\npkill -x ${NO_SUCH}\n`,
			);
			chmodSync(named, 0o755);
			for (const command of [
				["sh", viaShell, String(stranger())],
				[direct, String(stranger())],
				["sh", literal],
				[named],
			])
				expect(() => assertSafeCommand(command)).toThrow(
					"Unsafe test process command",
				);
			expect(takeSafetyViolations()).toHaveLength(4);
			// Its own child is fair game, and comments are not commands.
			const own = Bun.spawn(["sleep", "30"]);
			const ownKill = Bun.spawnSync(["sh", viaShell, String(own.pid)]);
			expect(ownKill.exitCode).toBe(0);
			own.kill();
			await own.exited;
			expect(takeSafetyViolations()).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("su, runuser, script, sg and chroot launchers are followed", () => {
	for (const command of [
		["su", "-c", `kill -CONT ${stranger()}`],
		["runuser", "-u", "nobody", "--", "killall", NO_SUCH],
		["script", "-qc", `killall ${NO_SUCH}`, "/dev/null"],
		["sg", "users", `pkill -x ${NO_SUCH}`],
		["chroot", "/", "/bin/kill", "-CONT", String(stranger())],
	])
		expect(() => assertSafeCommand(command)).toThrow(
			"Unsafe test process command",
		);
	expect(takeSafetyViolations()).toHaveLength(5);
});

test("fetch through a proxy is judged by the proxy, not only the target", () => {
	expect(() =>
		fetch("http://127.0.0.1:9/", { proxy: "http://192.0.2.1:9" }),
	).toThrow("Unsafe test outbound connection: 192.0.2.1");
	const saved = process.env.HTTP_PROXY;
	process.env.HTTP_PROXY = "http://192.0.2.1:9";
	try {
		expect(() => fetch("http://127.0.0.1:9/")).toThrow(
			"Unsafe test outbound connection: 192.0.2.1",
		);
	} finally {
		if (saved === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = saved;
	}
	expect(takeSafetyViolations()).toHaveLength(2);
});

test("script builtin kill refuses targets with no process identity", () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-safety-unknown-pid-"));
	try {
		const script = join(dir, "signal.sh");
		writeFileSync(script, '#!/bin/sh\nkill -CONT "$1"\n');
		chmodSync(script, 0o755);
		const unknown = "2147483647";
		for (const command of [
			["sh", script, unknown],
			[script, unknown],
		])
			expect(() => assertSafeCommand(command)).toThrow(
				"Unsafe test process command",
			);
		writeFileSync(script, `#!/bin/sh\nkill -CONT ${unknown}\n`);
		expect(() => assertSafeCommand(["sh", script])).toThrow(
			"Unsafe test process command",
		);
		expect(takeSafetyViolations()).toHaveLength(3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ownership rejects reused identities and retires exited portable children", () => {
	let identity: string | undefined = "start-one";
	const ownership = new safety.ProcessOwnership(() => identity);
	ownership.add(42);
	expect(ownership.has(42)).toBe(true);
	identity = "start-two";
	expect(ownership.has(42)).toBe(false);
	identity = undefined;
	ownership.add(43);
	expect(ownership.has(43)).toBe(false);
	let live = true;
	ownership.add(44, () => live);
	expect(ownership.has(44)).toBe(true);
	live = false;
	expect(ownership.has(44)).toBe(false);
	identity = "start-three";
	ownership.add(45);
	ownership.delete(45);
	expect(ownership.has(45)).toBe(false);
});

test("exited spawned children lose signal ownership", async () => {
	const child = Bun.spawn([process.execPath, "--eval", "0"]);
	await child.exited;
	expect(() => assertOwnedSignalTarget(child.pid, "SIGCONT")).toThrow(
		"Unsafe test signal",
	);
	expect(takeSafetyViolations()).toHaveLength(1);
});

test("fetch refuses automatic redirects before the next request", async () => {
	let hits = 0;
	const destination = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			hits++;
			return new Response("unexpected");
		},
	});
	const redirect = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Response.redirect(`http://127.0.0.1:${destination.port}/`, 302);
		},
	});
	try {
		const url = `http://127.0.0.1:${redirect.port}/`;
		for (const request of [
			() => fetch(url),
			() => fetch(url, { redirect: "follow" }),
			() => fetch(new Request(url, { redirect: "follow" })),
		]) {
			await expect(request()).rejects.toThrow();
		}
		expect(hits).toBe(0);
		const manual = await fetch(url, { redirect: "manual" });
		expect(manual.status).toBe(302);
	} finally {
		redirect.stop(true);
		destination.stop(true);
	}
});

test("exited Node children lose signal ownership", async () => {
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, ["--eval", "0"]);
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	if (child.pid === undefined) throw new Error("Child did not start");
	const pid = child.pid;
	expect(() => assertOwnedSignalTarget(pid, "SIGCONT")).toThrow(
		"Unsafe test signal",
	);
	expect(takeSafetyViolations()).toHaveLength(1);
});
