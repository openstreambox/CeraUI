import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleState } from "@ceraui/rpc/schemas";
import type { SenderStats } from "@ceraui/srtla-send/control";
import type { ProcessPin } from "../helpers/process-pin.ts";
import {
	adoptedSender,
	clearAdoptedSender,
} from "../modules/streaming/adopted-sender.ts";
import type { ArmedStreamMarker } from "../modules/streaming/armed-stream-marker.ts";
import { digest } from "../modules/streaming/continuity-observer.ts";
import type {
	Lifetime,
	Publication,
} from "../modules/streaming/continuity-records.ts";
import type { SenderAdoptionIo } from "../modules/streaming/sender-adoption.ts";
import type { UnitFacts } from "../modules/streaming/sender-invocation.ts";
import {
	defaultModemGates,
	type TakeoverDeps,
	takeOverSenderAtStartup,
} from "../modules/streaming/sender-takeover.ts";
import type { StreamingProcess } from "../modules/streaming/streamloop/process-runner.ts";
import type {
	HostedSender,
	UnitStopOutcome,
} from "../modules/streaming/streamloop/sender-host.ts";

// The takeover is all or nothing. Every row of the failure table in the
// stream continuity design has a case here; each refusal must end with the
// recorded unit stopped by NAME and a reconciliation after it, and nothing
// registered, adopted or signalled by number.

const BOOT = "boot-a";
const PID = 4242;
const START = "987654";
const EXE = "/usr/bin/srtla_send";
const ARGS = digest(JSON.stringify([EXE, "9000"]));
const UNIT = "ceralive-srtla-send-0123456789abcdef.service";
const OTHER_UNIT = "ceralive-srtla-send-fedcba9876543210.service";
const CGROUP = `/system.slice/${UNIT}`;
const INVOCATION = "0123456789abcdef0123456789abcdef";
const SOCKET = "/tmp/srtla-send-control-9000.sock";
const SHA = "a".repeat(64);
const CONFIG = { srt_latency: 2000, max_br: 6000, pipeline: "p1" };
const ENGINE_SESSION = {
	invocation: "fedcba9876543210fedcba9876543210",
	mainPid: 777,
	sessionId: "session-1",
};
const CONNECTION = 5;
const LINKS = [
	{ linkId: "modem-a", iface: "wwan0", ip: "10.0.0.2" },
	{ linkId: "eth", iface: "eth0", ip: "192.168.1.5" },
];
const LIVE_UNIT: UnitFacts = {
	unit: UNIT,
	invocation: INVOCATION,
	mainPid: PID,
	activeState: "active",
	subState: "running",
	controlGroup: CGROUP,
	restart: "no",
};

function lifetime(over: Partial<Lifetime> = {}): Lifetime {
	return {
		version: 1,
		bootId: BOOT,
		lifetime: "7d3c4f0e-2a59-4c3f-9a4f-2b6c1b8f0a11",
		pid: PID,
		startTime: START,
		host: "systemd",
		invocation: INVOCATION,
		cgroup: CGROUP,
		unit: UNIT,
		unitManager: "system",
		pidfd: true,
		engineSession: { ...ENGINE_SESSION },
		argsDigest: ARGS,
		statsFile: "/tmp/srtla-send-stats-9000.json",
		controlSocket: SOCKET,
		ipsFile: "/run/ceralive/ips",
		sidecarFile: "/run/ceralive/ips.bindmap.json",
		required: true,
		contract: 0,
		capabilitiesDigest: null,
		createdAt: 1,
		...over,
	};
}

function publication(over: Partial<Publication> = {}): Publication {
	return {
		version: 1,
		bootId: BOOT,
		generation: 7,
		sha256: SHA,
		links: LINKS,
		...over,
	};
}

function stats(bytes: number): SenderStats {
	const link = (conn_id: number, link_id: string, iface: string) => ({
		conn_id,
		link_id,
		iface,
		connected: true,
		timed_out: false,
		window: 20,
		in_flight: 2,
		rtt_ms: 80,
		nak_count: 0,
		bitrate_bytes_per_sec: 250_000,
		base_score: 6,
		quality_multiplier: 1,
	});
	return {
		mode: "classic",
		session_bytes_sent: bytes,
		links: [link(0, "modem-a", "wwan0"), link(1, "eth", "eth0")],
		disposition: { state: "mapped" },
		bind_map_applied: { generation: 7, ips_file_sha256: SHA },
	};
}

function marker(over: Partial<ArmedStreamMarker> = {}): ArmedStreamMarker {
	return { armedAt: 1, bootId: BOOT, config: { ...CONFIG }, ...over };
}

/** A synthetic `/proc/<pid>/stat` line; the name holds a space and a paren. */
function statLine(pid: number, state: string, group: number, start: string) {
	const rest = [state, "1", String(group), String(group)];
	while (rest.length < 19) rest.push("0");
	rest.push(start, "0");
	return `${pid} (srtla send) x) ${rest.join(" ")}\n`;
}

const UNIX_HEADER = "Num       RefCount Protocol Flags    Type St Inode Path\n";

/** A pin whose answers each test controls; it records every signal. */
function controlledPin() {
	const state = {
		alive: true as boolean | null,
		closed: false,
		signals: [] as (NodeJS.Signals | number)[],
	};
	const pin: ProcessPin = {
		pidfd: true,
		alive: () => (state.closed ? null : state.alive),
		signal: (signal) => {
			state.signals.push(signal);
			return state.alive;
		},
		close: () => {
			state.closed = true;
		},
	};
	return { pin, state };
}

type Calls = string[];

let root = "";
let calls: Calls = [];
let statsReads = 0;
let pinState: ReturnType<typeof controlledPin>["state"];
let pin: ProcessPin;
let session: LifecycleState = "reconciling";
let reconcileState: LifecycleState = "streaming";
let registered: StreamingProcess | undefined;
let detectOnlyArgs: unknown[] = [];
let forgotten: HostedSender | undefined;
let configOverride: Record<string, unknown> | undefined;
let intentCurrent = true;
let flag = true;
let modemHold = false;

function writeProcess(
	pid: number,
	state = "S",
	start = START,
	cmdline = `${EXE}\x009000\x00`,
) {
	const dir = join(root, "proc", String(pid));
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "fd"), { recursive: true });
	mkdirSync(join(dir, "net"), { recursive: true });
	writeFileSync(join(dir, "stat"), statLine(pid, state, pid, start));
	writeFileSync(join(dir, "comm"), "srtla_send\n");
	writeFileSync(join(dir, "cmdline"), cmdline);
	writeFileSync(join(dir, "cgroup"), `0::${CGROUP}\n`);
	symlinkSync(EXE, join(dir, "exe"));
	symlinkSync("socket:[777]", join(dir, "fd", "3"));
	writeFileSync(
		join(dir, "net", "unix"),
		`${UNIX_HEADER}0000000000000000: 00000002 00000000 00010000 0001 01 777 ${SOCKET}\n`,
	);
	const cg = join(root, "cgroup", CGROUP);
	mkdirSync(cg, { recursive: true });
	writeFileSync(join(cg, "cgroup.procs"), `${pid}\n`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sender-takeover-"));
	calls = [];
	statsReads = 0;
	session = "reconciling";
	reconcileState = "streaming";
	registered = undefined;
	forgotten = undefined;
	modemHold = false;
	configOverride = undefined;
	intentCurrent = true;
	flag = true;
	({ pin, state: pinState } = controlledPin());
	writeProcess(PID);
	clearAdoptedSender();
});

afterEach(() => {
	clearAdoptedSender();
	rmSync(root, { recursive: true, force: true });
});

function adoptionIo(over: Partial<SenderAdoptionIo> = {}): SenderAdoptionIo {
	return {
		procRoot: join(root, "proc"),
		cgroupRoot: join(root, "cgroup"),
		now: () => 0,
		expectedExe: () => EXE,
		bootId: async () => BOOT,
		readLifetime: async () => lifetime(),
		pin: async () => {
			throw new Error("the takeover supplies the pin");
		},
		liveUnit: async () => ({ ...LIVE_UNIT }),
		readPublication: async () => publication(),
		readDisk: async () => publication(),
		readMarker: () => marker(),
		captureConfig: () => ({ ...CONFIG }),
		readStats: async () => {
			statsReads++;
			calls.push("readStats");
			return {
				peer: "verified",
				senderContract: 2,
				senderRequired: true,
				reads: [stats(1_000), stats(9_000)],
				appliedMap: { generation: 7, sha256: SHA },
			};
		},
		queryEngine: async () => {
			calls.push("queryEngine");
			return {
				state: "streaming",
				session: { ...ENGINE_SESSION },
				connection: CONNECTION,
			};
		},
		...over,
	};
}

/** A registered hosted handle as the runner would build it. */
function registeredSender(sender: HostedSender): StreamingProcess {
	const handle: StreamingProcess = {
		proc: sender as unknown as StreamingProcess["proc"],
		spawnfile: EXE,
		exitListeners: [],
		hosted: sender,
	};
	registered = handle;
	return handle;
}

/** The registered fake sender exits. */
function exitRegistered(): void {
	const hosted = registered?.hosted as unknown as { exit(): void } | undefined;
	if (!hosted) throw new Error("nothing registered");
	hosted.exit();
}

function fakeHosted(): HostedSender {
	let exitCode: number | null = null;
	return {
		pid: PID,
		unit: UNIT,
		startTime: START,
		pin,
		get exitCode() {
			return exitCode;
		},
		signalCode: null,
		exited: new Promise(() => undefined),
		kill: () => undefined,
		signal: () => true,
		release: () => undefined,
		// test hook
		...({
			exit: () => {
				exitCode = -1;
			},
		} as object),
	} as HostedSender;
}

function deps(
	over: Partial<TakeoverDeps> = {},
	io: Partial<SenderAdoptionIo> = {},
): TakeoverDeps {
	const adoption = adoptionIo(io);
	return {
		flagOn: () => true,
		bootId: async () => BOOT,
		readLifetime: async () => lifetime(),
		modemGates: async () => {
			calls.push("modemGates");
			return null;
		},
		captureIntent: () => () => true,
		sessionState: () => session,
		sessionGeneration: () => 0,
		adoptionIo: () => adoption,
		pin: async (pid) => {
			calls.push(`pin:${pid}`);
			return pin;
		},
		readStat: async (pid) =>
			readFileSync(join(root, "proc", String(pid), "stat"), "utf8"),
		readMarker: () => adoption.readMarker(),
		captureConfig: () => adoption.captureConfig(),
		readIps: async () => {
			calls.push("readIps");
			return "10.0.0.2\n192.168.1.5\n";
		},
		resolveSrtlaAddr: async () => {
			calls.push("resolveAddr");
			return "198.51.100.7";
		},
		adoptEngineSession: (sessionId, connection) => {
			calls.push(`adoptEngine:${sessionId}:${connection}`);
			return true;
		},
		releaseEngineSession: (sessionId) => {
			calls.push(`releaseEngine:${sessionId}`);
		},
		hostedHandle: (pid, startTime, unit, held) => {
			calls.push(`handle:${pid}:${startTime}:${unit}`);
			expect(held).toBe(pin);
			return fakeHosted();
		},
		register: (sender) => {
			calls.push("register");
			return registeredSender(sender);
		},
		forgetSender: (handle) => {
			calls.push("forgetSender");
			forgotten = handle;
		},
		modemHold: () => modemHold,
		senderAlive: (sender) =>
			pinState.alive === true && sender.proc.exitCode === null,
		continueGeneration: (applied) => calls.push(`generation:${applied}`),
		adoptLifetime: () => calls.push("adoptLifetime"),
		attachTelemetry: () => {
			calls.push("telemetry");
		},
		reconcile: async () => {
			calls.push("reconcile");
			return reconcileState;
		},
		attachSession: (generation) => {
			calls.push(`session:${generation}`);
			return true;
		},
		detachSession: (generation) => {
			calls.push(`detachSession:${generation}`);
		},
		stopTelemetry: () => calls.push("stopTelemetry"),
		stopUnit: async (unit): Promise<UnitStopOutcome> => {
			calls.push(`stopUnit:${unit}`);
			return "stopped";
		},
		listUnits: async () => {
			calls.push("listUnits");
			return [UNIT];
		},
		detectOnly: async (bootId, record) => {
			calls.push("detectOnly");
			detectOnlyArgs = [bootId, record];
		},
		...over,
	};
}

/** The common end of every refusal: the unit stopped by name, then reconcile. */
function expectFallback(stopped = true) {
	if (stopped) {
		const stop = calls.indexOf(`stopUnit:${UNIT}`);
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(calls.lastIndexOf("reconcile")).toBeGreaterThan(stop);
	}
	expect(calls).not.toContain("register");
	expect(calls.some((call) => call.startsWith("adoptEngine"))).toBe(false);
	expect(adoptedSender()).toBeUndefined();
	// Never a signal by number, the pin included.
	expect(pinState.signals).toEqual([]);
	expect(pinState.closed).toBe(true);
}

/**
 * A failure after the first side effect: every step done is undone in
 * reverse, then the unit is stopped by name, then reconciliation runs.
 * Nothing was marked adopted and the lifetime was never adopted.
 */
function expectRolledBack(steps: readonly string[]) {
	const undo = [
		"detachSession:0",
		"stopTelemetry",
		"forgetSender",
		"releaseEngine:session-1",
	].filter((step) => steps.includes(step));
	const failedAt = calls.findIndex((call) => undo.includes(call));
	expect(failedAt).toBeGreaterThan(-1);
	expect(calls.slice(failedAt, failedAt + undo.length)).toEqual(undo);
	const stop = calls.indexOf(`stopUnit:${UNIT}`);
	expect(stop).toBeGreaterThan(failedAt);
	expect(calls.lastIndexOf("reconcile")).toBeGreaterThan(stop);
	expect(calls).not.toContain("adoptLifetime");
	expect(adoptedSender()).toBeUndefined();
	expect(pinState.signals).toEqual([]);
}

const ALL_STEPS = [
	"detachSession:0",
	"stopTelemetry",
	"forgetSender",
	"releaseEngine:session-1",
];

describe("takeover: the commit is a transaction", () => {
	test("telemetry that cannot attach (IP list gone) undoes everything", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				attachTelemetry: () => {
					calls.push("telemetry");
					throw new Error("ENOENT");
				},
			}),
		);
		expect(outcome).toMatchObject({
			result: "fallback",
			check: "commit",
			reason: "failed",
		});
		expectRolledBack([
			"stopTelemetry",
			"forgetSender",
			"releaseEngine:session-1",
		]);
		expect(calls).not.toContain("reconcile:before-stop");
		expect(calls.indexOf("reconcile")).toBeGreaterThan(
			calls.indexOf(`stopUnit:${UNIT}`),
		);
	});

	test("an IP list that cannot be read refuses before any side effect", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				readIps: async () => {
					throw new Error("ENOENT");
				},
			}),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "ips_unreadable",
		});
		expectFallback();
	});

	test("a saved configuration that does not resolve refuses before any side effect", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				resolveSrtlaAddr: async () => {
					throw new Error("Invalid config");
				},
			}),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "config_invalid",
		});
		expectFallback();
	});

	test("session listeners that cannot attach undo everything", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				attachSession: (generation) => {
					calls.push(`session:${generation}`);
					return false;
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "listeners_unattached" });
		expectRolledBack([
			"stopTelemetry",
			"forgetSender",
			"releaseEngine:session-1",
		]);
	});

	test("a sender that dies while the listeners attach is caught before reconciliation", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				attachSession: (generation) => {
					calls.push(`session:${generation}`);
					pinState.alive = false;
					return true;
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "sender_changed" });
		expectRolledBack(
			["stopTelemetry", "forgetSender", "releaseEngine:session-1"].concat([
				"detachSession:0",
			]),
		);
		expect(calls).not.toContain("generation:7");
		expect(calls).not.toContain("reconcile:first");
	});

	test("a pidfd that turns unknown before reconciliation is not adopted", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				attachSession: (generation) => {
					calls.push(`session:${generation}`);
					pinState.alive = null;
					return true;
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "sender_changed" });
		expectRolledBack(ALL_STEPS);
	});

	test("an exception at registration releases the engine session", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				register: () => {
					calls.push("register");
					throw new Error("boom");
				},
			}),
		);
		expect(outcome).toMatchObject({ check: "commit", reason: "failed" });
		expectRolledBack(["forgetSender", "releaseEngine:session-1"]);
	});

	test("an operator Stop during the final validation refuses before any side effect", async () => {
		let stopped = false;
		const outcome = await takeOverSenderAtStartup(
			deps({
				captureIntent: () => () => !stopped,
				readStat: async (pid) => {
					stopped = true;
					return readFileSync(join(root, "proc", String(pid), "stat"), "utf8");
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "operator_intent" });
		expectFallback();
	});

	test("no staged ownership is visible while the final validation awaits", async () => {
		const seen: string[][] = [];
		await takeOverSenderAtStartup(
			deps({
				readStat: async (pid) => {
					seen.push([...calls]);
					return readFileSync(join(root, "proc", String(pid), "stat"), "utf8");
				},
				modemGates: async () => {
					seen.push([...calls]);
					calls.push("modemGates");
					return null;
				},
			}),
		);
		for (const snapshot of seen) {
			expect(snapshot).not.toContain("register");
			expect(snapshot.some((c) => c.startsWith("adoptEngine"))).toBe(false);
			expect(snapshot).not.toContain("telemetry");
		}
	});

	for (const [name, change, check] of [
		[
			"a configuration push",
			() => {
				configOverride = { ...CONFIG, max_br: 1 };
			},
			"config",
		],
		[
			"an operator Stop",
			() => {
				intentCurrent = false;
			},
			"intent",
		],
		[
			"the flag switched off",
			() => {
				flag = false;
			},
			"flag",
		],
		[
			"a modem hold",
			() => {
				modemHold = true;
			},
			"modem",
		],
	] as const)
		test(`${name} while reconciliation awaits the engine is seen where streaming would be published`, async () => {
			let eligibleAtPublish: unknown = "unset";
			reconcileState = "reconciling";
			const outcome = await takeOverSenderAtStartup(
				deps({
					flagOn: () => flag,
					captureIntent: () => () => intentCurrent,
					captureConfig: () => configOverride ?? { ...CONFIG },
					reconcile: async () => {
						calls.push("reconcile");
						// The commit's reconciliation only; the fallback reconciles again.
						if (eligibleAtPublish !== "unset") return reconcileState;
						change();
						// What the production rule asks at the publish point.
						eligibleAtPublish = adoptedSender();
						return reconcileState;
					},
				}),
			);
			expect(eligibleAtPublish).toBeUndefined();
			expect(outcome.result).toBe("fallback");
			void check;
		});

	test("after the commit, a configuration change no longer withdraws the adoption", async () => {
		await takeOverSenderAtStartup(deps());
		configOverride = { ...CONFIG, max_br: 1 };
		intentCurrent = false;
		expect(adoptedSender()).toBe(registered);
	});

	test("other sender units that cannot be confirmed stopped refuse before any side effect", async () => {
		for (const over of [
			{
				listUnits: async () => {
					calls.push("listUnits");
					return [UNIT, OTHER_UNIT];
				},
				stopUnit: async (unit: string): Promise<UnitStopOutcome> => {
					calls.push(`stopUnit:${unit}`);
					return unit === OTHER_UNIT ? "timed_out" : "stopped";
				},
			},
			{
				listUnits: async () => {
					calls.push("listUnits");
					return null;
				},
			},
		]) {
			calls = [];
			({ pin, state: pinState } = controlledPin());
			const outcome = await takeOverSenderAtStartup(deps(over));
			expect(outcome).toMatchObject({
				check: "commit",
				reason: "other_units_unconfirmed",
			});
			expect(calls).not.toContain("register");
			// The recorded unit is stopped, but no reconciliation follows the
			// unconfirmed cleanup.
			expect(calls).not.toContain("reconcile");
		}
	});

	test("a registration that throws part way is still undone by its handle", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				register: (sender) => {
					calls.push("register");
					registeredSender(sender);
					throw new Error("output capture failed");
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "failed" });
		expect(forgotten).toBeDefined();
		expect(calls).toContain("forgetSender");
		expect(calls).not.toContain("generation:7");
	});

	test("modem state that appears during the collection refuses before any side effect", async () => {
		let gates = 0;
		const outcome = await takeOverSenderAtStartup(
			deps({
				modemGates: async () => {
					calls.push("modemGates");
					return ++gates === 2
						? { check: "modem", reason: "internal_call_lease" }
						: null;
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "internal_call_lease" });
		expectFallback();
	});

	test("the collector judges the very record the commit uses; a replaced record refuses", async () => {
		let reads = 0;
		const outcome = await takeOverSenderAtStartup(
			deps(
				{
					readLifetime: async () =>
						++reads === 1
							? lifetime()
							: lifetime({ lifetime: "11111111-2222-4333-8444-555555555555" }),
				},
				{
					readLifetime: async () => {
						throw new Error("the collector must not read the record again");
					},
				},
			),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "record_changed",
		});
		expectFallback();
	});

	test("nothing is adopted or marked until reconciliation commits streaming", async () => {
		let adoptedAtReconcile: unknown = "unset";
		const outcome = await takeOverSenderAtStartup(
			deps({
				reconcile: async () => {
					calls.push("reconcile");
					adoptedAtReconcile = adoptedSender();
					expect(calls).not.toContain("adoptLifetime");
					return reconcileState;
				},
			}),
		);
		expect(outcome.result).toBe("adopted");
		// The marker is set just before the reconciliation that needs it.
		expect(adoptedAtReconcile).toBe(registered);
		expect(calls.indexOf("adoptLifetime")).toBeGreaterThan(
			calls.indexOf("reconcile"),
		);
	});
});

describe("takeover: adoption", () => {
	test("adopts when every piece of evidence agrees, in the commit order", async () => {
		const outcome = await takeOverSenderAtStartup(deps());
		expect(outcome).toEqual({ result: "adopted", unit: UNIT });
		expect(calls).toEqual([
			"modemGates",
			`pin:${PID}`,
			"readStats",
			"queryEngine",
			// Prepared with no side effects: everything that can fail first,
			// the other units' cleanup included, then the final validation.
			"readIps",
			"resolveAddr",
			"listUnits",
			"modemGates",
			// No await from here to the reconciliation: each step is undone if
			// a later one fails.
			`adoptEngine:session-1:${CONNECTION}`,
			`handle:${PID}:${START}:${UNIT}`,
			"register",
			"telemetry",
			"session:0",
			"reconcile",
			// Only after streaming was published.
			"generation:7",
			"adoptLifetime",
		]);
		// The pin the evidence used is the one the handle holds: still open.
		expect(pinState.closed).toBe(false);
		expect(adoptedSender()).toBe(registered);
	});

	test("after adoption, other sender units are stopped and the adopted one is not", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				listUnits: async () => {
					calls.push("listUnits");
					return [UNIT, OTHER_UNIT];
				},
			}),
		);
		expect(outcome.result).toBe("adopted");
		expect(calls).toContain(`stopUnit:${OTHER_UNIT}`);
		expect(calls).not.toContain(`stopUnit:${UNIT}`);
	});
});

describe("takeover: the flag", () => {
	test("off, with a backend-child record: detect only, nothing stopped or reconciled", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				flagOn: () => false,
				readLifetime: async () =>
					lifetime({ host: "backend-child", invocation: null }),
			}),
		);
		expect(outcome).toEqual({ result: "detect_only" });
		await Bun.sleep(0);
		expect(calls).toEqual(["detectOnly"]);
		// The record and boot id already read are handed on, not read again.
		expect(detectOnlyArgs).toEqual([
			BOOT,
			lifetime({ host: "backend-child", invocation: null }),
		]);
	});

	test("switched off during the restart: the hosted unit left behind is stopped by name", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({ flagOn: () => false }),
		);
		expect(outcome).toEqual({
			result: "fallback",
			check: "flag",
			reason: "off",
			stopped: "stopped",
		});
		expect(calls).toEqual([`stopUnit:${UNIT}`, "reconcile"]);
	});

	test("on, with a backend-child record: nothing to adopt, orphan units stopped", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				readLifetime: async () =>
					lifetime({ host: "backend-child", invocation: null }),
				listUnits: async () => {
					calls.push("listUnits");
					return [OTHER_UNIT];
				},
			}),
		);
		expect(outcome).toMatchObject({
			result: "fallback",
			check: "host",
			reason: "no_hosted_sender",
			stopped: "none",
		});
		expect(calls).toEqual(["listUnits", `stopUnit:${OTHER_UNIT}`, "reconcile"]);
	});

	test("on, nothing recorded and no unit: no reconciliation is added", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				readLifetime: async () => null,
				listUnits: async () => {
					calls.push("listUnits");
					return [];
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "no_hosted_sender" });
		expect(calls).toEqual(["listUnits"]);
	});

	test("a record from another boot or with a foreign unit name is never acted on", async () => {
		for (const record of [
			lifetime({ bootId: "boot-b" }),
			lifetime({ unit: "sshd.service" }),
			lifetime({ unitManager: "user" }),
		]) {
			calls = [];
			const outcome = await takeOverSenderAtStartup(
				deps({
					flagOn: () => false,
					readLifetime: async () => record,
				}),
			);
			expect(outcome).toEqual({ result: "detect_only" });
			expect(calls.some((call) => call.startsWith("stopUnit"))).toBe(false);
		}
	});
});

describe("takeover: crash during adoption", () => {
	test("before the commit nothing is written, and the next backend adopts on the same evidence", async () => {
		const records = join(root, "records");
		mkdirSync(records);
		const lifetimeFile = join(records, "lifetime.json");
		const publicationFile = join(records, "publication.json");
		writeFileSync(lifetimeFile, JSON.stringify(lifetime()));
		writeFileSync(publicationFile, JSON.stringify(publication()));
		const before = [
			readFileSync(lifetimeFile, "utf8"),
			readFileSync(publicationFile, "utf8"),
		];
		// The first backend dies while its engine question is out.
		const first = takeOverSenderAtStartup(
			deps(
				{},
				{
					queryEngine: () => new Promise(() => undefined),
				},
			),
		);
		await Bun.sleep(20);
		expect(calls).toContain("readStats");
		expect(calls).not.toContain("register");
		expect([
			readFileSync(lifetimeFile, "utf8"),
			readFileSync(publicationFile, "utf8"),
		]).toEqual(before);
		void first;
		// The next backend: fresh process state, same records, same sender.
		calls = [];
		({ pin, state: pinState } = controlledPin());
		expect(await takeOverSenderAtStartup(deps())).toMatchObject({
			result: "adopted",
		});
	});

	test("after registration the records are untouched, so the next backend judges the sender fresh", async () => {
		// The first backend dies inside its one reconciliation.
		const first = takeOverSenderAtStartup(
			deps({
				reconcile: () => {
					calls.push("reconcile");
					return new Promise(() => undefined);
				},
			}),
		);
		await Bun.sleep(20);
		expect(calls).toContain("register");
		void first;
		calls = [];
		clearAdoptedSender();
		({ pin, state: pinState } = controlledPin());
		expect(await takeOverSenderAtStartup(deps())).toMatchObject({
			result: "adopted",
		});
	});

	test("a publication reserved before the crash is ahead of the disk: refused", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({}, { readPublication: async () => publication({ generation: 8 }) }),
		);
		expect(outcome).toMatchObject({
			check: "bind_map",
			reason: "record_ahead_of_disk",
		});
		expect(statsReads).toBe(0);
		expectFallback();
	});

	test("a publication written but not applied by the sender: refused", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{},
				{
					readPublication: async () => publication({ generation: 8 }),
					readDisk: async () => publication({ generation: 8 }),
				},
			),
		);
		expect(outcome).toMatchObject({
			check: "bind_map",
			reason: "applied_identity_mismatch",
		});
		expectFallback();
	});
});

describe("takeover: the sender dies mid-adoption", () => {
	test("during the collection: refused, and only the unit is stopped", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{},
				{
					readStats: async () => {
						pinState.alive = false;
						return {
							peer: "verified",
							senderContract: 2,
							senderRequired: true,
							reads: [stats(1_000), stats(9_000)],
							appliedMap: { generation: 7, sha256: SHA },
						};
					},
				},
			),
		);
		expect(outcome).toMatchObject({
			check: "process",
			reason: "exited_during_read",
		});
		expectFallback();
	});

	test("between the verdict and registration: the commit's pin check refuses", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				readIps: async () => {
					// Read at the commit, after the verdict.
					pinState.alive = false;
					return "10.0.0.2\n";
				},
			}),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "sender_changed",
		});
		expectFallback();
	});

	test("stopped (SIGSTOP) between the verdict and registration: refused", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				readIps: async () => {
					writeProcess(PID, "T");
					return "10.0.0.2\n";
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "sender_changed" });
		expectFallback();
	});

	test("after registration, before reconciliation: undone, nothing adopted", async () => {
		reconcileState = "reconciling";
		const outcome = await takeOverSenderAtStartup(
			deps({
				reconcile: async () => {
					calls.push("reconcile");
					exitRegistered();
					return reconcileState;
				},
			}),
		);
		expect(outcome).toMatchObject({
			result: "fallback",
			check: "commit",
			reason: "reconciled_reconciling",
		});
		expectRolledBack(ALL_STEPS);
	});

	test("after adoption: the adopted sender no longer counts once it exits", async () => {
		await takeOverSenderAtStartup(deps());
		expect(adoptedSender()).toBe(registered);
		exitRegistered();
		expect(adoptedSender()).toBeUndefined();
	});
});

describe("takeover: configuration changed during the restart", () => {
	test("the stream configuration was edited: refused before the socket is read", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({}, { captureConfig: () => ({ ...CONFIG, max_br: 3000 }) }),
		);
		expect(outcome).toMatchObject({
			check: "config",
			reason: "config_changed",
		});
		expect(statsReads).toBe(0);
		expectFallback();
	});

	test("the sender's arguments changed: refused", async () => {
		writeProcess(PID, "S", START, `${EXE}\x009001\x00`);
		const outcome = await takeOverSenderAtStartup(deps());
		expect(outcome).toMatchObject({
			check: "process",
			reason: "arguments_changed",
		});
		expectFallback();
	});

	test("an operator Stop during the adoption: the intent fence refuses at commit", async () => {
		let stopped = false;
		const outcome = await takeOverSenderAtStartup(
			deps(
				{ captureIntent: () => () => !stopped },
				{
					queryEngine: async () => {
						stopped = true;
						return {
							state: "streaming",
							session: { ...ENGINE_SESSION },
							connection: CONNECTION,
						};
					},
				},
			),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "operator_intent",
		});
		expectFallback();
	});

	test("a session that left reconciling (a Stop or a launch) refuses at commit", async () => {
		session = "stopping";
		const outcome = await takeOverSenderAtStartup(deps());
		expect(outcome).toMatchObject({ reason: "operator_intent" });
		expectFallback();
	});

	test("a configuration push after the collection: refused at commit", async () => {
		let pushed = false;
		const outcome = await takeOverSenderAtStartup(
			deps(
				{
					captureConfig: () =>
						pushed ? { ...CONFIG, srt_latency: 3000 } : { ...CONFIG },
				},
				{
					queryEngine: async () => {
						pushed = true;
						return {
							state: "streaming",
							session: { ...ENGINE_SESSION },
							connection: CONNECTION,
						};
					},
				},
			),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "config_changed",
		});
		expectFallback();
	});
});

describe("takeover: PID reuse", () => {
	test("reused before the collection: refused before any socket read, unit stopped by name", async () => {
		writeProcess(PID, "S", "5");
		const outcome = await takeOverSenderAtStartup(deps());
		expect(outcome).toMatchObject({
			check: "process",
			reason: "pid_reused",
		});
		expect(statsReads).toBe(0);
		expectFallback();
	});

	test("reused between the verdict and the commit: the fresh start time refuses", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				readIps: async () => {
					writeProcess(PID, "S", "6");
					return "10.0.0.2\n";
				},
			}),
		);
		expect(outcome).toMatchObject({ reason: "sender_changed" });
		expectFallback();
	});

	test("no pidfd on the recorded PID: refused without reading anything", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({ pin: async () => null }),
		);
		expect(outcome).toMatchObject({
			check: "process",
			reason: "pin_unavailable",
		});
		expect(statsReads).toBe(0);
		expect(calls).toContain(`stopUnit:${UNIT}`);
	});
});

describe("takeover: the engine changed", () => {
	test("restarted engine: refused", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{},
				{
					queryEngine: async () => ({
						state: "streaming",
						session: { ...ENGINE_SESSION, invocation: "1".repeat(32) },
						connection: CONNECTION,
					}),
				},
			),
		);
		expect(outcome).toMatchObject({ reason: "engine_restarted" });
		expectFallback();
	});

	test("engine idle: refused", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{},
				{
					queryEngine: async () => ({
						state: "idle",
						session: { ...ENGINE_SESSION },
						connection: CONNECTION,
					}),
				},
			),
		);
		expect(outcome).toMatchObject({ reason: "engine_idle" });
		expectFallback();
	});

	test("the connection that answered is gone at commit: refused", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				adoptEngineSession: (sessionId, connection) => {
					calls.push(`refusedEngine:${sessionId}:${connection}`);
					return false;
				},
			}),
		);
		expect(outcome).toMatchObject({
			check: "commit",
			reason: "engine_changed",
		});
		expectFallback();
	});

	test("an answer without a connection token cannot be adopted", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{},
				{
					queryEngine: async () => ({
						state: "streaming",
						session: { ...ENGINE_SESSION },
					}),
				},
			),
		);
		expect(outcome).toMatchObject({ reason: "engine_changed" });
		expectFallback();
	});

	test("reconciliation does not commit streaming: the adoption is undone", async () => {
		reconcileState = "reconciling";
		const outcome = await takeOverSenderAtStartup(deps());
		expect(outcome).toMatchObject({ reason: "reconciled_reconciling" });
		// The engine reference is released too, not only the marker.
		expectRolledBack(ALL_STEPS);
	});
});

describe("takeover: modem state", () => {
	test("modem state in flight refuses before the sender is pinned or read", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				modemGates: async () => ({
					check: "modem",
					reason: "mutation_in_flight",
				}),
			}),
		);
		expect(outcome).toMatchObject({ reason: "mutation_in_flight" });
		expect(calls.some((call) => call.startsWith("pin:"))).toBe(false);
		expect(statsReads).toBe(0);
		expect(calls).toEqual([`stopUnit:${UNIT}`, "listUnits", "reconcile"]);
	});

	test("an unreadable gate counts as in flight", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				modemGates: async () => {
					throw new Error("EACCES");
				},
			}),
		);
		expect(outcome).toMatchObject({ check: "modem", reason: "unreadable" });
	});

	test("the default gates: journal, internal-call lease, native host record", async () => {
		const leases = join(root, "leases");
		const hosts = join(root, "hosts");
		const dirs = { internalCallLeases: leases, nativeHosts: hosts };
		expect(await defaultModemGates(dirs, async () => [])).toBeNull();
		expect(await defaultModemGates(dirs, async () => [{}])).toEqual({
			check: "modem",
			reason: "mutation_in_flight",
		});
		expect(
			await defaultModemGates(dirs, async () => {
				throw new Error("torn entry");
			}),
		).toEqual({ check: "modem", reason: "journal_unreadable" });
		mkdirSync(leases);
		writeFileSync(join(leases, "slot-1"), "{}");
		expect(await defaultModemGates(dirs, async () => [])).toEqual({
			check: "modem",
			reason: "internal_call_lease",
		});
		rmSync(leases, { recursive: true });
		mkdirSync(hosts);
		writeFileSync(join(hosts, "slot-1.json"), "{}");
		expect(await defaultModemGates(dirs, async () => [])).toEqual({
			check: "modem",
			reason: "native_host_unverified",
		});
		rmSync(hosts, { recursive: true });
		// A file where a directory belongs cannot be listed: unreadable.
		writeFileSync(leases, "");
		expect(await defaultModemGates(dirs, async () => [])).toEqual({
			check: "modem",
			reason: "lease_unreadable",
		});
	});
});

describe("takeover: the fallback itself", () => {
	test("a unit that cannot be confirmed stopped is reported, and no reconciliation follows", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{
					stopUnit: async (unit) => {
						calls.push(`stopUnit:${unit}`);
						return "timed_out";
					},
				},
				{ captureConfig: () => ({ ...CONFIG, max_br: 1 }) },
			),
		);
		expect(outcome).toMatchObject({
			result: "fallback",
			stopped: "timed_out",
		});
		// Stop, see it gone, then reconcile: without the second, no third.
		expect(calls).not.toContain("reconcile");
	});

	test("units that cannot be listed are logged, not guessed", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps(
				{ listUnits: async () => null },
				{ captureConfig: () => ({ ...CONFIG, max_br: 1 }) },
			),
		);
		expect(outcome.result).toBe("fallback");
		// Unknown is not "none left": no reconciliation after it.
		expect(calls).toEqual(["modemGates", `pin:${PID}`, `stopUnit:${UNIT}`]);
	});

	test("an exception anywhere ends in the fallback, never in a throw", async () => {
		const outcome = await takeOverSenderAtStartup(
			deps({
				adoptionIo: () => {
					throw new Error("boom");
				},
			}),
		);
		expect(outcome).toMatchObject({
			result: "fallback",
			check: "takeover",
			reason: "failed",
		});
		expect(calls).toContain(`stopUnit:${UNIT}`);
	});
});
