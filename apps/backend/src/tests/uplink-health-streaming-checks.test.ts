import { expect, test } from "bun:test";
import type { ProbeCandidate } from "../modules/network/connectivity-candidates.ts";
import {
	buildDeviceBoundProbeArgv,
	DEVICE_PROBE_MAX_BYTES,
} from "../modules/network/device-bound-probe.ts";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
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
			resolveTarget: options.resolveTarget ?? (async () => "192.0.2.204"),
			probe: async (candidate) => {
				probes.push(candidate.name);
				return options.probe?.() ?? "failure";
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

test("without a check address the quiet link keeps its passive verdict", async () => {
	const now = 100_000;
	const { runtime, engine, probes } = core({
		now: () => now,
		quiet: 60_000,
		telemetry: () => ({
			links: [row({ rtt_ms: 1_500 })],
			not_carrying_ifaces: ["wwan0"],
			measured_bps: 0,
			lastReadMs: now,
		}),
		resolveTarget: async () => undefined,
	});
	await runtime.tick();
	expect(probes).toEqual([]);
	expect(engine.get("wwan0")).toMatchObject({ state: "degraded" });
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
	const { perHour, burst } = UPLINK_HEALTH_CONFIG.streamingProbeBudget;
	// 720 rounds in the hour; the burst, then one check per refilled token.
	expect(probes.length).toBeGreaterThanOrEqual(perHour);
	expect(probes.length).toBeLessThanOrEqual(perHour + burst);
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
