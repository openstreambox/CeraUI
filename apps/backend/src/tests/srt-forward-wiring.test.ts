import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setupConfigSchema } from "../helpers/config-schemas.ts";
import { superviseForwardListener } from "../modules/ingest/srt-forward.ts";
import { forwardUrls } from "../modules/ingest/srt-forward-core.ts";

test("listener failures retry with bounded backoff, prove idle after cleanup, and stop cancels retry", async () => {
	const states: unknown[] = [],
		delays: number[] = [];
	let attempts = 0;
	const supervisor = superviseForwardListener({
		report: (s) => states.push(s),
		attempt: async () => {
			attempts++;
			throw Error("bind unavailable");
		},
		schedule: (fn, delay) => {
			delays.push(delay);
			return setTimeout(fn, 0);
		},
	});
	await supervisor.ready;
	while (attempts < 8) await Bun.sleep(1);
	await supervisor.stop();
	expect(delays.slice(0, 7)).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000]);
	expect(states.at(-1)).toBe(false);
	const stopped = attempts;
	await Bun.sleep(5);
	expect(attempts).toBe(stopped);
});

test("invalid forwarding config cannot fail backend setup; defaults generate a strong secret", () => {
	const valid = setupConfigSchema.parse({
		hw: "rk3588",
		srt_forward: { host: "192.168.4.1" },
	});
	expect(valid.srt_forward?.passphrase.length).toBeGreaterThanOrEqual(16);
	expect(valid.srt_forward?.maxbw).toBeGreaterThan(0);
	const invalid = setupConfigSchema.parse({
		hw: "rk3588",
		srt_forward: { host: "0.0.0.0", passphrase: "short" },
	});
	expect(invalid.srt_forward).toBeUndefined();
});

test("orphan sender cleanup completes before ingest starts", () => {
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	expect(main.indexOf('await killall(["srtla_send"])')).toBeLessThan(
		main.indexOf('await guardNonCritical("srt-ingest"'),
	);
	expect(main).not.toContain('void killall(["srtla_send"])');
});

import { runForwardAttempt } from "../modules/ingest/srt-forward.ts";
import { setup } from "../modules/setup.ts";
import {
	currentLifecycleHolder,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	getStreamingProcesses,
	stopAll,
} from "../modules/streaming/streamloop/process-runner.ts";
import {
	carryingTracker,
	getCarryingLiveness,
} from "../modules/system/carrying.ts";

test.each([
	"accepted",
	"refused",
	"listener exit",
	"stderr end",
	"overflow",
	"spawn failure",
	"selection change",
])("production wiring recovers: %s", async (scenario) => {
	const previous = setup.srt_forward;
	setup.srt_forward = {
		host: "127.0.0.1",
		port: 19401,
		passphrase: "test-only-secret",
		maxbw: 2500000,
	};
	const abort = new AbortController();
	let stderr!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			stderr = c;
		},
	});
	let exit!: (code: number) => void;
	let stopped = 0;
	const fakeProc = {
		exitCode: null,
		signalCode: null,
		exited: new Promise<number>((r) => {
			exit = r;
		}),
		stdout: new ReadableStream({
			start(c) {
				c.close();
			},
		}),
		stderr: stream,
	};
	let sender: { exitListeners: Array<() => void> } | undefined;
	let spawned = 0;
	const deps: Parameters<typeof runForwardAttempt>[1] = {
		getConfig: () => ({
			srtla_addr: "127.0.0.1",
			srtla_port: 19403,
			srt_streamid: "test",
		}),
		getRelays: () => ({}),
		resolveSrtla: async () => "127.0.0.1",
		prepareSrtlaIpAddresses: async () => ({ changed: false }) as never,
		resolveBindMapArgs: async () => [],
		spawnForwardLoop: () => {
			spawned++;
			sender = { exitListeners: [] };
			return { ...sender, proc: fakeProc } as never;
		},
		onNetworkInterfacesChange: () => () => {},
		startLinkTelemetry: () => {},
		stopLinkTelemetry: () => {},
		superviseWorker: () =>
			({
				proc: fakeProc,
				ready:
					scenario === "spawn failure"
						? Promise.reject(Error("startup"))
						: Promise.resolve(),
				shutdown: async () => {
					stopped++;
					exit(0);
				},
			}) as never,
		awaitRecoveryBarrier: async () => {},
		isUpdating: () => false,
		getIsStreaming: () => scenario === "refused",
		getStreamLifecycleState: () => "idle",
		admitAndPrepareStreamStart: async () => ({ allowed: true }) as never,
		isRecoveryPending: () => false,
		readIps: async () => "127.0.0.1\n",
	};
	const emit = (line: string) =>
		stderr.enqueue(new TextEncoder().encode(`${line}\n`));
	// Sender cleanup uses the owned proc handle, never a name-based sweep.
	const running = runForwardAttempt(abort.signal, deps);
	try {
		if (scenario === "listener exit") exit(1);
		else if (scenario === "stderr end") stderr.close();
		else if (scenario === "overflow")
			stderr.enqueue(new Uint8Array(65537).fill(65));
		else if (scenario !== "spawn failure") {
			if (scenario === "selection change")
				deps.getConfig = () => ({
					srtla_addr: "127.0.0.2",
					srtla_port: 19403,
					srt_streamid: "changed",
				});
			emit("Accepted SRT source connection");
		}
		if (scenario !== "accepted") {
			if (scenario === "spawn failure")
				await expect(running).rejects.toThrow("startup");
			else await running;
			expect(spawned).toBe(0);
			expect(stopped).toBe(1);
			expect(currentLifecycleHolder()).toBeUndefined();
			return;
		}
		while (!spawned) await Bun.sleep(1);
		expect(getCarryingLiveness()).not.toBe("streaming");
		expect(currentLifecycleHolder()).toBe("streaming");
		emit("SRT target connected");
		await Bun.sleep(5);
		expect(getCarryingLiveness()).toBe("streaming");
		expect(currentLifecycleHolder()).toBeUndefined();
		expect(tryAcquireLifecycle("streaming").admitted).toBe(false);
		expect(tryAcquireModemMutation("synthetic").admitted).toBe(false);
		expect(getStreamingProcesses()).toHaveLength(0);
		stopAll();
		expect(stopped).toBe(0);
		for (const fn of sender?.exitListeners ?? []) fn();
		// Mark dead before sender cleanup observes it.
		Object.assign(fakeProc, { exitCode: 1 });
		exit(1);
		await running;
		expect(stopped).toBe(1);
		expect(tryAcquireLifecycle("streaming").admitted).toBe(true);
	} finally {
		abort.abort();
		Object.assign(fakeProc, { exitCode: 0 });
		exit(0);
		await running.catch(() => {});
		setup.srt_forward = previous;
		resetLifecycleInterlock();
		carryingTracker.session("srt-forward", false, performance.now());
	}
});

import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadForwardSecret } from "../modules/ingest/forward-secret.ts";

test("generated secret persists privately and refuses symlinks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-secret-"));
	try {
		const path = join(dir, "secret");
		expect(await loadForwardSecret(path, "generated-test-secret")).toBe(
			"generated-test-secret",
		);
		expect(await loadForwardSecret(path, "different-test-secret")).toBe(
			"generated-test-secret",
		);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await symlink(path, join(dir, "link"));
		await expect(
			loadForwardSecret(join(dir, "link"), "unused-test-secret"),
		).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

import {
	spawnForwardLoop,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";

test("real owned forward process is absent from encoder registry and survives stopAll", async () => {
	const sender = spawnForwardLoop(
		process.execPath,
		["-e", "setInterval(() => {},1000)"],
		() => {},
	);
	try {
		expect(getStreamingProcesses()).not.toContain(sender);
		stopAll();
		await Bun.sleep(60);
		expect(sender.proc.exitCode).toBeNull();
		expect(sender.proc.signalCode).toBeNull();
	} finally {
		await stopProcessAndWait(sender);
	}
});

test.each(["0.0.0.0", "8.8.8.8", "172.32.0.1", "::1"])(
	"refuses non-LAN listener host %s without breaking setup",
	(host) => {
		const config = setupConfigSchema.parse({
			hw: "rk3588",
			srt_forward: { host, passphrase: "test-only-secret" },
		});
		expect(config.srt_forward).toBeUndefined();
		expect(Object.hasOwn(config, "srt_forward")).toBe(true);
	},
);
test.each([9, 80])("rejects a chosen %d-character passphrase", (size) => {
	expect(
		setupConfigSchema.parse({
			hw: "rk3588",
			srt_forward: { host: "127.0.0.1", passphrase: "a".repeat(size) },
		}).srt_forward,
	).toBeUndefined();
});
test("retains ten-character chosen passphrases and applies rate ceiling to both SRT legs", () => {
	const config = setupConfigSchema.parse({
		hw: "rk3588",
		srt_forward: { host: "127.0.0.1", passphrase: "0123456789", maxbw: 500000 },
	});
	expect(config.srt_forward?.passphrase).toBe("0123456789");
	const urls = forwardUrls(
		{ host: "127.0.0.1", port: 4000, passphrase: "0123456789" },
		{ port: 9001, streamid: "synthetic", latency: 200, maxbw: 500000 },
	);
	expect(urls.input).toContain("maxbw=500000");
	expect(urls.output).toContain("maxbw=500000");
});

import { setForwardActive } from "../modules/streaming/forward-activity.ts";
import {
	isLinkTelemetryActive,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";

test("encoder telemetry cleanup cannot retire forward telemetry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forward-telemetry-"));
	try {
		setForwardActive(true);
		startLinkTelemetry(join(dir, "stats"), []);
		expect(isLinkTelemetryActive()).toBe(true);
		stopLinkTelemetry();
		expect(isLinkTelemetryActive()).toBe(true);
		stopLinkTelemetry(true);
		expect(isLinkTelemetryActive()).toBe(false);
	} finally {
		stopLinkTelemetry(true);
		setForwardActive(false);
		await rm(dir, { recursive: true, force: true });
	}
});
