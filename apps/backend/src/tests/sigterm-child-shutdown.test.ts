import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	enforceBackendSingleton,
	releaseBackendSingleton,
} from "../helpers/backend-singleton.ts";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import {
	beginShutdown,
	holdGuardedWork,
	pendingGuardedWork,
	settleGuardedWork,
	terminateChild,
} from "../helpers/shutdown-state.ts";
import { UdevMonitorSupervisor } from "../modules/cellular/udev-monitor.ts";
import { UdevProvisionalCache } from "../modules/cellular/udev-provisional-cache.ts";
import { NmcliMonitorManager } from "../modules/network/monitor/monitor-manager.ts";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import { shippedOsStageGuard } from "./helpers/os-stage-test-guard.ts";

const SIGTERM = 15;
const SIGKILL = 9;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await sleep(5);
	}
}

/**
 * A long-lived monitor stand-in that records every signal it receives. It
 * exits on SIGTERM unless `ignoreTerm` is set, and can also die on its own.
 */
class RecordingChild {
	readonly signals: number[] = [];
	readonly exited: Promise<number>;
	#exit: (code: number) => void = () => undefined;
	#ended = false;
	#wake: () => void = () => undefined;

	constructor(private readonly ignoreTerm = false) {
		this.exited = new Promise<number>((resolve) => {
			this.#exit = resolve;
		});
	}

	kill(signal?: number): void {
		this.signals.push(signal ?? SIGTERM);
		if ((signal ?? SIGTERM) === SIGTERM && this.ignoreTerm) return;
		this.die();
	}

	die(): void {
		this.#ended = true;
		this.#wake();
		this.#exit(0);
	}

	get stdout(): AsyncIterable<Uint8Array> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				while (!self.#ended) {
					await new Promise<void>((resolve) => {
						self.#wake = resolve;
					});
				}
			},
		};
	}
}

afterEach(() => {
	resetShutdownForTest();
});

describe("terminateChild", () => {
	test("Given a real child that traps SIGTERM, When terminated, Then it records SIGTERM and exits in time", async () => {
		const child = Bun.spawn(
			[
				"sh",
				"-c",
				'trap "echo TERM; exit 0" TERM; echo READY; while :; do sleep 0.05; done',
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		const first = await reader.read();
		expect(decoder.decode(first.value)).toBe("READY\n");

		expect(await terminateChild(child, 2_000)).toBe(true);
		let rest = "";
		for (
			let chunk = await reader.read();
			!chunk.done;
			chunk = await reader.read()
		)
			rest += decoder.decode(chunk.value, { stream: true });
		expect(rest).toBe("TERM\n");
		expect(child.signalCode).toBeNull();
		expect(child.exitCode).toBe(0);
	});

	test("Given a child that ignores SIGTERM, When the grace elapses, Then it is left running and never SIGKILLed", async () => {
		const child = new RecordingChild(true);
		const started = Date.now();
		expect(await terminateChild(child, 50)).toBe(false);
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
		expect(child.signals).toEqual([SIGTERM]);
		child.die();
	});
});

describe("monitor supervisors stop with SIGTERM", () => {
	test("Given a running nmcli monitor, When stop() resolves, Then the child got only SIGTERM and has exited", async () => {
		const spawned: RecordingChild[] = [];
		const manager = new NmcliMonitorManager(
			() => undefined,
			() => {
				const child = new RecordingChild();
				spawned.push(child);
				return child;
			},
		);
		manager.start();
		await until(() => spawned.length === 1);
		await manager.stop();
		expect(spawned[0]?.signals).toEqual([SIGTERM]);
		expect(spawned[0]?.signals).not.toContain(SIGKILL);
		await sleep(150);
		expect(spawned).toHaveLength(1);
	});

	test("Given a running udevadm monitor, When stop() resolves, Then the child got only SIGTERM and has exited", async () => {
		const spawned: RecordingChild[] = [];
		const supervisor = new UdevMonitorSupervisor(
			new UdevProvisionalCache(),
			() => {
				const child = new RecordingChild();
				spawned.push(child);
				return child;
			},
			async () => "",
		);
		supervisor.start();
		await until(() => spawned.length === 1);
		await supervisor.stop();
		expect(spawned[0]?.signals).toEqual([SIGTERM]);
		await sleep(150);
		expect(spawned).toHaveLength(1);
	});
});

describe("no monitor starts once shutdown has begun", () => {
	test("Given shutdown began, When either monitor is started, Then nothing is spawned", async () => {
		let spawns = 0;
		const spawn = () => {
			spawns++;
			return new RecordingChild();
		};
		beginShutdown();
		const manager = new NmcliMonitorManager(() => undefined, spawn);
		const supervisor = new UdevMonitorSupervisor(
			new UdevProvisionalCache(),
			spawn,
			async () => "",
		);
		manager.start();
		supervisor.start();
		await sleep(50);
		expect(spawns).toBe(0);
		expect(manager.isRunning).toBe(false);
		expect(supervisor.isRunning).toBe(false);
	});

	test.each(["nmcli", "udevadm"] as const)(
		"Given a %s monitor whose child dies after shutdown began, When the backoff elapses, Then it is not respawned",
		async (kind) => {
			const spawned: RecordingChild[] = [];
			let resyncs = 0;
			const spawn = () => {
				const child = new RecordingChild();
				spawned.push(child);
				return child;
			};
			const monitor =
				kind === "nmcli"
					? new NmcliMonitorManager(() => {
							resyncs++;
						}, spawn)
					: new UdevMonitorSupervisor(
							new UdevProvisionalCache(),
							spawn,
							async () => "",
						);
			monitor.start();
			await until(() => spawned.length === 1);
			// SIGTERM reaches the process group: the child dies before stop() runs.
			beginShutdown();
			spawned[0]?.die();
			// Longer than the 100 ms first backoff step.
			await sleep(300);
			expect(spawned).toHaveLength(1);
			expect(resyncs).toBe(0);
			await monitor.stop();
		},
	);
});

describe("guarded work", () => {
	test("Given guarded work registered while waiting, When settling, Then both entries are waited for", async () => {
		const first = holdGuardedWork();
		const settled = settleGuardedWork(1_000);
		const second = holdGuardedWork();
		first();
		await sleep(20);
		expect(pendingGuardedWork()).toBe(1);
		second();
		expect(await settled).toBe(true);
	});

	test("Given guarded work that never finishes, When settling, Then it gives up at the bound", async () => {
		holdGuardedWork();
		expect(await settleGuardedWork(30)).toBe(false);
	});
});

describe("SIGTERM path ordering", () => {
	const baseDeps = {
		stopSrtIngest: async () => undefined,
		stopDmesgWatchers: () => undefined,
		gracefulShutdown: async () => undefined,
	};

	test("Given a guarded write in flight, When SIGTERM arrives, Then guardians are released only after it finished, and exit comes last", async () => {
		const order: string[] = [];
		const exited = Promise.withResolvers<number>();
		const finishWrite = holdGuardedWork();
		handleTerminationSignal("SIGTERM", {
			...baseDeps,
			releaseGuardians: async () => {
				order.push("release");
			},
			exit: (code) => {
				order.push("exit");
				exited.resolve(code);
			},
		});
		await sleep(50);
		expect(order).toEqual([]);
		order.push("write-finished");
		finishWrite();
		expect(await exited.promise).toBe(0);
		expect(order).toEqual(["write-finished", "release", "exit"]);
	});

	test("Given guarded work that outlives its bound, When SIGTERM arrives, Then the backend still releases and exits", async () => {
		const order: string[] = [];
		const exited = Promise.withResolvers<number>();
		holdGuardedWork();
		handleTerminationSignal("SIGTERM", {
			...baseDeps,
			guardedWorkGraceMs: 30,
			releaseGuardians: async () => {
				order.push("release");
			},
			exit: (code) => {
				order.push("exit");
				exited.resolve(code);
			},
		});
		expect(await exited.promise).toBe(0);
		expect(order).toEqual(["release", "exit"]);
	});

	test("Given monitors to stop, When SIGTERM arrives, Then they stop alongside teardown and before exit", async () => {
		const order: string[] = [];
		const exited = Promise.withResolvers<number>();
		const teardown = Promise.withResolvers<void>();
		const child = new RecordingChild();
		handleTerminationSignal("SIGTERM", {
			...baseDeps,
			gracefulShutdown: async () => {
				await teardown.promise;
				order.push("streaming");
			},
			stopMonitors: async () => {
				order.push("monitors-signalled");
				await terminateChild(child, 500);
				order.push("monitors-exited");
			},
			releaseGuardians: async () => {
				order.push("release");
			},
			exit: (code) => {
				order.push("exit");
				exited.resolve(code);
			},
		});
		// The monitors were signalled before streaming teardown finished.
		await until(() => order.includes("monitors-exited"));
		expect(order).toEqual(["monitors-signalled", "monitors-exited"]);
		teardown.resolve();
		expect(await exited.promise).toBe(0);
		expect(order).toEqual([
			"monitors-signalled",
			"monitors-exited",
			"streaming",
			"release",
			"exit",
		]);
		expect(child.signals).toEqual([SIGTERM]);
	});
});

describe("flock guardians", () => {
	test("Given a real orphan-lock guardian held by in-flight work, When SIGTERM arrives, Then exit waits until the holder released it", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-sigterm-guard-"));
		const lock = join(root, "update.lock");
		try {
			const order: string[] = [];
			const exited = Promise.withResolvers<number>();
			const writeMayFinish = Promise.withResolvers<void>();
			const work = (async () => {
				await using lease = await acquireOsOrphanLock({
					lock,
					helper: shippedOsStageGuard,
				});
				expect(lease.held()).toBe(true);
				await writeMayFinish.promise;
				order.push("write-finished");
			})();
			await until(() => pendingGuardedWork() === 1);
			handleTerminationSignal("SIGTERM", {
				stopSrtIngest: async () => undefined,
				stopDmesgWatchers: () => undefined,
				gracefulShutdown: async () => undefined,
				exit: (code) => {
					order.push("exit");
					exited.resolve(code);
				},
			});
			await sleep(100);
			expect(order).toEqual([]);
			writeMayFinish.resolve();
			expect(await exited.promise).toBe(0);
			await work;
			expect(order).toEqual(["write-finished", "exit"]);
			expect(pendingGuardedWork()).toBe(0);
			// The guardian released the lock: a new holder gets it at once.
			const probe = Bun.spawn(["flock", "-n", "-E", "75", "-x", lock, "true"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await probe.exited).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Given the singleton lease, When it is released at shutdown, Then the guardian is told to release and the exit is not read as a lost lock", async () => {
		const exit = spyOn(process, "exit").mockImplementation(
			(() => undefined) as never,
		);
		try {
			const exitedLease = Promise.withResolvers<number>();
			let disposed = 0;
			await enforceBackendSingleton(async () => ({
				exited: exitedLease.promise,
				async [Symbol.asyncDispose]() {
					disposed++;
					exitedLease.resolve(0);
				},
			}));
			await releaseBackendSingleton();
			await sleep(10);
			expect(disposed).toBe(1);
			expect(exit).not.toHaveBeenCalled();
			// A second release is a no-op.
			await releaseBackendSingleton();
			expect(disposed).toBe(1);
		} finally {
			exit.mockRestore();
		}
	});

	test("Given a singleton guardian that hangs on release, When the bound elapses, Then release returns anyway", async () => {
		await enforceBackendSingleton(async () => ({
			exited: new Promise<number>(() => undefined),
			async [Symbol.asyncDispose]() {
				await new Promise<void>(() => undefined);
			},
		}));
		const started = Date.now();
		await releaseBackendSingleton(40);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

test("production SIGTERM and SIGINT handlers stop the monitors and release the guardians", () => {
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	const stopMonitors = main.slice(
		main.indexOf("async function stopMonitors()"),
		main.indexOf('process.on("SIGTERM"'),
	);
	expect(stopMonitors).toContain("networkMonitor.stop()");
	expect(stopMonitors).toContain("stopUdevProvisionalMonitor()");
	for (const signal of ["SIGTERM", "SIGINT"]) {
		const start = main.indexOf(`process.on("${signal}"`);
		const handler = main.slice(
			start,
			main.indexOf("exit: process.exit", start),
		);
		expect(handler).toContain("stopMonitors,");
		expect(handler).toContain("releaseGuardians: releaseBackendSingleton,");
	}
});
