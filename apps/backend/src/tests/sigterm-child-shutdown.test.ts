import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	enforceBackendSingleton,
	releaseBackendSingleton,
	resetBackendSingletonReleaseForTest,
} from "../helpers/backend-singleton.ts";
import { guardNonCritical, runCritical } from "../helpers/boot-guard.ts";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import {
	admitGuardedWork,
	beginShutdown,
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
 * A long-lived monitor stand-in that records the exact argument of every kill
 * (undefined when none was passed). On SIGTERM it exits `exitDelayMs` later,
 * not synchronously, unless `ignoreTerm` is set. It can also die on its own.
 */
class RecordingChild {
	readonly signals: (number | undefined)[] = [];
	readonly exited: Promise<number>;
	hasExited = false;
	#exit: (code: number) => void = () => undefined;
	#ended = false;
	#wake: () => void = () => undefined;

	constructor(
		private readonly ignoreTerm = false,
		private readonly exitDelayMs = 40,
	) {
		this.exited = new Promise<number>((resolve) => {
			this.#exit = resolve;
		});
	}

	kill(signal?: number): void {
		this.signals.push(signal);
		if (signal !== SIGTERM || this.ignoreTerm) return;
		setTimeout(() => this.die(), this.exitDelayMs);
	}

	die(): void {
		this.#ended = true;
		this.#wake();
		this.hasExited = true;
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
	resetBackendSingletonReleaseForTest();
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
		const stopping = manager.stop();
		// SIGTERM is explicit and sent synchronously; the exit comes later.
		expect(spawned[0]?.signals).toEqual([SIGTERM]);
		expect(spawned[0]?.hasExited).toBe(false);
		await stopping;
		expect(spawned[0]?.hasExited).toBe(true);
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
		const stopping = supervisor.stop();
		expect(spawned[0]?.signals).toEqual([SIGTERM]);
		expect(spawned[0]?.hasExited).toBe(false);
		await stopping;
		expect(spawned[0]?.hasExited).toBe(true);
		await sleep(150);
		expect(spawned).toHaveLength(1);
	});

	test("Given a udev inventory read still running, When stop() runs, Then stop joins it and its result publishes nothing", async () => {
		const cache = new UdevProvisionalCache();
		const inventory = Promise.withResolvers<string>();
		let inventoryReads = 0;
		const supervisor = new UdevMonitorSupervisor(
			cache,
			() => new RecordingChild(false, 0),
			() => {
				inventoryReads++;
				return inventory.promise;
			},
		);
		const replace = spyOn(cache, "replaceInventory");
		supervisor.start();
		await until(() => inventoryReads === 1);
		let stopped = false;
		const stopping = supervisor.stop().then(() => {
			stopped = true;
		});
		await sleep(30);
		// The child has exited, but stop() still waits for the inventory read.
		expect(stopped).toBe(false);
		inventory.resolve("P: /devices/fake\nE: SUBSYSTEM=usb\n");
		await stopping;
		await sleep(10);
		expect(replace).not.toHaveBeenCalled();
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
			// The child dies first, so a retry is already sleeping in its
			// 100 ms backoff when shutdown begins.
			spawned[0]?.die();
			await sleep(20);
			beginShutdown();
			await sleep(300);
			expect(spawned).toHaveLength(1);
			expect(resyncs).toBe(0);
			await monitor.stop();
		},
	);
});

describe("guarded work", () => {
	test("Given guarded work admitted while waiting, When settling, Then the drain stays pending until both finished", async () => {
		const first = admitGuardedWork();
		let settledValue: boolean | undefined;
		const settled = settleGuardedWork(1_000).then((value) => {
			settledValue = value;
		});
		const second = admitGuardedWork();
		first?.();
		await sleep(20);
		expect(pendingGuardedWork()).toBe(1);
		expect(settledValue).toBeUndefined();
		second?.();
		await settled;
		expect(settledValue).toBe(true);
	});

	test("Given shutdown began, When work asks for admission, Then it is refused and the drain finishes empty", async () => {
		beginShutdown();
		expect(admitGuardedWork()).toBeUndefined();
		expect(pendingGuardedWork()).toBe(0);
		expect(await settleGuardedWork(30)).toBe(true);
	});

	test("Given guarded work that never finishes, When settling, Then it gives up at the bound", async () => {
		admitGuardedWork();
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
		const finishWrite = admitGuardedWork();
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
		finishWrite?.();
		expect(await exited.promise).toBe(0);
		expect(order).toEqual(["write-finished", "release", "exit"]);
	});

	test("Given guarded work that outlives its bound, When SIGTERM arrives, Then the backend still releases and exits", async () => {
		const order: string[] = [];
		const exited = Promise.withResolvers<number>();
		admitGuardedWork();
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

test("Given a synchronous shutdown hook that throws, When SIGTERM arrives, Then monitors still stop and guardians are still released", async () => {
	const order: string[] = [];
	const exited = Promise.withResolvers<number>();
	handleTerminationSignal("SIGTERM", {
		terminateWifiObservation: () => {
			throw new Error("not started yet");
		},
		stopSrtIngest: async () => undefined,
		stopDmesgWatchers: () => undefined,
		gracefulShutdown: async () => undefined,
		stopMonitors: async () => {
			order.push("monitors");
		},
		releaseGuardians: async () => {
			order.push("release");
		},
		exit: (code) => {
			order.push("exit");
			exited.resolve(code);
		},
	});
	expect(await exited.promise).toBe(0);
	expect(order).toEqual(["monitors", "release", "exit"]);
});

describe("flock guardians", () => {
	test("Given a real orphan-lock guardian held by in-flight work, When SIGTERM arrives, Then exit waits until the holder released it", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-sigterm-guard-"));
		const lock = join(root, "update.lock");
		try {
			const order: string[] = [];
			const exited = Promise.withResolvers<number>();
			const writeMayFinish = Promise.withResolvers<void>();
			let writing = false;
			const work = (async () => {
				await using lease = await acquireOsOrphanLock({
					lock,
					helper: shippedOsStageGuard,
				});
				expect(lease.held()).toBe(true);
				writing = true;
				await writeMayFinish.promise;
				order.push("write-finished");
			})();
			// The protected write has started under the held lease.
			await until(() => writing);
			expect(pendingGuardedWork()).toBe(1);
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

	test("Given shutdown began, When an orphan lock is requested, Then it is refused as contention without spawning a guardian", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-sigterm-refuse-"));
		try {
			beginShutdown();
			await expect(
				acquireOsOrphanLock(
					{ lock: join(root, "update.lock"), helper: shippedOsStageGuard },
					"os_update_lock_held",
				),
			).rejects.toHaveProperty("reason", "os_update_lock_held");
			expect(pendingGuardedWork()).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Given an orphan lock still being acquired, When SIGTERM arrives, Then the drain waits for it and the lease is never handed out", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-sigterm-acquire-"));
		const lock = join(root, "update.lock");
		try {
			const order: string[] = [];
			const exited = Promise.withResolvers<number>();
			// Admission is synchronous: the entry exists before the first await.
			const acquiring = acquireOsOrphanLock(
				{ lock, helper: shippedOsStageGuard },
				"os_update_lock_held",
			).then(
				() => order.push("lease-handed-out"),
				(error: { reason?: string }) =>
					order.push(`refused:${error.reason ?? "unknown"}`),
			);
			expect(pendingGuardedWork()).toBe(1);
			handleTerminationSignal("SIGTERM", {
				stopSrtIngest: async () => undefined,
				stopDmesgWatchers: () => undefined,
				gracefulShutdown: async () => undefined,
				exit: (code) => {
					order.push("exit");
					exited.resolve(code);
				},
			});
			expect(await exited.promise).toBe(0);
			await acquiring;
			expect(order).toEqual(["refused:os_update_lock_held", "exit"]);
			expect(pendingGuardedWork()).toBe(0);
			// The guardian that came up was released: the lock is free again.
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

	test("Given the guardian helper dies mid-scope, When its owner has not disposed yet, Then the work stays guarded", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-sigterm-death-"));
		try {
			const lease = await acquireOsOrphanLock({
				lock: join(root, "update.lock"),
				helper: shippedOsStageGuard,
			});
			expect(pendingGuardedWork()).toBe(1);
			if (!lease.pid) throw new Error("guardian pid missing");
			process.kill(Number(lease.pid), "SIGKILL");
			await until(() => !lease.held());
			await sleep(20);
			expect(pendingGuardedWork()).toBe(1);
			await lease[Symbol.asyncDispose]().catch(() => undefined);
			expect(pendingGuardedWork()).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Given SIGTERM reached the release step before the singleton was acquired, When acquisition completes, Then the guardian is released at once", async () => {
		const exit = spyOn(process, "exit").mockImplementation(
			(() => undefined) as never,
		);
		try {
			const acquired = Promise.withResolvers<void>();
			let disposed = 0;
			const exitedLease = Promise.withResolvers<number>();
			const enforcing = enforceBackendSingleton(async () => {
				await acquired.promise;
				return {
					exited: exitedLease.promise,
					async [Symbol.asyncDispose]() {
						disposed++;
						exitedLease.resolve(0);
					},
				};
			});
			await releaseBackendSingleton();
			expect(disposed).toBe(0);
			acquired.resolve();
			await enforcing;
			await sleep(10);
			expect(disposed).toBe(1);
			expect(exit).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
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

test("production termination handlers are installed at the top of boot and stop the monitors and release the guardians", () => {
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	const code = main.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
	const handlers = code.indexOf('process.on("SIGTERM"');
	expect(handlers).toBeGreaterThan(code.indexOf("installBootSignalGuards()"));
	expect(handlers).toBeLessThan(code.indexOf("await runCritical("));
	expect(handlers).toBeLessThan(code.indexOf("createMonitorManager("));
	expect(handlers).toBeLessThan(code.indexOf("initUdevProvisionalMonitor)"));
	expect(code).toContain('process.on("SIGINT"');
	const stopMonitors = code.slice(
		code.indexOf("async function stopMonitors()"),
		code.indexOf("function terminationDeps()"),
	);
	expect(stopMonitors).toContain("networkMonitorForShutdown?.stop()");
	expect(stopMonitors).toContain("stopUdevProvisionalMonitor()");
	expect(code).toContain("networkMonitorForShutdown = networkMonitor;");
	const deps = code.slice(
		code.indexOf("function terminationDeps()"),
		code.indexOf('process.on("SIGTERM"'),
	);
	expect(deps).toContain("stopMonitors,");
	expect(deps).toContain("releaseGuardians: releaseBackendSingleton,");
});

describe("boot-time SIGTERM", () => {
	test("Given the singleton still being acquired, When SIGTERM runs the real shutdown path, Then the new guardian is released before exit", async () => {
		const exit = spyOn(process, "exit").mockImplementation(
			(() => undefined) as never,
		);
		try {
			const order: string[] = [];
			const exited = Promise.withResolvers<number>();
			const acquired = Promise.withResolvers<void>();
			const exitedLease = Promise.withResolvers<number>();
			const enforcing = enforceBackendSingleton(async () => {
				await acquired.promise;
				return {
					exited: exitedLease.promise,
					async [Symbol.asyncDispose]() {
						order.push("dispose");
						exitedLease.resolve(0);
					},
				};
			});
			handleTerminationSignal("SIGTERM", {
				stopSrtIngest: async () => undefined,
				stopDmesgWatchers: () => undefined,
				gracefulShutdown: async () => undefined,
				releaseGuardians: releaseBackendSingleton,
				exit: (code) => {
					order.push("exit");
					exited.resolve(code);
				},
			});
			// Shutdown reaches its release step while acquisition is still blocked.
			await sleep(50);
			expect(order).toEqual([]);
			acquired.resolve();
			expect(await exited.promise).toBe(0);
			await enforcing;
			expect(order).toEqual(["dispose", "exit"]);
			expect(exit).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
		}
	});

	test.each(["guardNonCritical", "runCritical"] as const)(
		"Given shutdown began, When the ladder reaches a %s step, Then the step does not run and the ladder does not continue",
		async (kind) => {
			beginShutdown();
			let ran = false;
			let continued = false;
			const step = async () => {
				ran = true;
			};
			void (
				kind === "guardNonCritical"
					? guardNonCritical("test-step", step)
					: runCritical("test-step", step)
			).then(() => {
				continued = true;
			});
			await sleep(30);
			expect(ran).toBe(false);
			expect(continued).toBe(false);
		},
	);

	test.each(["guardNonCritical", "runCritical"] as const)(
		"Given a %s step in flight when SIGTERM arrives, When it finishes, Then control does not return to the ladder",
		async (kind) => {
			const release = Promise.withResolvers<void>();
			let continued = false;
			const step = () => release.promise;
			void (
				kind === "guardNonCritical"
					? guardNonCritical("test-step", step)
					: runCritical("test-step", step)
			).then(() => {
				continued = true;
			});
			beginShutdown();
			release.resolve();
			await sleep(30);
			expect(continued).toBe(false);
		},
	);
});
