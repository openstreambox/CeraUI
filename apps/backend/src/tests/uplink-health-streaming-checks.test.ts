import { expect, test } from "bun:test";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import {
	buildDeviceBoundProbeArgv,
	DEVICE_PROBE_MAX_BYTES,
} from "../modules/network/device-bound-probe.ts";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	CONNECTIVITY_TARGET_FAILURE_REFRESH_MS,
	createConnectivityTargetResolver,
} from "../modules/network/uplink-health/connectivity-target.ts";
import {
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
} from "../modules/network/uplink-health/model.ts";
import { resolveUplinkHealthTarget } from "../modules/network/uplink-health/runtime.ts";
import {
	type StreamingDiagnostic,
	UplinkHealthRuntimeCore,
	type UplinkHealthRuntimeCoreDeps,
} from "../modules/network/uplink-health/runtime-core.ts";
import type { LinkTelemetryMessage } from "../modules/streaming/link-telemetry-rows.ts";

/*
  Diagnostic checks of streamed links, and the check-address handling every
  check shares. While a stream runs, a bonded link that sent nothing for
  `streamingQuietMs` gets a check of its own. Its answer is logged and kept,
  and never changes the link's verdict, steering or any recovery decision.
*/

const QUIET = UPLINK_HEALTH_CONFIG.streamingQuietMs;

function row(
	overrides: Partial<LinkTelemetryMessage["links"][number]> = {},
): LinkTelemetryMessage["links"][number] {
	return {
		conn_id: "0",
		iface: "wwan0",
		rtt_ms: 80,
		nak_count: 0,
		weight_percent: 50,
		bitrate_bps: 0,
		stale: false,
		...overrides,
	};
}

function core(options: {
	now: () => number;
	telemetry: () => LinkTelemetryMessage | null;
	quiet?: number | undefined;
	streaming?: () => boolean;
	probe?: () => UplinkHealthOutcome;
	probeAt?: (target: string) => UplinkHealthOutcome;
	resolveTarget?: UplinkHealthRuntimeCoreDeps["resolveTarget"];
	interfaces?: Record<string, NetworkInterface>;
	onInterfacesChange?: UplinkHealthRuntimeCoreDeps["onInterfacesChange"];
	monotonic?: () => number;
	alternateTarget?: UplinkHealthRuntimeCoreDeps["alternateTarget"];
	targetFailed?: UplinkHealthRuntimeCoreDeps["targetFailed"];
}) {
	const interfaces = options.interfaces ?? {
		wwan0: { ip: "10.64.0.2", error: 0, tp: 0, txb: 0 },
	};
	const probes: string[] = [];
	const logged: StreamingDiagnostic[] = [];
	const engine = new UplinkHealthEngine();
	const runtime = new UplinkHealthRuntimeCore(
		{
			now: options.now,
			interfaces: () => interfaces,
			onInterfacesChange: options.onInterfacesChange,
			streaming: options.streaming ?? (() => true),
			telemetry: options.telemetry,
			quietForMs: () => options.quiet,
			monotonicNow: options.monotonic ?? options.now,
			alternateTarget: options.alternateTarget,
			targetFailed: options.targetFailed,
			logDiagnostic: (entry) => logged.push(entry),
			resolveTarget: options.resolveTarget ?? (async () => "192.0.2.204"),
			probe: async (candidate, target) => {
				probes.push(candidate.name);
				return options.probeAt?.(target) ?? options.probe?.() ?? "failure";
			},
			publish: () => {},
			exclusionReason: (entry) => (entry?.ip ? undefined : "no address"),
			candidates: (all) =>
				Object.entries(all).flatMap(([name, entry]): ProbeCandidate[] =>
					entry.ip
						? [
								{
									name,
									ip: entry.ip,
									binding: { kind: "device", ifname: name },
								},
							]
						: [],
				),
			identity: () => ({ kind: "cellular" }),
		},
		engine,
	);
	return { runtime, engine, probes, logged, interfaces };
}

function quietTelemetry(now: () => number, overrides = {}) {
	return () => ({
		links: [row(overrides)],
		not_carrying_ifaces: ["wwan0"],
		measured_bps: 0,
		lastReadMs: now(),
	});
}

test("a failing diagnostic check changes nothing: the verdict, the streak and the probe evidence stay passive", async () => {
	let now = 100_000;
	const { runtime, engine, probes } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: quietTelemetry(() => now),
	});
	for (let round = 0; round < 20; round++, now += 5_000) await runtime.tick();
	expect(probes.length).toBeGreaterThan(0);
	expect(runtime.diagnostics()).toMatchObject([
		{ iface: "wwan0", outcome: "failure", quietMs: 60_000 },
	]);
	expect(engine.get("wwan0")).toMatchObject({
		state: "up",
		probes: { failures: 0 },
	});
	expect(engine.lastProbe("wwan0")).toBeUndefined();
});

test("no diagnostic check without a stream", async () => {
	const now = 100_000;
	const { runtime, probes } = core({
		now: () => now,
		quiet: 60_000,
		streaming: () => false,
		telemetry: quietTelemetry(() => now),
		probe: () => "success",
	});
	await runtime.tick();
	// Between streams the link is checked for its verdict, not as a diagnostic.
	expect(probes).toEqual(["wwan0"]);
	expect(runtime.diagnostics()).toEqual([]);
});

test("a not-carrying verdict from an expired snapshot gets no diagnostic check", async () => {
	const now = 100_000;
	const { runtime, probes } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: () => ({
			links: [row()],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now - UPLINK_HEALTH_CONFIG.telemetryExpiryMs,
		}),
	});
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(runtime.diagnostics()).toEqual([]);
});

test("a stale sender row gets no diagnostic check", async () => {
	const now = 100_000;
	const { runtime, probes } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: quietTelemetry(() => now, { stale: true }),
	});
	await runtime.tick();
	expect(probes).toEqual([]);
});

test("a link that sent something within the quiet span gets no diagnostic check", async () => {
	const now = 100_000;
	const short = core({
		now: () => now,
		quiet: QUIET - 1,
		telemetry: quietTelemetry(() => now),
	});
	await short.runtime.tick();
	expect(short.probes).toEqual([]);
	const long = core({
		now: () => now,
		quiet: QUIET,
		telemetry: quietTelemetry(() => now),
	});
	await long.runtime.tick();
	expect(long.probes).toEqual(["wwan0"]);
	const unknown = core({
		now: () => now,
		quiet: undefined,
		telemetry: quietTelemetry(() => now),
	});
	await unknown.runtime.tick();
	expect(unknown.probes).toEqual([]);
});

test("a diagnostic is dropped when the link changed while the target resolved", async () => {
	let now = 100_000;
	let changed: (() => void) | undefined;
	const interfaces: Record<string, NetworkInterface> = {
		wwan0: { ip: "10.64.0.2", error: 0, tp: 0, txb: 0 },
	};
	const { runtime, probes } = core({
		now: () => now,
		quiet: 60_000,
		interfaces,
		onInterfacesChange: (callback) => {
			changed = callback;
			return () => {};
		},
		telemetry: quietTelemetry(() => now),
		resolveTarget: async () => {
			const entry = interfaces.wwan0;
			if (entry) entry.ip = "10.64.0.9";
			now += 1;
			changed?.();
			return "192.0.2.204";
		},
	});
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(runtime.diagnostics()).toEqual([]);
});

test("a diagnostic is dropped when the link changed and changed back while the target resolved", async () => {
	let now = 100_000;
	let changed: (() => void) | undefined;
	const interfaces: Record<string, NetworkInterface> = {
		wwan0: { ip: "10.64.0.2", error: 0, tp: 0, txb: 0 },
	};
	const { runtime, probes } = core({
		now: () => now,
		quiet: 60_000,
		interfaces,
		onInterfacesChange: (callback) => {
			changed = callback;
			return () => {};
		},
		telemetry: quietTelemetry(() => now),
		resolveTarget: async () => {
			// A -> B -> A: the same address again, but a new interface epoch.
			const entry = interfaces.wwan0;
			if (entry) entry.ip = "10.64.0.9";
			changed?.();
			if (entry) entry.ip = "10.64.0.2";
			now += 1;
			changed?.();
			return "192.0.2.204";
		},
	});
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(runtime.diagnostics()).toEqual([]);
});

test("diagnostic checks of one link stay within the hourly budget, on the monotonic clock", async () => {
	let now = 0;
	let mono = 0;
	const { runtime, probes } = core({
		now: () => now,
		monotonic: () => mono,
		quiet: 3_600_000,
		probe: () => "success",
		telemetry: quietTelemetry(() => now),
	});
	for (let round = 0; round < 720; round++) {
		await runtime.tick();
		mono += 5_000;
		// The wall clock jumps an hour forward and back again in between.
		now += round === 100 ? 3_600_000 : round === 200 ? -3_600_000 : 5_000;
	}
	const { perHour, burst } = UPLINK_HEALTH_CONFIG.streamingProbeBudget;
	expect(probes.length).toBeGreaterThanOrEqual(perHour);
	expect(probes.length).toBeLessThanOrEqual(perHour + burst);
});

test("a diagnostic answer is logged when it changes, not on every check", async () => {
	let now = 100_000;
	let answer: UplinkHealthOutcome = "success";
	const { runtime, logged } = core({
		now: () => now,
		quiet: 60_000,
		probe: () => answer,
		telemetry: quietTelemetry(() => now),
	});
	for (let round = 0; round < 6; round++, now += 5_000) await runtime.tick();
	answer = "failure";
	for (let round = 0; round < 6; round++, now += 5_000) await runtime.tick();
	expect(logged.map((entry) => entry.outcome)).toEqual(["success", "failure"]);
});

test("a down streamed link is checked for its verdict, not as a diagnostic", async () => {
	let now = 100_000;
	const { runtime, engine } = core({
		now: () => now,
		quiet: 60_000,
		streaming: () => false,
		telemetry: quietTelemetry(() => now),
	});
	for (let round = 0; round < 3; round++, now += 5_000) await runtime.tick();
	expect(engine.get("wwan0")?.state).toBe("down");
	expect(runtime.diagnostics()).toEqual([]);
});

test("a failed check is retried at the next address before it counts", async () => {
	const now = 100_000;
	const failedTargets: string[] = [];
	const { runtime, engine } = core({
		now: () => now,
		streaming: () => false,
		telemetry: () => null,
		probeAt: (target) => (target === "192.0.2.204" ? "failure" : "success"),
		alternateTarget: (_family, failed) =>
			failed === "192.0.2.204" ? "192.0.2.205" : undefined,
		targetFailed: (_family, target) => failedTargets.push(target),
	});
	await runtime.tick();
	expect(failedTargets).toEqual(["192.0.2.204"]);
	expect(engine.get("wwan0")).toMatchObject({
		state: "up",
		probes: { failures: 0 },
	});
	expect(engine.lastProbe("wwan0")).toMatchObject({ outcome: "success" });
});

test("a failed check at every address counts, and is the link's real probe evidence", async () => {
	const now = 100_000;
	const { runtime, engine } = core({
		now: () => now,
		streaming: () => false,
		telemetry: () => null,
		probeAt: () => "failure",
		alternateTarget: () => "192.0.2.205",
	});
	await runtime.tick();
	expect(engine.get("wwan0")?.probes.failures).toBe(1);
	expect(engine.lastProbe("wwan0")).toMatchObject({ outcome: "failure" });
});

test("rotation walks every address of the answer", async () => {
	let now = 0;
	const addresses = ["192.0.2.204", "192.0.2.205", "192.0.2.206"];
	const target = createConnectivityTargetResolver({
		now: () => now,
		resolve: async () => ({ addrs: addresses, fromCache: false }),
	});
	const attempted = new Set<string>();
	const { runtime, engine } = core({
		now: () => now,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: target,
		alternateTarget: target.alternate,
		targetFailed: target.failed,
		probeAt: (ip) => {
			attempted.add(ip);
			return ip === addresses[2] ? "success" : "failure";
		},
	});
	for (; now <= 600_000; now += 5_000) await runtime.tick();
	expect([...attempted].sort()).toEqual(addresses);
	expect(engine.get("wwan0")?.state).toBe("up");
});

test("after a failed check the resolver serves the next address and looks the name up again, at most once a minute", async () => {
	let clock = 0;
	let lookups = 0;
	let dnsDown = false;
	const target = createConnectivityTargetResolver({
		now: () => clock,
		resolve: async () => {
			lookups++;
			if (dnsDown) throw new Error("no DNS");
			return {
				addrs: ["192.0.2.204", "192.0.2.205", "2001:db8::204"],
				fromCache: false,
			};
		},
	});
	expect(await target(4)).toBe("192.0.2.204");
	expect(target.alternate(4, "192.0.2.204")).toBe("192.0.2.205");
	expect(target.alternate(6, "2001:db8::204")).toBeUndefined();
	dnsDown = true;
	target.failed(4, "192.0.2.204");
	expect(await target(4)).toBe("192.0.2.205");
	expect(lookups).toBe(2);
	clock += 10_000;
	target.failed(4, "192.0.2.205");
	expect(await target(4)).toBe("192.0.2.204");
	expect(lookups).toBe(2);
	clock += CONNECTIVITY_TARGET_FAILURE_REFRESH_MS;
	target.failed(4, "192.0.2.204");
	await target(4);
	expect(lookups).toBe(3);
});

test("the production resolver keeps the family each source asks for", async () => {
	const asked: (4 | 6 | undefined)[] = [];
	const resolve = async (family?: 4 | 6) => {
		asked.push(family);
		return family === 6 ? "2001:db8::204" : "192.0.2.204";
	};
	expect(await resolveUplinkHealthTarget(resolve, () => false, 6)).toBe(
		"2001:db8::204",
	);
	expect(await resolveUplinkHealthTarget(resolve, () => false, 4)).toBe(
		"192.0.2.204",
	);
	expect(asked).toEqual([6, 4]);
});

test("one check downloads at most a bounded body", () => {
	const argv = buildDeviceBoundProbeArgv("192.0.2.204", "wwan0");
	expect(argv[argv.indexOf("--max-filesize") + 1]).toBe(
		String(DEVICE_PROBE_MAX_BYTES),
	);
});
