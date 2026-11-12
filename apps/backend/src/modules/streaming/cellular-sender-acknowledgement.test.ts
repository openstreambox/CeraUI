import { afterEach, expect, test } from "bun:test";
import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry,
} from "@ceraui/srtla-send/telemetry";
import {
	senderReleasedCellularSource,
	setControlClientFactoryForTest,
	setIfaceResolverForTest,
	setTelemetryClockForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "./link-telemetry.ts";
import { createSenderTelemetryInstance } from "./sender-telemetry-instance.ts";
import type { StreamingProcess } from "./streamloop/process-runner.ts";

afterEach(() => {
	stopLinkTelemetry();
	setTelemetryClockForTest(null);
	setIfaceResolverForTest(null);
	setControlClientFactoryForTest(null);
});
const identity = { generation: 2, ips_file_sha256: "a".repeat(64) };
function producer(required = true): StreamingProcess {
	return {
		proc: { exitCode: null, signalCode: null },
		spawnfile: "/synthetic/sender",
		exitListeners: [],
		senderBinding: { epoch: Symbol(), startedAt: 500, required },
	} as unknown as StreamingProcess;
}
function watcher() {
	let emit: (snapshot: Telemetry | null, stale?: boolean) => void = () => {};
	const watch: typeof watchTelemetry = (_path, callback) => {
		emit = (data, stale = false) =>
			callback({ data, stale } satisfies TelemetryUpdate);
		return { stop: () => {} };
	};
	return {
		watch,
		emit: (data: Telemetry | null, stale = false) => emit(data, stale),
	};
}
test("withdrawal needs the same strict producer and its fresh post-publication snapshot", () => {
	setTelemetryClockForTest(() => 2100);
	setIfaceResolverForTest(() => "wwan0");
	setControlClientFactoryForTest(async () => null);
	const first = producer(),
		replacement = producer(),
		old = watcher(),
		current = watcher();
	const empty: Telemetry = {
		schema_version: 1,
		last_updated_ms: 2000,
		connections: [],
		bind_map_status: { state: "active" },
		disposition: { state: "mapped" },
		bind_map_applied: identity,
	};
	const firstInstance = createSenderTelemetryInstance(
			"/synthetic/first",
			"/tmp/first",
		),
		replacementInstance = createSenderTelemetryInstance(
			"/synthetic/replacement",
			"/tmp/replacement",
		);
	startLinkTelemetry("/synthetic/shared", [], {
		watch: old.watch,
		producer: first,
	});
	old.emit(empty);
	expect(
		senderReleasedCellularSource(first, 1900, "link-one", ["wwan0"], identity),
	).toBe(false);
	startLinkTelemetry(firstInstance.statsFile, [], {
		telemetryInstance: firstInstance,
		controlSocket: firstInstance.controlSocket,
		watch: old.watch,
		producer: first,
	});
	old.emit({ ...empty, disposition: { state: "pending_apply" } });
	expect(
		senderReleasedCellularSource(first, 1900, "link-one", ["wwan0"], identity),
	).toBe(false);
	old.emit(empty);
	expect(
		senderReleasedCellularSource(first, 1900, "link-one", ["wwan0"], identity),
	).toBe(true);
	expect(
		senderReleasedCellularSource(
			replacement,
			1900,
			"link-one",
			["wwan0"],
			identity,
		),
	).toBe(false);
	expect(
		senderReleasedCellularSource(first, 2100, "link-one", ["wwan0"], identity),
	).toBe(false);
	startLinkTelemetry(replacementInstance.statsFile, [], {
		telemetryInstance: replacementInstance,
		controlSocket: replacementInstance.controlSocket,
		watch: current.watch,
		producer: replacement,
	});
	old.emit(empty);
	expect(
		senderReleasedCellularSource(
			replacement,
			1900,
			"link-one",
			["wwan0"],
			identity,
		),
	).toBe(false);
	current.emit(empty);
	expect(
		senderReleasedCellularSource(
			replacement,
			1900,
			"link-one",
			["wwan0"],
			identity,
		),
	).toBe(true);
	// UI age and wall-clock jumps cannot override exact applied identity.
	current.emit({ ...empty, last_updated_ms: 0 }, true);
	expect(
		senderReleasedCellularSource(
			replacement,
			1900,
			"link-one",
			["wwan0"],
			identity,
		),
	).toBe(true);
	current.emit(null);
	expect(
		senderReleasedCellularSource(
			replacement,
			1900,
			"link-one",
			["wwan0"],
			identity,
		),
	).toBe(false);
	const legacy = producer(false);
	startLinkTelemetry("/synthetic/legacy", [], {
		watch: current.watch,
		producer: legacy,
	});
	current.emit(empty);
	expect(
		senderReleasedCellularSource(legacy, 1900, "link-one", ["wwan0"], identity),
	).toBe(false);
});
