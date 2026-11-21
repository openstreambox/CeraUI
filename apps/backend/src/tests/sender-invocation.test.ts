import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinProcess } from "../helpers/process-pin.ts";
import {
	captureProcessInvocation,
	type ProcessInvocationIo,
	parseUnitShow,
	processInvocationIo,
	readEngineSessionIdentity,
	readUnitFacts,
	senderHost,
	type UnitManager,
	unitOfCgroup,
} from "../modules/streaming/sender-invocation.ts";

const INVOCATION = "0123456789abcdef0123456789abcdef";
const OTHER_INVOCATION = "fedcba9876543210fedcba9876543210";

function show(over: Record<string, string> = {}): string {
	const rows = {
		Id: "ceralive-sender-1.service",
		LoadState: "loaded",
		ActiveState: "active",
		SubState: "running",
		MainPID: "4242",
		InvocationID: INVOCATION,
		ControlGroup: "/system.slice/ceralive-sender-1.service",
		Restart: "no",
		...over,
	};
	return `${Object.entries(rows)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n")}\n`;
}

function bootId(): string {
	return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function startTimeOf(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
}

describe("captureProcessInvocation", () => {
	test("reads PID, start time and boot id of a live process under a pidfd", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			const invocation = await captureProcessInvocation(child.pid);
			expect(invocation).toMatchObject({
				pid: child.pid,
				startTime: startTimeOf(child.pid),
				bootId: bootId(),
				pidfd: true,
			});
			expect(invocation?.state).toMatch(/^[RS]$/);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("a process that exits during the read describes nothing", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		const io: ProcessInvocationIo = {
			...processInvocationIo,
			readStat: async (path) => {
				const stat = readFileSync(path, "utf8");
				child.kill("SIGKILL");
				await child.exited;
				return stat;
			},
		};
		expect(await captureProcessInvocation(child.pid, io)).toBeNull();
	});

	test("a PID with no process is not captured", async () => {
		const child = Bun.spawn(["true"]);
		await child.exited;
		expect(await captureProcessInvocation(child.pid)).toBeNull();
	});

	test("a stat read that names another process's start time is what a reuse looks like, and the pin keeps it from being the pinned one", async () => {
		// The pinned process dies and its number is (as far as the caller can
		// tell) answered by someone else: the capture refuses rather than
		// reporting the other process's start time.
		const child = Bun.spawn(["sleep", "30"]);
		const io: ProcessInvocationIo = {
			...processInvocationIo,
			readStat: async () => {
				child.kill("SIGKILL");
				await child.exited;
				return `${child.pid} (srtla_send) S 1 ${child.pid} ${child.pid} ${"0 ".repeat(13)}5 0\n`;
			},
		};
		expect(await captureProcessInvocation(child.pid, io)).toBeNull();
	});

	test("without a pidfd the capture still works and says so", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			const invocation = await captureProcessInvocation(child.pid, {
				...processInvocationIo,
				pin: async () => ({
					pidfd: false,
					alive: () => true,
					close: () => undefined,
				}),
			});
			expect(invocation?.pidfd).toBe(false);
			expect(invocation?.startTime).toBe(startTimeOf(child.pid));
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("a capture is tied to the spawning handle: a child already reaped captures nothing", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			expect(
				await captureProcessInvocation(
					child.pid,
					processInvocationIo,
					() => false,
				),
			).toBeNull();
			expect(
				(
					await captureProcessInvocation(
						child.pid,
						processInvocationIo,
						() => true,
					)
				)?.startTime,
			).toBe(startTimeOf(child.pid));
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("a zombie, or a pidfd whose answer is unknown, captures nothing", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			expect(
				await captureProcessInvocation(child.pid, {
					...processInvocationIo,
					readStat: async () =>
						`${child.pid} (srtla_send) Z 1 ${child.pid} ${child.pid} ${"0 ".repeat(15)}77 0\n`,
				}),
			).toBeNull();
			expect(
				await captureProcessInvocation(child.pid, {
					...processInvocationIo,
					pin: async () => ({
						pidfd: true,
						alive: () => null,
						close: () => undefined,
					}),
				}),
			).toBeNull();
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("a pin that cannot be had at all is no capture", async () => {
		expect(await pinProcess(0)).toBeNull();
		expect(await pinProcess(-5)).toBeNull();
	});
});

describe("systemd unit facts", () => {
	test("parse the properties of a loaded unit", () => {
		expect(parseUnitShow(show())).toEqual({
			unit: "ceralive-sender-1.service",
			invocation: INVOCATION,
			mainPid: 4242,
			activeState: "active",
			subState: "running",
			controlGroup: "/system.slice/ceralive-sender-1.service",
			restart: "no",
		});
	});

	test("an unknown unit, an empty invocation or an unparseable PID is no fact", () => {
		expect(parseUnitShow(show({ LoadState: "not-found" }))).toBeNull();
		expect(parseUnitShow(show({ InvocationID: "" }))).toBeNull();
		expect(parseUnitShow(show({ MainPID: "x" }))).toBeNull();
		expect(parseUnitShow("")).toBeNull();
	});

	test("a scope prints no main PID or restart policy and reads as neither", () => {
		const scope = show({ Id: "run-x.scope" })
			.split("\n")
			.filter(
				(line) => !line.startsWith("Restart=") && !line.startsWith("MainPID="),
			)
			.join("\n");
		expect(parseUnitShow(scope)).toMatchObject({ mainPid: 0, restart: "no" });
	});

	test("readUnitFacts asks for the named unit only and rejects another answer", async () => {
		const asked: Array<[string, UnitManager]> = [];
		const facts = await readUnitFacts(
			"ceralive-sender-1.service",
			"system",
			async (unit, manager) => {
				asked.push([unit, manager]);
				return show();
			},
		);
		expect(asked).toEqual([["ceralive-sender-1.service", "system"]]);
		expect(facts?.invocation).toBe(INVOCATION);
		expect(
			await readUnitFacts("other.service", "system", async () => show()),
		).toBeNull();
		expect(
			await readUnitFacts("bad name;rm.service", "system", async () => show()),
		).toBeNull();
		expect(
			await readUnitFacts("x.service", "system", async () => {
				throw new Error("systemctl failed");
			}),
		).toBeNull();
	});

	test("the unit and manager of a cgroup path", () => {
		expect(unitOfCgroup("/system.slice/ceralive-sender-1.service")).toEqual({
			unit: "ceralive-sender-1.service",
			manager: "system",
		});
		expect(
			unitOfCgroup(
				"/user.slice/user-1000.slice/user@1000.service/app.slice/run-u9.service",
			),
		).toEqual({ unit: "run-u9.service", manager: "user" });
		expect(
			unitOfCgroup("/user.slice/user-1000.slice/user@1000.service"),
		).toBeNull();
		expect(unitOfCgroup("/system.slice")).toBeNull();
		expect(unitOfCgroup("/")).toBeNull();
	});
});

describe("senderHost", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sender-host-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	function cgroupOf(pid: number | "self", cgroup: string) {
		mkdirSync(join(root, String(pid)), { recursive: true });
		writeFileSync(join(root, String(pid), "cgroup"), `0::${cgroup}\n`);
	}
	function members(cgroup: string, pids: number[]) {
		mkdirSync(join(root, "cg", cgroup), { recursive: true });
		writeFileSync(
			join(root, "cg", cgroup, "cgroup.procs"),
			pids.map((pid) => `${pid}\n`).join(""),
		);
	}
	const io = (show: () => Promise<string>) => ({
		procRoot: root,
		cgroupRoot: join(root, "cg"),
		show,
	});
	const SENDER = "/system.slice/ceralive-sender-1.service";
	const BACKEND = "/system.slice/ceralive.service";

	test("a sender in the backend's own cgroup is a backend child and asks systemd nothing", async () => {
		cgroupOf("self", BACKEND);
		cgroupOf(4242, BACKEND);
		let asked = 0;
		expect(
			await senderHost(
				4242,
				io(async () => {
					asked++;
					return show();
				}),
			),
		).toEqual({ host: "backend-child" });
		expect(asked).toBe(0);
	});

	test("the main process of its own active unit is recorded with that unit's invocation", async () => {
		cgroupOf("self", BACKEND);
		cgroupOf(4242, SENDER);
		members(SENDER, [4242]);
		expect(
			await senderHost(
				4242,
				io(async () => show()),
			),
		).toEqual({
			host: "systemd",
			unit: "ceralive-sender-1.service",
			manager: "system",
			invocation: INVOCATION,
			cgroup: SENDER,
		});
	});

	test("a unit whose main process is another PID, or that is not active, is no host", async () => {
		cgroupOf("self", BACKEND);
		cgroupOf(4242, SENDER);
		for (const over of [
			{ MainPID: "4243" },
			{ ActiveState: "deactivating" },
			{ ControlGroup: "/system.slice/other.service" },
			{ LoadState: "not-found" },
		])
			expect(
				await senderHost(
					4242,
					io(async () => show(over)),
				),
			).toEqual({ host: "backend-child" });
	});

	test("an unreadable cgroup is a backend child", async () => {
		cgroupOf("self", BACKEND);
		expect(
			await senderHost(
				4242,
				io(async () => show()),
			),
		).toEqual({
			host: "backend-child",
		});
	});

	test("a unit with a second process in its control group is no host", async () => {
		cgroupOf("self", BACKEND);
		cgroupOf(4242, SENDER);
		members(SENDER, [4242, 4300]);
		expect(
			await senderHost(
				4242,
				io(async () => show()),
			),
		).toEqual({
			host: "backend-child",
		});
		members(SENDER, []);
		expect(
			await senderHost(
				4242,
				io(async () => show()),
			),
		).toEqual({
			host: "backend-child",
		});
	});
});

describe("readEngineSessionIdentity", () => {
	const engine = (over: Record<string, string> = {}) =>
		show({
			Id: "cerastream.service",
			MainPID: "777",
			InvocationID: OTHER_INVOCATION,
			ControlGroup: "/system.slice/cerastream.service",
			...over,
		});

	test("scopes the engine's session id by its unit invocation and main PID", async () => {
		expect(
			await readEngineSessionIdentity(
				async () => "session-9",
				async () => engine(),
			),
		).toEqual({
			invocation: OTHER_INVOCATION,
			mainPid: 777,
			sessionId: "session-9",
		});
	});

	test("an engine that is not running is not asked", async () => {
		let asked = 0;
		const ask = async () => {
			asked++;
			return "session-9";
		};
		expect(
			await readEngineSessionIdentity(ask, async () =>
				engine({ ActiveState: "inactive", MainPID: "0" }),
			),
		).toBeNull();
		expect(
			await readEngineSessionIdentity(ask, async () =>
				engine({ LoadState: "not-found" }),
			),
		).toBeNull();
		expect(asked).toBe(0);
	});

	test("an engine restarted while it was asked gives no identity", async () => {
		let reads = 0;
		expect(
			await readEngineSessionIdentity(
				async () => "session-9",
				async () =>
					reads++ === 0 ? engine() : engine({ InvocationID: INVOCATION }),
			),
		).toBeNull();
		reads = 0;
		expect(
			await readEngineSessionIdentity(
				async () => "session-9",
				async () => (reads++ === 0 ? engine() : engine({ MainPID: "778" })),
			),
		).toBeNull();
	});

	test("an engine that cannot say its session gives no identity", async () => {
		expect(
			await readEngineSessionIdentity(
				async () => null,
				async () => engine(),
			),
		).toBeNull();
		expect(
			await readEngineSessionIdentity(
				async () => {
					throw new Error("timeout");
				},
				async () => engine(),
			),
		).toBeNull();
	});
});

/**
 * The production readers against the real service manager, read only (tests
 * may not start or stop units). Run under `systemd-run --user --scope`, the
 * test process sits in a transient scope of its own; elsewhere (CI) there is
 * no unit to read and the case only checks that nothing is claimed.
 */
describe("the real service manager, read only", () => {
	test("the unit holding this test process reads back with its invocation and control group", async () => {
		const cgroup = readFileSync("/proc/self/cgroup", "utf8")
			.split("\n")
			.find((line) => line.startsWith("0::"))
			?.slice(3);
		const owner = cgroup ? unitOfCgroup(cgroup) : null;
		// No unit to read (a container, cgroup root), no systemctl, or a
		// manager this namespace cannot reach (a gate's private network and
		// PID namespace): skip. Whenever the manager answers, facts are due.
		if (!owner || !Bun.which("systemctl")) return;
		const reachable = Bun.spawnSync(
			[
				"systemctl",
				...(owner.manager === "user" ? ["--user"] : []),
				"show",
				"--property=Version",
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (
			reachable.exitCode !== 0 ||
			!reachable.stdout.toString().includes("Version=")
		)
			return;
		const facts = await readUnitFacts(owner.unit, owner.manager);
		if (!facts)
			throw new Error(`no facts for ${owner.manager} unit ${owner.unit}`);
		expect(facts.unit).toBe(owner.unit);
		// A scope has no main process, so it can never be a sender's host.
		if (owner.unit.endsWith(".scope")) expect(facts.mainPid).toBe(0);
		expect(facts.invocation).toMatch(/^[0-9a-f]{32}$/);
		expect(facts.controlGroup).toBe(cgroup ?? "");
		expect(facts.activeState).toBe("active");
	});

	test("this process, in its own cgroup, is a backend child to itself", async () => {
		expect(await senderHost(process.pid)).toEqual({ host: "backend-child" });
	});
});
