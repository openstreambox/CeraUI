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
	UplinkHealthRuntimeCore,
	type UplinkHealthRuntimeCoreDeps,
} from "../modules/network/uplink-health/runtime-core.ts";
import type { LinkTelemetryMessage } from "../modules/streaming/link-telemetry-rows.ts";

/*
  The guards around checking a streamed link by probe instead of its sender
  row. Each case feeds the health core one shape of sender evidence and
  counts the checks it sends.
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
	probe?: () => UplinkHealthOutcome;
	resolveTarget?: UplinkHealthRuntimeCoreDeps["resolveTarget"];
	interfaces?: Record<string, NetworkInterface>;
	onInterfacesChange?: UplinkHealthRuntimeCoreDeps["onInterfacesChange"];
	monotonic?: () => number;
	alternateTarget?: UplinkHealthRuntimeCoreDeps["alternateTarget"];
	targetFailed?: UplinkHealthRuntimeCoreDeps["targetFailed"];
	probeAt?: (target: string) => UplinkHealthOutcome;
}) {
	const interfaces = options.interfaces ?? {
		wwan0: { ip: "10.64.0.2", error: 0, tp: 0, txb: 0 },
	};
	const probes: string[] = [];
	const engine = new UplinkHealthEngine();
	const runtime = new UplinkHealthRuntimeCore(
		{
			now: options.now,
			interfaces: () => interfaces,
			onInterfacesChange: options.onInterfacesChange,
			streaming: () => true,
			telemetry: options.telemetry,
			quietForMs: () => options.quiet,
			monotonicNow: options.monotonic ?? options.now,
			alternateTarget: options.alternateTarget,
			targetFailed: options.targetFailed,
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
	return { runtime, engine, probes, interfaces };
}

test("a not-carrying verdict from an expired snapshot does not promote the link", async () => {
	const now = 100_000;
	const { runtime, probes, engine } = core({
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
	expect(engine.get("wwan0")).toMatchObject({
		state: "down",
		reason: "definitive_loss",
	});
});

test("a stale sender row keeps the link on its passive verdict", async () => {
	const now = 100_000;
	const { runtime, probes, engine } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: () => ({
			links: [row({ stale: true })],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now,
		}),
	});
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(engine.get("wwan0")).toMatchObject({
		state: "degraded",
		reason: "passive_congestion",
	});
});

test("a link quiet for less than the streaming quiet span is not checked", async () => {
	const now = 100_000;
	const telemetry = () => ({
		links: [row()],
		not_carrying_ifaces: ["wwan0"],
		measured_bps: 0,
		lastReadMs: now,
	});
	const short = core({ now: () => now, quiet: QUIET - 1, telemetry });
	await short.runtime.tick();
	expect(short.probes).toEqual([]);
	const long = core({ now: () => now, quiet: QUIET, telemetry });
	await long.runtime.tick();
	expect(long.probes).toEqual(["wwan0"]);
	const none = core({ now: () => now, quiet: undefined, telemetry });
	await none.runtime.tick();
	expect(none.probes).toEqual([]);
});

test("a failed check while the link sent data during it keeps the passive verdict", async () => {
	let now = 100_000;
	let quiet: number | undefined = QUIET;
	const { runtime, engine } = core({
		now: () => now,
		get quiet() {
			return quiet;
		},
		telemetry: () => ({
			links: [row()],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now,
		}),
		probe: () => {
			// A burst goes out while the check is in flight.
			now += 3_000;
			quiet = 1_000;
			return "failure";
		},
	});
	for (let round = 0; round < 5; round++) {
		quiet = QUIET;
		await runtime.tick();
	}
	expect(engine.get("wwan0")).toMatchObject({
		state: "up",
		probes: { failures: 0 },
	});
});

test("the passive fallback is dropped when the link changed while the target resolved", async () => {
	let now = 100_000;
	let changed: (() => void) | undefined;
	const interfaces: Record<string, NetworkInterface> = {
		wwan0: { ip: "10.64.0.2", error: 0, tp: 0, txb: 0 },
	};
	const { runtime, engine, probes } = core({
		now: () => now,
		quiet: 60_000,
		interfaces,
		onInterfacesChange: (callback) => {
			changed = callback;
			return () => {};
		},
		// Degraded passive evidence, so an applied fallback would be visible.
		telemetry: () => ({
			links: [row({ rtt_ms: 1_500 })],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now,
		}),
		resolveTarget: async () => {
			// The modem gets a new address while the check address resolves, and
			// no address resolves.
			const entry = interfaces.wwan0;
			if (entry) entry.ip = "10.64.0.9";
			now += 1;
			changed?.();
			return undefined;
		},
	});
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(engine.get("wwan0")?.state ?? "up").toBe("up");
});

test("without a check address the quiet link keeps its last verdict but lets it age out", async () => {
	let now = 100_000;
	let quiet: number | undefined = 1_000;
	const { runtime, engine, probes } = core({
		now: () => now,
		get quiet() {
			return quiet;
		},
		telemetry: () => ({
			links: [row({ rtt_ms: 1_500 })],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now,
		}),
		resolveTarget: async () => undefined,
	});
	// Still sending: the passive verdict (degraded on RTT) is recorded.
	await runtime.tick();
	expect(engine.get("wwan0")).toMatchObject({ state: "degraded" });
	// Quiet, and no check address: nothing is measured, nothing changes.
	quiet = 60_000;
	now += 60_000;
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(engine.get("wwan0")).toMatchObject({ state: "degraded" });
	// Nothing measured it for 60 s: unknown, not fresh.
	expect((engine.get("wwan0")?.staleAt ?? 0) <= now).toBe(true);
});

test("streaming checks of one link stay within the hourly budget", async () => {
	let now = 0;
	const { runtime, probes } = core({
		now: () => now,
		quiet: 3_600_000,
		probe: () => "success",
		telemetry: () => ({
			links: [row()],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now,
		}),
	});
	for (; now < 3_600_000; now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs) {
		await runtime.tick();
	}
	const { perHour, burst, reservePerHour, reserveBurst } =
		UPLINK_HEALTH_CONFIG.streamingProbeBudget;
	// 720 rounds in the hour; the bursts, then one check per refilled token.
	expect(probes.length).toBeGreaterThanOrEqual(perHour);
	expect(probes.length).toBeLessThanOrEqual(
		perHour + burst + reservePerHour + reserveBurst,
	);
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

function quietTelemetry(now: () => number) {
	return () => ({
		links: [row()],
		not_carrying_ifaces: ["wwan0"],
		measured_bps: 0,
		lastReadMs: now(),
	});
}

test("rounds without a check token keep the failure streak instead of resetting it", async () => {
	let now = 0;
	let answer: UplinkHealthOutcome = "success";
	const { runtime, engine } = core({
		now: () => now,
		quiet: 3_600_000,
		probe: () => answer,
		telemetry: quietTelemetry(() => now),
	});
	// Spend the burst on a healthy link, then it goes black.
	for (let round = 0; round < 40; round++, now += 5_000) await runtime.tick();
	answer = "failure";
	let streak = 0;
	for (let round = 0; round < 60; round++, now += 5_000) {
		await runtime.tick();
		const failures = engine.get("wwan0")?.probes.failures ?? 0;
		// Held rounds never reset it; it only grows.
		expect(failures).toBeGreaterThanOrEqual(streak);
		streak = failures;
	}
	expect(engine.get("wwan0")).toMatchObject({
		state: "down",
		reason: "probe_failed",
	});
	expect(streak).toBeGreaterThanOrEqual(6);
});

test("a down link that stays quiet is metered too", async () => {
	let now = 0;
	const { runtime, probes } = core({
		now: () => now,
		quiet: 3_600_000,
		probe: () => "failure",
		telemetry: quietTelemetry(() => now),
	});
	for (; now < 3_600_000; now += UPLINK_HEALTH_CONFIG.probeRoundCadenceMs) {
		await runtime.tick();
	}
	const { perHour, burst, reservePerHour, reserveBurst } =
		UPLINK_HEALTH_CONFIG.streamingProbeBudget;
	// 720 rounds in the hour, down for nearly all of them.
	expect(probes.length).toBeLessThanOrEqual(
		perHour + burst + reservePerHour + reserveBurst,
	);
});

test("a wall-clock jump does not refill the check budget", async () => {
	let now = 0;
	let mono = 0;
	const { runtime, probes } = core({
		now: () => now,
		monotonic: () => mono,
		quiet: 3_600_000,
		probe: () => "success",
		telemetry: quietTelemetry(() => now),
	});
	for (let round = 0; round < 40; round++) {
		await runtime.tick();
		mono += 5_000;
		// The wall clock is set back and forward by an hour in between.
		now += round === 20 ? 3_600_000 : round === 30 ? -3_600_000 : 5_000;
	}
	const { burst, perHour } = UPLINK_HEALTH_CONFIG.streamingProbeBudget;
	// 200 s of monotonic time: the burst plus what 200 s refill, no more.
	expect(probes.length).toBeLessThanOrEqual(
		burst + Math.ceil((200_000 * perHour) / 3_600_000),
	);
});

test("a failed check is retried at another address before it counts", async () => {
	const now = 100_000;
	const failedTargets: string[] = [];
	const { runtime, engine } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: quietTelemetry(() => now),
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

test("a failed check at every address counts", async () => {
	const now = 100_000;
	const { runtime, engine } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: quietTelemetry(() => now),
		probeAt: () => "failure",
		alternateTarget: () => "192.0.2.205",
	});
	await runtime.tick();
	expect(engine.get("wwan0")?.probes.failures).toBe(1);
	expect(engine.lastProbe("wwan0")).toMatchObject({ outcome: "failure" });
});

test("after a failed check the resolver serves another address and looks the name up again, at most once a minute", async () => {
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
	// The cached address stops answering while DNS is down too.
	dnsDown = true;
	target.failed(4, "192.0.2.204");
	expect(await target(4)).toBe("192.0.2.205");
	expect(lookups).toBe(2);
	// Another failure within the minute does not ask DNS again.
	clock += 10_000;
	target.failed(4, "192.0.2.205");
	expect(await target(4)).toBe("192.0.2.204");
	expect(lookups).toBe(2);
	clock += CONNECTIVITY_TARGET_FAILURE_REFRESH_MS;
	target.failed(4, "192.0.2.204");
	await target(4);
	expect(lookups).toBe(3);
});

test("with no check address for its family, a black hole is never kept fresh, not for a day", async () => {
	let now = 0;
	let quiet = 0;
	const target = createConnectivityTargetResolver({
		now: () => now,
		resolve: async () => ({ addrs: ["2001:db8::204"], fromCache: false }),
	});
	const { runtime, engine, probes } = core({
		now: () => now,
		get quiet() {
			return quiet;
		},
		telemetry: quietTelemetry(() => now),
		resolveTarget: target,
	});
	await runtime.tick();
	now = 5_000;
	await runtime.tick();
	expect(engine.get("wwan0")?.state).toBe("up");
	let fresh = 0;
	for (now = 10_000; now <= 86_400_000; now += 5_000) {
		quiet = now;
		await runtime.tick();
		if ((engine.get("wwan0")?.staleAt ?? 0) > now) fresh++;
	}
	expect(probes).toEqual([]);
	// Fresh only for the expiry after the last real evidence.
	expect(fresh).toBeLessThanOrEqual(
		UPLINK_HEALTH_CONFIG.telemetryExpiryMs / 5_000,
	);
});

for (const changed of [false, true]) {
	test(`a held round keeps evidence fresh for at most a minute, and not at all after an address change (changed: ${changed})`, async () => {
		let now = 0;
		let onChange: (() => void) | undefined;
		const interfaces: Record<string, NetworkInterface> = {
			wwan0: { ip: "10.64.0.2", error: 0, tp: 0, txb: 0 },
		};
		const { runtime, engine, probes } = core({
			now: () => now,
			// Frozen: the bucket never refills, so after the burst every round
			// is held for want of a token.
			monotonic: () => 0,
			interfaces,
			quiet: 3_600_000,
			telemetry: quietTelemetry(() => now),
			onInterfacesChange: (callback) => {
				onChange = callback;
				return () => {};
			},
			probe: () => "success",
		});
		const { burst } = UPLINK_HEALTH_CONFIG.streamingProbeBudget;
		for (let round = 0; round < burst; round++, now += 5_000)
			await runtime.tick();
		expect(probes).toHaveLength(burst);
		const evidenceAt = now - 5_000;
		if (changed) {
			const entry = interfaces.wwan0;
			if (entry) entry.ip = "10.64.0.3";
			onChange?.();
		}
		for (let round = 0; round < 40; round++, now += 5_000) await runtime.tick();
		expect(probes).toHaveLength(burst);
		expect(engine.get("wwan0")?.staleAt).toBe(
			evidenceAt +
				(changed
					? UPLINK_HEALTH_CONFIG.telemetryExpiryMs
					: UPLINK_HEALTH_CONFIG.heldFreshMs),
		);
	});
}

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
		quiet: 60_000,
		telemetry: quietTelemetry(() => now),
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

test("while streaming, a link without a sender row is metered too", async () => {
	let now = 0;
	const { runtime, probes } = core({
		now: () => now,
		telemetry: () => ({ links: [], measured_bps: 0, lastReadMs: now }),
		probe: () => "failure",
		alternateTarget: () => "192.0.2.205",
	});
	for (; now < 3_600_000; now += 5_000) await runtime.tick();
	const { perHour, burst, reservePerHour, reserveBurst } =
		UPLINK_HEALTH_CONFIG.streamingProbeBudget;
	// Each check is at most two requests (the retry at another address).
	expect(probes.length).toBeLessThanOrEqual(
		2 * (perHour + burst + reservePerHour + reserveBurst),
	);
});
