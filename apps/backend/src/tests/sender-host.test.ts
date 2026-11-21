import { describe, expect, test } from "bun:test";
import { release } from "node:os";
import { type ProcessPin, pinProcess } from "../helpers/process-pin.ts";
import {
	HostedLaunchError,
	hostedSenderHandle,
	isSenderUnit,
	launchHostedSender,
	listSenderUnits,
	type SenderHostDeps,
	senderStderrFile,
	stopSenderUnit,
} from "../modules/streaming/streamloop/sender-host.ts";

// A hosted sender runs in its own unit and is supervised through a pidfd.
// Tests never start a unit: systemd is a fake that answers `show`, and the
// pidfd mechanics run against a real child of the test process.

const UNIT = "ceralive-srtla-send-0123456789abcdef.service";
const INVOCATION = "0123456789abcdef0123456789abcdef";
const CGROUP = `/system.slice/${UNIT}`;

function showText(over: Record<string, string> = {}): string {
	const rows: Record<string, string> = {
		Id: UNIT,
		LoadState: "loaded",
		ActiveState: "active",
		SubState: "running",
		MainPID: "4242",
		InvocationID: INVOCATION,
		ControlGroup: CGROUP,
		Restart: "no",
		Transient: "yes",
		Description: "CeraLive SRTLA sender",
		...over,
	};
	return Object.entries(rows)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

function statLine(pid: number, start: string) {
	const rest = ["S", "1", String(pid), String(pid)];
	while (rest.length < 19) rest.push("0");
	rest.push(start, "0");
	return `${pid} (srtla_send) ${rest.join(" ")}\n`;
}

function fakePin(alive: () => boolean | null = () => true) {
	const signals: (NodeJS.Signals | number)[] = [];
	let closed = false;
	const pin: ProcessPin = {
		pidfd: true,
		alive: () => (closed ? null : alive()),
		signal: (signal) => {
			signals.push(signal);
			return closed ? null : alive();
		},
		close: () => {
			closed = true;
		},
	};
	return {
		pin,
		signals,
		get closed() {
			return closed;
		},
	};
}

function hostDeps(over: Partial<SenderHostDeps> = {}) {
	const runs: string[][] = [];
	let shows = 0;
	let clock = 0;
	const deps: SenderHostDeps = {
		run: async (command, args) => {
			runs.push([command, ...args]);
			return "";
		},
		show: async () => {
			shows++;
			return showText();
		},
		// The stop path's own read; by default the same answers as `show`.
		showSender: (unit) => deps.show(unit, "system"),
		pin: async () => fakePin().pin,
		readStat: async (pid) => statLine(pid, "555"),
		readCgroup: async () => CGROUP,
		mkdir: async () => undefined,
		unitId: () => "0123456789abcdef",
		follow: () => null,
		// Waiting advances the clock, so every bounded wait ends.
		wait: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		...over,
	};
	return {
		deps,
		runs,
		get shows() {
			return shows;
		},
	};
}

describe("unit names", () => {
	test("only our prefix with a 16-hex id is a sender unit", () => {
		expect(isSenderUnit(UNIT)).toBe(true);
		for (const name of [
			"ceralive.service",
			"ceralive-srtla-send-0123.service",
			"ceralive-srtla-send-0123456789abcdeg.service",
			`${UNIT}.extra`,
			"sshd.service",
		])
			expect(isSenderUnit(name)).toBe(false);
		expect(
			senderStderrFile(UNIT).endsWith(
				"ceralive-srtla-send-0123456789abcdef.stderr",
			),
		).toBe(true);
	});
});

describe("launchHostedSender", () => {
	test("starts one transient unit with the fixed properties and supervises its main PID", async () => {
		const h = hostDeps();
		const launched = await launchHostedSender(
			"/usr/bin/srtla_send",
			["9000", "relay", "5000"],
			h.deps,
		);
		expect(h.runs).toHaveLength(1);
		const [command, ...args] = h.runs[0] ?? [];
		expect(command).toBe("systemd-run");
		expect(args).toEqual([
			`--unit=${UNIT}`,
			"--description=CeraLive SRTLA sender",
			"--service-type=exec",
			"--collect",
			"--quiet",
			"--property=Restart=no",
			"--property=KillMode=control-group",
			"--property=StandardOutput=journal",
			`--property=StandardError=truncate:${senderStderrFile(UNIT)}`,
			"--setenv=NO_COLOR=1",
			"--",
			"/usr/bin/srtla_send",
			"9000",
			"relay",
			"5000",
		]);
		expect(launched.sender.pid).toBe(4242);
		expect(launched.sender.startTime).toBe("555");
		expect(launched.sender.unit).toBe(UNIT);
		// MainPID read before and after the pin.
		expect(h.shows).toBe(2);
		launched.sender.release();
	});

	test("a main PID that changes across the pin stops the unit by name and throws", async () => {
		let shows = 0;
		const pin = fakePin();
		const h = hostDeps({
			show: async () => {
				shows++;
				// Before and after the pin, then the stop path's own reads: still
				// running when it starts, inactive once the stop is sent.
				if (shows === 2) return showText({ MainPID: "4343" });
				if (shows <= 3) return showText();
				return showText({ ActiveState: "inactive", MainPID: "0" });
			},
			pin: async () => pin.pin,
		});
		const error = await launchHostedSender("/usr/bin/srtla_send", [], h.deps)
			.then(() => null)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HostedLaunchError);
		expect((error as HostedLaunchError).reason).toBe("identity_unconfirmed");
		expect(pin.closed).toBe(true);
		// Nothing was signalled through the pin; systemd stops the unit.
		expect(pin.signals).toEqual([]);
		expect(h.runs.at(-1)).toEqual([
			"systemctl",
			"stop",
			"--no-block",
			"--",
			UNIT,
		]);
	});

	test("a process outside the unit's cgroup is not supervised", async () => {
		const h = hostDeps({
			readCgroup: async () => "/system.slice/other.service",
		});
		await expect(
			launchHostedSender("/usr/bin/srtla_send", [], h.deps),
		).rejects.toMatchObject({ reason: "identity_unconfirmed" });
	});

	test("a start request whose reply is lost still stops the unit it may have started", async () => {
		let shows = 0;
		const h = hostDeps({
			run: async (command, args) => {
				h.runs.push([command, ...args]);
				if (command === "systemd-run") throw new Error("timeout");
				return "";
			},
			show: async () =>
				++shows === 1
					? showText()
					: showText({ ActiveState: "inactive", MainPID: "0" }),
		});
		await expect(
			launchHostedSender("/usr/bin/srtla_send", [], h.deps),
		).rejects.toMatchObject({ reason: "start_unconfirmed" });
		expect(h.runs.at(-1)).toEqual([
			"systemctl",
			"stop",
			"--no-block",
			"--",
			UNIT,
		]);
	});

	test("no pidfd: the unit is stopped and nothing is supervised", async () => {
		const h = hostDeps({ pin: async () => null });
		await expect(
			launchHostedSender("/usr/bin/srtla_send", [], h.deps),
		).rejects.toMatchObject({ reason: "pin_unavailable" });
		expect(h.runs.at(-1)?.slice(0, 2)).toEqual(["systemctl", "stop"]);
	});

	test("a unit that is not running after the start job: refused", async () => {
		const h = hostDeps({
			show: async () => showText({ ActiveState: "failed", MainPID: "0" }),
		});
		await expect(
			launchHostedSender("/usr/bin/srtla_send", [], h.deps),
		).rejects.toMatchObject({ reason: "unit_not_running" });
	});
});

describe("stopSenderUnit", () => {
	test("never acts on a unit without our prefix", async () => {
		const h = hostDeps();
		expect(await stopSenderUnit("ceralive.service", h.deps)).toBe("not_ours");
		expect(h.runs).toEqual([]);
		expect(h.shows).toBe(0);
	});

	test("a unit with our name that is not our transient sender is left alone", async () => {
		for (const over of [
			{ Transient: "no" },
			{ Description: "Something else" },
		]) {
			const h = hostDeps({ show: async () => showText(over) });
			expect(await stopSenderUnit(UNIT, h.deps)).toBe("not_ours");
			expect(h.runs).toEqual([]);
		}
	});

	test("another start of the recorded unit name is left alone", async () => {
		const h = hostDeps();
		expect(await stopSenderUnit(UNIT, h.deps, 1_000, "f".repeat(32))).toBe(
			"not_ours",
		);
		expect(h.runs).toEqual([]);
	});

	test("a unit that is gone or inactive is absent, with no stop sent", async () => {
		const gone = hostDeps({ show: async () => "LoadState=not-found\n" });
		expect(await stopSenderUnit(UNIT, gone.deps)).toBe("absent");
		const inactive = hostDeps({
			show: async () => showText({ ActiveState: "inactive", MainPID: "0" }),
		});
		expect(await stopSenderUnit(UNIT, inactive.deps)).toBe("absent");
		expect([...gone.runs, ...inactive.runs]).toEqual([]);
	});

	test("an unanswered first read is a failure, never absent", async () => {
		const h = hostDeps({
			show: async () => {
				throw new Error("timeout");
			},
		});
		expect(await stopSenderUnit(UNIT, h.deps)).toBe("failed");
		expect(h.runs).toEqual([]);
	});

	test("MainPID 0 while systemd still says active is not stopped", async () => {
		const h = hostDeps({
			show: async () => showText({ ActiveState: "deactivating", MainPID: "0" }),
		});
		expect(await stopSenderUnit(UNIT, h.deps, 300)).toBe("timed_out");
	});

	test("stops by name and waits until systemd reports it inactive", async () => {
		let shows = 0;
		const h = hostDeps({
			show: async () =>
				++shows < 3
					? showText()
					: showText({ ActiveState: "inactive", MainPID: "0" }),
		});
		expect(await stopSenderUnit(UNIT, h.deps, 10_000, INVOCATION)).toBe(
			"stopped",
		);
		expect(h.runs).toEqual([["systemctl", "stop", "--no-block", "--", UNIT]]);
	});

	test("unanswered reads after the stop request never count as stopped", async () => {
		let shows = 0;
		const h = hostDeps({
			show: async () => {
				if (++shows === 1) return showText();
				throw new Error("timeout");
			},
		});
		expect(await stopSenderUnit(UNIT, h.deps, 300)).toBe("timed_out");
	});

	test("a unit that does not stop in time is reported, not assumed stopped", async () => {
		const h = hostDeps();
		expect(await stopSenderUnit(UNIT, h.deps, 300)).toBe("timed_out");
	});

	test("a failed stop request is reported", async () => {
		const h = hostDeps({
			run: async () => {
				throw new Error("Access denied");
			},
		});
		expect(await stopSenderUnit(UNIT, h.deps)).toBe("failed");
	});
});

describe("listSenderUnits", () => {
	test("keeps only our sender units from systemctl's plain listing", async () => {
		const other = "ceralive-srtla-send-fedcba9876543210.service";
		const h = hostDeps({
			run: async () =>
				`${UNIT} loaded active running CeraLive SRTLA sender\n${other} loaded failed failed CeraLive SRTLA sender\nceralive.service loaded active running x\n`,
		});
		expect(await listSenderUnits(h.deps)).toEqual([UNIT, other]);
	});

	test("an unanswered listing is unknown, not empty", async () => {
		const h = hostDeps({
			run: async () => {
				throw new Error("timeout");
			},
		});
		expect(await listSenderUnits(h.deps)).toBeNull();
	});
});

describe("hostedSenderHandle", () => {
	function manual() {
		const timers: (() => void)[] = [];
		return {
			options: {
				schedule: (callback: () => void) => {
					timers.push(callback);
					return timers.length;
				},
				cancel: () => undefined,
			},
			tick: () => timers.shift()?.(),
		};
	}

	test("only a verified exit retires it; unknown keeps it alive", async () => {
		let alive: boolean | null = true;
		const p = fakePin(() => alive);
		const clock = manual();
		const handle = hostedSenderHandle(1, "1", UNIT, p.pin, clock.options);
		alive = null;
		clock.tick();
		expect(handle.exitCode).toBeNull();
		alive = false;
		clock.tick();
		expect(handle.exitCode).toBe(-1);
		expect(await handle.exited).toBe(-1);
		expect(p.closed).toBe(true);
	});

	test("signals go through the pin; a gone process marks the handle exited", () => {
		let alive: boolean | null = true;
		const p = fakePin(() => alive);
		const handle = hostedSenderHandle(1, "1", UNIT, p.pin, manual().options);
		expect(handle.signal("SIGHUP")).toBe(true);
		alive = null;
		expect(handle.signal("SIGHUP")).toBeNull();
		// kill() never throws, whatever the answer.
		handle.kill("SIGTERM");
		alive = false;
		expect(handle.signal("SIGTERM")).toBe(false);
		expect(handle.exitCode).toBe(-1);
		expect(p.signals).toEqual(["SIGHUP", "SIGHUP", "SIGTERM", "SIGTERM"]);
		// After exit, nothing more is sent through anything.
		expect(handle.signal("SIGKILL")).toBe(false);
		expect(p.signals).toHaveLength(4);
	});

	test("release stops watching without claiming an exit", () => {
		const p = fakePin();
		const clock = manual();
		const handle = hostedSenderHandle(1, "1", UNIT, p.pin, clock.options);
		handle.release();
		clock.tick();
		expect(handle.exitCode).toBeNull();
		expect(p.closed).toBe(true);
		expect(handle.signal("SIGTERM")).toBeNull();
		expect(p.signals).toEqual([]);
	});
});

// Linux 5.3 has pidfd_open and pidfd_send_signal.
const [major = 0, minor = 0] = release().split(".").map(Number);
const hasPidfd = major > 5 || (major === 5 && minor >= 3);

describe.if(process.platform === "linux" && hasPidfd)(
	"hostedSenderHandle over a real pidfd",
	() => {
		test("SIGTERM through the pidfd ends the process; the exit poll sees it", async () => {
			const child = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
			const pin = await pinProcess(child.pid);
			expect(pin?.pidfd).toBe(true);
			const handle = hostedSenderHandle(
				child.pid,
				"1",
				UNIT,
				pin as ProcessPin,
				{ pollMs: 10 },
			);
			expect(handle.signal("SIGTERM")).toBe(true);
			await child.exited;
			expect(child.signalCode).toBe("SIGTERM");
			expect(await handle.exited).toBe(-1);
		});

		test("after the process is reaped the pidfd reaches nothing, whatever the PID now names", async () => {
			const child = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
			const pin = (await pinProcess(child.pid)) as ProcessPin;
			child.kill("SIGKILL");
			await child.exited;
			// Reaped: the number is free for any new process; the pidfd still
			// names the old one and answers "exited".
			expect(pin.alive()).toBe(false);
			expect(pin.signal("SIGTERM")).toBe(false);
			pin.close();
			expect(pin.signal("SIGTERM")).toBeNull();
		});
	},
);
