/*
 * srtla_send through srtla-send.service (setup.json `srtla_send_unit`).
 *
 * The manager is scripted (tests/helpers/fake-sender-unit.ts); the argument
 * file, its directory and the stale-file cleanup are real files in a private
 * temp directory. The peer-credential probe and the update lock are also
 * exercised against the real kernel at the end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidfdClose, pidfdOpen, pidfdSignal } from "../helpers/pidfd.ts";
import {
	ownsSessionSender,
	unownedSenderCensus,
} from "../modules/streaming/sender-ownership.ts";
import {
	type StreamingProcess,
	signalSenders,
} from "../modules/streaming/streamloop/process-runner.ts";
import {
	encodeSenderArgv,
	mainExit,
	parseUnitShow,
	productionSenderUnitIo,
	resetSenderHostModeForTest,
	resolveSenderHostMode,
	retireLeftoverSenderUnit,
	SENDER_UNIT_EXEC,
	SenderUnitError,
	type SenderUnitProcess,
	senderHostBlocked,
	senderHostMode,
	senderUnitHostPaths,
	startSenderUnit,
	tryExclusiveLock,
} from "../modules/streaming/streamloop/sender-unit.ts";
import { FakeSenderUnit } from "./helpers/fake-sender-unit.ts";

let root = "";
let dir = "";
let fake: FakeSenderUnit;

function senderArgs(tag = "a"): string[] {
	return [
		"9000",
		`receiver-${tag}.example`,
		"5000",
		`${dir}/ips`,
		"--conn-timeout-ms",
		"4000",
		"--stats-file",
		`${dir}/stats.json`,
		"--control-socket",
		`${dir}/control.sock`,
		"--bind-map",
		`${dir}/ips.bindmap.json`,
	];
}

function decode(bytes: Uint8Array): string[] {
	const text = new TextDecoder().decode(bytes);
	expect(text.endsWith("\0")).toBe(true);
	return text.slice(0, -1).split("\0");
}

async function unitMode(setup: Record<string, unknown> = {}) {
	const config = {
		srtla_send_unit: true,
		ips_file: "/tmp/srtla_ips",
		...setup,
	};
	expect(await resolveSenderHostMode(config, SENDER_UNIT_EXEC, fake.io())).toBe(
		"unit",
	);
	await retireLeftoverSenderUnit();
	fake.calls.length = 0;
	return config;
}

async function rejection(promise: Promise<unknown>): Promise<SenderUnitError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(SenderUnitError);
		return error as SenderUnitError;
	}
	throw new Error("expected a SenderUnitError");
}

const verbs = () => fake.calls.map((call) => call[0]);

beforeEach(() => {
	resetSenderHostModeForTest();
	root = mkdtempSync(join(tmpdir(), "sender-unit-"));
	dir = join(root, "srtla-send");
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	fake = new FakeSenderUnit(dir);
});

afterEach(() => {
	resetSenderHostModeForTest();
	rmSync(root, { recursive: true, force: true });
});

describe("the flag", () => {
	test("off by default: child mode, nothing probed, the shared paths stay", async () => {
		const setup = { ips_file: "/tmp/srtla_ips" };
		expect(
			await resolveSenderHostMode(setup, SENDER_UNIT_EXEC, fake.io()),
		).toBe("child");
		expect(senderHostMode()).toBe("child");
		expect(senderUnitHostPaths()).toBeNull();
		expect(fake.calls).toEqual([]);
		expect(setup.ips_file).toBe("/tmp/srtla_ips");
		expect(await retireLeftoverSenderUnit()).toBe("none");
		expect(fake.calls).toEqual([]);
	});

	test("an explicit false is off too", async () => {
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: false },
				SENDER_UNIT_EXEC,
				fake.io(),
			),
		).toBe("child");
		expect(fake.calls).toEqual([]);
	});

	test("on, with the unit installed and a private directory: unit mode, files move", async () => {
		const setup = await unitMode({ bind_map_file: "/tmp/custom.bindmap" });
		expect(senderHostMode()).toBe("unit");
		expect(setup.ips_file).toBe(`${dir}/ips`);
		expect(setup.bind_map_file).toBe(`${dir}/ips.bindmap.json`);
		expect(senderUnitHostPaths()?.controlSocket).toBe(`${dir}/control.sock`);
	});

	test("on, but the unit is not installed: child mode", async () => {
		fake.state.load = "not-found";
		const setup = { srtla_send_unit: true, ips_file: "/tmp/srtla_ips" };
		expect(
			await resolveSenderHostMode(setup, SENDER_UNIT_EXEC, fake.io()),
		).toBe("child");
		expect(setup.ips_file).toBe("/tmp/srtla_ips");
	});

	test("on, but the directory is open to others or missing: child mode", async () => {
		chmodSync(dir, 0o755);
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: true },
				SENDER_UNIT_EXEC,
				fake.io(),
			),
		).toBe("child");
		rmSync(dir, { recursive: true });
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: true },
				SENDER_UNIT_EXEC,
				fake.io(),
			),
		).toBe("child");
	});

	test("on, but a different sender executable is configured: child mode, unit only read", async () => {
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: true },
				"/opt/srtla_send",
				fake.io(),
			),
		).toBe("child");
		// The installed unit is still read, so a leftover can be stopped; until
		// that check has run, nothing starts.
		expect(verbs().every((verb) => verb === "show")).toBe(true);
		expect(senderHostBlocked()).not.toBeNull();
		expect(await retireLeftoverSenderUnit()).toBe("none");
		expect(senderHostBlocked()).toBeNull();
	});
});

describe("start", () => {
	test("publishes a fresh 0600 argv and is ready only once the sender answers", async () => {
		await unitMode();
		fake.next = { kind: "ready", launcherTicks: 3 };
		writeFileSync(`${dir}/stats.json`, "stale");
		const handle = await startSenderUnit(senderArgs());
		expect(decode(fake.published[0] as Uint8Array)).toEqual(senderArgs());
		const argv = statSync(`${dir}/argv`);
		expect(argv.mode & 0o777).toBe(0o600);
		expect(existsSync(`${dir}/stats.json`)).toBe(false);
		// The launcher phase (comm is not srtla_send yet) is polled through.
		expect(fake.clock).toBe(300);
		expect(handle.pid).toBe(fake.state.mainPid);
		expect(handle.invocation).toBe(fake.state.invocation);
		expect(handle.isReady).toBe(true);
		expect(verbs().slice(0, 2)).toEqual(["show", "start"]);
		expect(fake.lockHeld).toBe(1);
		expect(fake.lockReleased).toBe(1);
		// No temp file is left beside argv.
		expect(
			new Bun.Glob(".argv-*").scanSync({ cwd: dir, dot: true }).toArray(),
		).toEqual([]);
	});

	test("an update holding the lock refuses the start before anything is published", async () => {
		await unitMode();
		fake.lockBusy = true;
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("update_in_progress");
		expect(verbs()).not.toContain("start");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("a running unit is never started a second time", async () => {
		await unitMode();
		fake.state = {
			...fake.state,
			active: "active",
			sub: "running",
			mainPid: 77,
		};
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("unit_busy");
		expect(verbs()).not.toContain("start");
		expect(fake.lockReleased).toBe(1);
	});

	test("a unit waiting to restart is busy too", async () => {
		await unitMode();
		fake.state = { ...fake.state, active: "activating", sub: "auto-restart" };
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"unit_busy",
		);
	});

	test("a refused argument file (exit 78) fails the start and leaves nothing behind", async () => {
		await unitMode();
		fake.next = { kind: "exit", status: 78 };
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("launcher_refused");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("the sender's own usage error (exit 2) is told apart", async () => {
		await unitMode();
		fake.next = { kind: "exit", status: 2 };
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"sender_usage",
		);
	});

	test("systemd refusing the start (start limit) is a start failure, never reset-failed", async () => {
		await unitMode();
		fake.next = { kind: "refused" };
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("start_refused");
		expect(verbs()).not.toContain("reset-failed");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("a start that times out while the unit comes up stops the unit again", async () => {
		await unitMode();
		const io = fake.io();
		resetSenderHostModeForTest();
		await resolveSenderHostMode({ srtla_send_unit: true }, SENDER_UNIT_EXEC, {
			...io,
			systemctl: async (args, timeout) => {
				const out = await io.systemctl(args, timeout);
				if (args[0] === "start") throw new Error("Connection timed out");
				return out;
			},
		});
		await retireLeftoverSenderUnit();
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("start_refused");
		expect(fake.state.active).toBe("inactive");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("a sender that never answers is stopped again after the readiness bound", async () => {
		await unitMode();
		fake.next = { kind: "silent" };
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("not_ready");
		expect(fake.clock).toBeGreaterThanOrEqual(5_000);
		expect(verbs()).toContain("stop");
		expect(fake.state.active).toBe("inactive");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("an answer from another invocation does not count as ready", async () => {
		await unitMode();
		fake.next = { kind: "ready" };
		let shows = 0;
		const io = fake.io();
		const show = io.systemctl;
		resetSenderHostModeForTest();
		await resolveSenderHostMode({ srtla_send_unit: true }, SENDER_UNIT_EXEC, {
			...io,
			systemctl: async (args, timeout) => {
				// The read after the first successful probe sees a restart.
				if (
					args[0] === "show" &&
					fake.state.active === "active" &&
					++shows === 2
				)
					fake.restart();
				return show(args, timeout);
			},
		});
		await retireLeftoverSenderUnit();
		const handle = await startSenderUnit(senderArgs());
		expect(handle.invocation).toBe("inv-2");
		expect(shows).toBeGreaterThan(2);
	});

	test("a peer that is not the unit's main process is refused", async () => {
		await unitMode();
		const io = fake.io();
		resetSenderHostModeForTest();
		await resolveSenderHostMode({ srtla_send_unit: true }, SENDER_UNIT_EXEC, {
			...io,
			probeControl: async (_socket, accept) => accept({ pid: 1, uid: 0 }),
		});
		await retireLeftoverSenderUnit();
		fake.next = { kind: "ready" };
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"not_ready",
		);
	});

	test("relative paths, NUL bytes and oversized argument lists are refused before publishing", () => {
		const relative = senderArgs();
		relative[3] = "ips";
		expect(() => encodeSenderArgv(relative)).toThrow(/not absolute/);
		const socket = senderArgs();
		socket[9] = "control.sock";
		expect(() => encodeSenderArgv(socket)).toThrow(/not absolute/);
		const nul = senderArgs();
		nul[1] = "a\0b";
		expect(() => encodeSenderArgv(nul)).toThrow(/NUL/);
		expect(() => encodeSenderArgv([...senderArgs(), "x".repeat(9000)])).toThrow(
			/bytes/,
		);
		expect(() => encodeSenderArgv(["9000"])).toThrow(/positionals/);
	});
});

describe("stop", () => {
	test("stopping the handle stops the unit, ends the handle and removes launch state", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		writeFileSync(`${dir}/stats.json`, "{}");
		handle.kill("SIGTERM");
		expect(await handle.exited).toBe(0);
		expect(handle.exitCode).toBe(0);
		expect(fake.state.active).toBe("inactive");
		expect(existsSync(`${dir}/argv`)).toBe(false);
		expect(existsSync(`${dir}/stats.json`)).toBe(false);
		expect(handle.isReady).toBe(false);
		expect(fake.scheduled).toEqual([]);
		// Monitoring is over: a later tick neither restarts nor re-reports.
		const calls = fake.calls.length;
		await handle.tick();
		expect(fake.calls.length).toBe(calls);
	});

	test("a stop whose exit systemd did not keep still ends the handle, as SIGTERM", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.stopExitCode = 0;
		handle.kill("SIGTERM");
		expect(await handle.exited).toBe(128 + 15);
		expect(handle.signalCode).toBe("SIGTERM");
		expect(handle.exitCode).toBeNull();
	});

	test("SIGKILL escalation goes through the pinned process, not the unit name", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		const pid = handle.pid;
		handle.kill("SIGKILL");
		await handle.exited;
		expect(fake.signals).toContainEqual({ pid, signal: "SIGKILL" });
		expect(verbs()).not.toContain("kill");
	});

	test("without pidfd, SIGKILL by unit name only while the invocation is the same", async () => {
		const io = fake.io({ pidfdOpen: () => null });
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: true },
				SENDER_UNIT_EXEC,
				io,
			),
		).toBe("unit");
		await retireLeftoverSenderUnit();
		const handle = await startSenderUnit(senderArgs());
		fake.state.invocation = "someone-else";
		fake.stopFails = true;
		handle.kill("SIGKILL");
		for (let i = 0; i < 5; i++) await Bun.sleep(0);
		expect(verbs()).not.toContain("kill");
		fake.stopFails = false;
		await handle.exited;
	});
});

describe("crash and restart", () => {
	test("systemd's restart is followed: exit reported, new process adopted once ready", async () => {
		await unitMode();
		const events: string[] = [];
		const handle = await startSenderUnit(senderArgs(), {
			onRestarting: (show) =>
				events.push(`restarting:${mainExit(show).signalCode}`),
			onRestarted: (h) => events.push(`restarted:${h.pid}`),
		});
		const firstPid = handle.pid;
		fake.crash(11);
		await handle.tick();
		expect(events).toEqual(["restarting:SIGSEGV"]);
		expect(handle.isReady).toBe(false);
		expect(handle.owns(firstPid, "/proc")).toBe(false);
		await handle.tick();
		expect(events).toEqual(["restarting:SIGSEGV"]);
		fake.restart({ kind: "ready", launcherTicks: 2 });
		await handle.tick();
		expect(events).toEqual([
			"restarting:SIGSEGV",
			`restarted:${fake.state.mainPid}`,
		]);
		expect(handle.pid).not.toBe(firstPid);
		expect(handle.invocation).toBe(fake.state.invocation);
		expect(handle.isReady).toBe(true);
		expect(handle.exitCode).toBeNull();
		// The restart reused the published arguments.
		expect(decode(fake.published.at(-1) as Uint8Array)).toEqual(senderArgs());
	});

	test("a restart that misses the auto-restart window is seen by its new invocation", async () => {
		await unitMode();
		const events: string[] = [];
		const handle = await startSenderUnit(senderArgs(), {
			onRestarting: () => events.push("restarting"),
			onRestarted: () => events.push("restarted"),
		});
		fake.crash();
		fake.restart();
		await handle.tick();
		expect(events).toEqual(["restarting", "restarted"]);
	});

	test("systemd giving up ends the handle with the last exit and cleans up", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.crash(6);
		await handle.tick();
		fake.giveUp("start-limit-hit");
		await handle.tick();
		expect(await handle.exited).toBe(128 + 6);
		expect(handle.signalCode).toBe("SIGABRT");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("an unchanged unit is left alone", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs(), {
			onRestarting: () => {
				throw new Error("no restart happened");
			},
		});
		await handle.tick();
		await handle.tick();
		expect(handle.isReady).toBe(true);
	});
});

describe("configuration changes", () => {
	test("a new stream configuration replaces argv; nothing of the old sender is reused", async () => {
		await unitMode();
		const first = await startSenderUnit(senderArgs("a"));
		writeFileSync(`${dir}/control.sock`, "");
		first.kill("SIGTERM");
		await first.exited;
		const second = await startSenderUnit(senderArgs("b"));
		expect(fake.published.map((bytes) => decode(bytes)[1])).toEqual([
			"receiver-a.example",
			"receiver-b.example",
		]);
		expect(decode(readFileSync(`${dir}/argv`))[1]).toBe("receiver-b.example");
		expect(second.invocation).not.toBe(first.invocation);
	});

	test("a bond reload signals the unit's sender, and only while it is ready", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		handle.kill("SIGHUP");
		expect(fake.signals).toEqual([{ pid: handle.pid, signal: "SIGHUP" }]);
		expect(verbs()).not.toContain("stop");
		fake.crash();
		await handle.tick();
		handle.kill("SIGHUP");
		expect(fake.signals).toHaveLength(1);
	});

	test("publication and transitions are serialized", async () => {
		await unitMode();
		const order: string[] = [];
		const a = startSenderUnit(senderArgs("a")).then((h) => {
			order.push("a-ready");
			h.kill("SIGTERM");
			return h.exited.then(() => order.push("a-stopped"));
		});
		const b = startSenderUnit(senderArgs("b")).then(
			() => order.push("b-ready"),
			(error: SenderUnitError) => order.push(`b-${error.reason}`),
		);
		await Promise.all([a, b]);
		// b ran after a's start finished: a was still up, so b was refused.
		expect(order[0]).toBe("a-ready");
		expect(order).toContain("b-unit_busy");
	});
});

describe("ownership and leftovers", () => {
	function procRoot(pid: number, cgroup: string): string {
		const proc = join(root, "proc");
		mkdirSync(join(proc, String(pid)), { recursive: true });
		writeFileSync(join(proc, String(pid), "comm"), "srtla_send\n");
		writeFileSync(join(proc, String(pid), "cgroup"), `0::${cgroup}\n`);
		writeFileSync(join(proc, String(pid), "stat"), `${pid} (srtla_send) S 1 0`);
		return proc;
	}

	test("the census counts the unit's sender as ours by its cgroup", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		const owned: StreamingProcess[] = [
			{ proc: handle, spawnfile: SENDER_UNIT_EXEC, exitListeners: [] },
		];
		const proc = procRoot(handle.pid, fake.state.cgroup);
		expect(unownedSenderCensus(owned, proc, process.pid)).toBe("absent");
		const foreign = procRoot(handle.pid, "/system.slice/other.service");
		expect(unownedSenderCensus(owned, foreign, process.pid)).toBe("present");
		// During a restart the new process is not ours yet.
		procRoot(handle.pid, fake.state.cgroup);
		fake.crash();
		await handle.tick();
		expect(unownedSenderCensus(owned, proc, process.pid)).toBe("present");
	});

	test("a leftover running sender is stopped at startup; nothing adopts it", async () => {
		await unitMode();
		fake.state = {
			...fake.state,
			active: "active",
			sub: "running",
			mainPid: 99,
			invocation: "old",
		};
		writeFileSync(`${dir}/argv`, "9000\0");
		expect(await retireLeftoverSenderUnit()).toBe("stopped");
		expect(verbs()).toContain("stop");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("a crash between publishing and starting leaves only argv, removed at startup", async () => {
		await unitMode();
		writeFileSync(`${dir}/argv`, "9000\0");
		expect(await retireLeftoverSenderUnit()).toBe("none");
		expect(verbs()).not.toContain("stop");
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});
});

describe("systemd output", () => {
	test("show output and exit codes parse", () => {
		const show = parseUnitShow(
			"LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nInvocationID=abc\nControlGroup=\nResult=exit-code\nExecMainCode=1\nExecMainStatus=78\nNRestarts=3\n",
		);
		expect(show?.restarts).toBe(3);
		expect(show && mainExit(show)).toEqual({ exitCode: 78, signalCode: null });
		expect(parseUnitShow("garbage")).toBeNull();
		const killed = parseUnitShow(
			"LoadState=loaded\nActiveState=inactive\nMainPID=0\nExecMainCode=2\nExecMainStatus=15\n",
		);
		expect(killed && mainExit(killed)).toEqual({
			exitCode: null,
			signalCode: "SIGTERM",
		});
	});
});

describe("against the kernel", () => {
	test("the control probe accepts only the peer named by SO_PEERCRED", async () => {
		const socketPath = join(root, "control.sock");
		const requests: string[] = [];
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				data(socket, chunk) {
					const text = new TextDecoder().decode(chunk);
					requests.push(text);
					const { id } = JSON.parse(text.trim()) as { id: number };
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "no" } })}\n`,
					);
				},
			},
		});
		try {
			const probe = productionSenderUnitIo().probeControl;
			const uid = process.getuid?.() ?? 0;
			expect(
				await probe(
					socketPath,
					(peer) => peer.pid === process.pid && peer.uid === uid,
					2_000,
				),
			).toBe(true);
			expect(requests).toHaveLength(1);
			expect(
				await probe(socketPath, (peer) => peer.pid === process.pid + 1, 2_000),
			).toBe(false);
			expect(requests).toHaveLength(1);
			expect(await probe(join(root, "absent.sock"), () => true, 2_000)).toBe(
				false,
			);
		} finally {
			server.stop(true);
		}
	});

	test("a pidfd signal reaches its process and reports failure once it has exited", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		const fd = pidfdOpen(child.pid);
		expect(fd).not.toBeNull();
		if (fd === null) return;
		try {
			expect(pidfdSignal(fd, "SIGTERM")).toBe(true);
			await child.exited;
			expect(child.signalCode).toBe("SIGTERM");
			expect(pidfdSignal(fd, "SIGTERM")).toBe(false);
		} finally {
			pidfdClose(fd);
		}
	});

	test("the update lock excludes a second holder until released", async () => {
		const path = join(root, "update.lock");
		const first = await tryExclusiveLock(path);
		expect(first).not.toBeNull();
		expect(await tryExclusiveLock(path)).toBeNull();
		first?.release();
		const again = await tryExclusiveLock(path);
		expect(again).not.toBeNull();
		again?.release();
	});
});

describe("review round: stops that are not confirmed", () => {
	test("a stop systemd does not carry out keeps the handle live and the launch state, and retries", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.stopFails = true;
		let sleeps = 0;
		let argvDuringRetry = false;
		fake.onSleep = () => {
			sleeps++;
			argvDuringRetry ||= existsSync(`${dir}/argv`);
			if (sleeps === 2) fake.stopFails = false;
		};
		let ended = false;
		void handle.exited.then(() => {
			ended = true;
		});
		handle.kill("SIGTERM");
		await Bun.sleep(0);
		expect(ended).toBe(false);
		expect(handle.exitCode).toBeNull();
		expect(handle.signalCode).toBeNull();
		await handle.exited;
		expect(sleeps).toBe(2);
		expect(argvDuringRetry).toBe(true);
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});

	test("a stop followed by an unreadable manager is not an exit either", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.showFails = true;
		let sleeps = 0;
		fake.onSleep = () => {
			if (++sleeps === 3) fake.showFails = false;
		};
		handle.kill("SIGTERM");
		await handle.exited;
		expect(sleeps).toBe(3);
	});

	test("a start that times out and cannot be stopped keeps argv and blocks every later start", async () => {
		await unitMode();
		fake.startTimesOut = true;
		fake.stopFails = true;
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("stop_unconfirmed");
		expect(existsSync(`${dir}/argv`)).toBe(true);
		expect(senderHostBlocked()).not.toBeNull();
		expect(fake.scheduled).toHaveLength(1);
		fake.startTimesOut = false;
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"unit_unresolved",
		);
		// Once the unit can be stopped, the retry settles it.
		fake.stopFails = false;
		expect(await retireLeftoverSenderUnit()).toBe("stopped");
		expect(senderHostBlocked()).toBeNull();
		expect(existsSync(`${dir}/argv`)).toBe(false);
	});
});

describe("review round: boot", () => {
	test("a transient show failure is retried before deciding", async () => {
		let failures = 2;
		const io = fake.io();
		const flaky = {
			...io,
			systemctl: async (args: readonly string[], timeout: number) => {
				if (args[0] === "show" && failures-- > 0) throw new Error("bus");
				return io.systemctl(args, timeout);
			},
		};
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: true },
				SENDER_UNIT_EXEC,
				flaky,
			),
		).toBe("unit");
		await retireLeftoverSenderUnit();
		expect(senderHostBlocked()).toBeNull();
	});

	test("an unreadable unit blocks every sender until a later read settles it", async () => {
		fake.showFails = true;
		const setup = { srtla_send_unit: true, ips_file: "/tmp/srtla_ips" };
		expect(
			await resolveSenderHostMode(setup, SENDER_UNIT_EXEC, fake.io()),
		).toBe("child");
		expect(senderHostBlocked()).not.toBeNull();
		expect(await retireLeftoverSenderUnit()).toBe("unknown");
		expect(senderHostBlocked()).not.toBeNull();
		fake.showFails = false;
		fake.state = { ...fake.state, active: "activating", sub: "auto-restart" };
		expect(await retireLeftoverSenderUnit()).toBe("stopped");
		expect(senderHostBlocked()).toBeNull();
		expect(senderHostMode()).toBe("unit");
		expect(setup.ips_file).toBe(`${dir}/ips`);
	});

	test("an installed but unusable unit falls back to the child only after its leftover is stopped", async () => {
		chmodSync(dir, 0o755);
		fake.state = { ...fake.state, active: "activating", sub: "auto-restart" };
		expect(
			await resolveSenderHostMode(
				{ srtla_send_unit: true },
				SENDER_UNIT_EXEC,
				fake.io(),
			),
		).toBe("child");
		expect(await retireLeftoverSenderUnit()).toBe("stopped");
		expect(fake.state.active).toBe("inactive");
	});

	test("a positively absent unit needs nothing", async () => {
		fake.state.load = "not-found";
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			fake.io(),
		);
		expect(await retireLeftoverSenderUnit()).toBe("none");
		expect(senderHostBlocked()).toBeNull();
	});
});

describe("review round: races", () => {
	test("a finished handle's cleanup never deletes a newer start's argv", async () => {
		await unitMode();
		const first = await startSenderUnit(senderArgs("a"));
		fake.giveUp("exit-code");
		const second = startSenderUnit(senderArgs("b"));
		await first.tick();
		await second;
		expect(decode(readFileSync(`${dir}/argv`))[1]).toBe("receiver-b.example");
	});

	test("a reload during a restart is reported undelivered", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		const owned: StreamingProcess[] = [
			{ proc: handle, spawnfile: SENDER_UNIT_EXEC, exitListeners: [] },
		];
		expect(signalSenders("SIGHUP", owned)).toBe(1);
		fake.crash();
		await handle.tick();
		expect(signalSenders("SIGHUP", owned)).toBe(0);
		expect(ownsSessionSender(owned, SENDER_UNIT_EXEC)).toBe(false);
		fake.restart();
		await handle.tick();
		expect(ownsSessionSender(owned, SENDER_UNIT_EXEC)).toBe(true);
	});

	test("an unreadable manager or a deactivating unit takes readiness away until re-verified", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.showFails = true;
		await handle.tick();
		expect(handle.isReady).toBe(false);
		fake.showFails = false;
		await handle.tick();
		expect(handle.isReady).toBe(true);
		fake.state.active = "deactivating";
		fake.state.sub = "stop-sigterm";
		await handle.tick();
		expect(handle.isReady).toBe(false);
	});

	test("the dead sender's stats file is removed when the restart is seen", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		writeFileSync(`${dir}/stats.json`, "{}");
		fake.crash();
		await handle.tick();
		expect(existsSync(`${dir}/stats.json`)).toBe(false);
		expect(existsSync(`${dir}/argv`)).toBe(true);
	});
});

describe("review round: deadlines", () => {
	test("readiness that would only succeed after the deadline is not ready", async () => {
		await unitMode();
		fake.systemctlMs = 2_000;
		fake.next = { kind: "ready", launcherTicks: 1 };
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"not_ready",
		);
	});

	test("a restarted sender that never becomes ready is stopped after the limit", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.crash();
		await handle.tick();
		fake.restart({ kind: "silent" });
		for (let i = 0; i < 6 && fake.state.active !== "inactive"; i++)
			await handle.tick();
		expect(fake.state.active).toBe("inactive");
		await handle.exited;
	});
});

describe("review round: arguments and files", () => {
	test("a listen port the launcher would refuse never reaches systemd", async () => {
		await unitMode();
		const args = senderArgs();
		args[0] = "70000";
		expect((await rejection(startSenderUnit(args))).reason).toBe(
			"invalid_arguments",
		);
		args[0] = "9x";
		expect(() => encodeSenderArgv(args)).toThrow(/not a port/);
		expect(verbs()).not.toContain("start");
	});

	test("a failed publication is a typed start failure", async () => {
		const io = fake.io({
			writeExclusive: () => {
				throw new Error("EROFS");
			},
		});
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			io,
		);
		await retireLeftoverSenderUnit();
		const error = await rejection(startSenderUnit(senderArgs()));
		expect(error.reason).toBe("start_refused");
		expect(verbs()).not.toContain("start");
	});

	test("stale files that cannot be removed refuse the start", async () => {
		const io = fake.io({
			remove: async (path) => {
				if (path.endsWith("stats.json")) throw new Error("EBUSY");
			},
		});
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			io,
		);
		await retireLeftoverSenderUnit();
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"start_refused",
		);
		expect(verbs()).not.toContain("start");
	});
});

describe("review round 3", () => {
	test("an inactive unit with a queued start job is not down: start admission refuses", async () => {
		await unitMode();
		fake.state.job = "4711";
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"unit_busy",
		);
	});

	test("a failed stop with a job still queued is not confirmed, even if the unit reads inactive", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		fake.stopFails = true;
		// systemd has the process gone but another start job queued.
		fake.state = {
			...fake.state,
			active: "inactive",
			sub: "dead",
			mainPid: 0,
			job: "4712",
		};
		let sleeps = 0;
		fake.onSleep = () => {
			if (++sleeps === 2) fake.stopFails = false;
		};
		handle.kill("SIGTERM");
		await handle.exited;
		expect(sleeps).toBe(2);
		expect(fake.state.job).toBe("");
	});

	test("a truncated show reply is unreadable, never no process", () => {
		expect(
			parseUnitShow("LoadState=loaded\nActiveState=inactive\n"),
		).toBeNull();
		expect(
			parseUnitShow("LoadState=loaded\nActiveState=inactive\nMainPID=\n"),
		).toBeNull();
	});

	test("retirement stops an inactive unit that still has a start job queued", async () => {
		resetSenderHostModeForTest();
		fake.state.job = "4713";
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			fake.io(),
		);
		expect(await retireLeftoverSenderUnit()).toBe("stopped");
		expect(verbs()).toContain("stop");
		expect(fake.state.job).toBe("");
	});

	test("until the startup check has run, the census never reads absent and nothing starts", async () => {
		resetSenderHostModeForTest();
		const empty = join(root, "empty-proc");
		mkdirSync(empty);
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			fake.io(),
		);
		expect(senderHostBlocked()).not.toBeNull();
		expect(unownedSenderCensus([], empty, process.pid)).toBe("unknown");
		expect((await rejection(startSenderUnit(senderArgs()))).reason).toBe(
			"unit_unresolved",
		);
		expect(await retireLeftoverSenderUnit()).toBe("none");
		expect(unownedSenderCensus([], empty, process.pid)).toBe("absent");
	});

	test("a retry that cannot settle the mode keeps the block the whole time", async () => {
		resetSenderHostModeForTest();
		fake.showFails = true;
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			fake.io(),
		);
		const seen: Array<string | null> = [];
		fake.onSleep = () => seen.push(senderHostBlocked());
		expect(await retireLeftoverSenderUnit()).toBe("unknown");
		expect(senderHostBlocked()).not.toBeNull();
		expect(seen.every((reason) => reason !== null)).toBe(true);
	});

	test("an old handle's retried stop never stops a newer launch", async () => {
		await unitMode();
		const first = await startSenderUnit(senderArgs("a"));
		fake.stopFails = true;
		let second: SenderUnitProcess | undefined;
		let sleeps = 0;
		fake.onSleep = () => {
			if (++sleeps !== 1) return;
			// The first sender goes down on its own and a new stream starts.
			fake.stopFails = false;
			fake.state = {
				...fake.state,
				active: "inactive",
				sub: "dead",
				mainPid: 0,
			};
			void startSenderUnit(senderArgs("b")).then((h) => {
				second = h;
			});
		};
		first.kill("SIGTERM");
		await first.exited;
		for (let i = 0; i < 20 && !second; i++) await Bun.sleep(1);
		expect(second).toBeDefined();
		expect(fake.state.active).toBe("active");
		expect(decode(readFileSync(`${dir}/argv`))[1]).toBe("receiver-b.example");
	});

	test("without a pidfd there is no SIGKILL by unit name at all", async () => {
		const io = fake.io({ pidfdOpen: () => null });
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			io,
		);
		await retireLeftoverSenderUnit();
		const handle = await startSenderUnit(senderArgs());
		handle.kill("SIGKILL");
		await handle.exited;
		expect(verbs()).not.toContain("kill");
	});

	test("a sender that died after the last good read is not counted as ours", async () => {
		await unitMode();
		const handle = await startSenderUnit(senderArgs());
		const owned: StreamingProcess[] = [
			{ proc: handle, spawnfile: SENDER_UNIT_EXEC, exitListeners: [] },
		];
		expect(ownsSessionSender(owned, SENDER_UNIT_EXEC)).toBe(true);
		fake.crash();
		// No monitor tick yet: the pin answers that the process is gone.
		expect(ownsSessionSender(owned, SENDER_UNIT_EXEC)).toBe(false);
	});

	test("the same PID and invocation in another cgroup is not the same sender", async () => {
		await unitMode();
		const events: string[] = [];
		const handle = await startSenderUnit(senderArgs(), {
			onRestarting: () => events.push("restarting"),
			onRestarted: () => events.push("restarted"),
		});
		fake.state.cgroup = "/system.slice/other.service";
		await handle.tick();
		// Treated as a new process: reported, then verified from scratch.
		expect(events).toEqual(["restarting", "restarted"]);
		expect(handle.owns(handle.pid, "/nonexistent")).toBe(false);
	});

	test("an old stats file that cannot be removed on restart stops the sender", async () => {
		const real = fake.io();
		let armed = false;
		const io = fake.io({
			remove: async (path) => {
				if (armed && path.endsWith("stats.json")) throw new Error("EBUSY");
				return real.remove(path);
			},
		});
		await resolveSenderHostMode(
			{ srtla_send_unit: true },
			SENDER_UNIT_EXEC,
			io,
		);
		await retireLeftoverSenderUnit();
		const handle = await startSenderUnit(senderArgs());
		armed = true;
		fake.crash();
		await handle.tick();
		armed = false;
		await handle.exited;
		expect(fake.state.active).toBe("inactive");
	});
});
