import { afterEach, expect, test } from "bun:test";
import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry,
} from "@ceraui/srtla-send/telemetry";
import {
	senderReleasedCellularSource,
	setIfaceResolverForTest,
	setTelemetryClockForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "./link-telemetry.ts";
import type { StreamingProcess } from "./streamloop/process-runner.ts";

afterEach(() => {
	stopLinkTelemetry();
	setTelemetryClockForTest(null);
	setIfaceResolverForTest(null);
});
function producer(required = true): StreamingProcess {
	return {
		proc: { exitCode: null, signalCode: null },
		spawnfile: "/synthetic/sender",
		exitListeners: [],
		senderBinding: { epoch: Symbol(), startedAt: 500, required },
	} as unknown as StreamingProcess;
}
function watcher() {
	let emit: (snapshot: Telemetry) => void = () => {};
	const watch: typeof watchTelemetry = (_path, callback) => {
		emit = (data) => callback({ data, stale: false } satisfies TelemetryUpdate);
		return { stop: () => {} };
	};
	return { watch, emit: (data: Telemetry) => emit(data) };
}
test("withdrawal needs the same strict producer and its fresh post-publication snapshot", () => {
	setTelemetryClockForTest(() => 2100);
	setIfaceResolverForTest(() => "wwan0");
	const first = producer(),
		replacement = producer(),
		old = watcher(),
		current = watcher();
	const empty: Telemetry = {
		schema_version: 1,
		last_updated_ms: 2000,
		connections: [],
	};
	startLinkTelemetry("/synthetic/first", [], {
		watch: old.watch,
		producer: first,
	});
	old.emit(empty);
	expect(senderReleasedCellularSource(first, 1900, "link-one", ["wwan0"])).toBe(
		true,
	);
	expect(
		senderReleasedCellularSource(replacement, 1900, "link-one", ["wwan0"]),
	).toBe(false);
	expect(senderReleasedCellularSource(first, 2000, "link-one", ["wwan0"])).toBe(
		false,
	);
	startLinkTelemetry("/synthetic/replacement", [], {
		watch: current.watch,
		producer: replacement,
	});
	old.emit(empty);
	expect(
		senderReleasedCellularSource(replacement, 1900, "link-one", ["wwan0"]),
	).toBe(false);
	current.emit(empty);
	expect(
		senderReleasedCellularSource(replacement, 1900, "link-one", ["wwan0"]),
	).toBe(true);
	const legacy = producer(false);
	startLinkTelemetry("/synthetic/legacy", [], {
		watch: current.watch,
		producer: legacy,
	});
	current.emit(empty);
	expect(
		senderReleasedCellularSource(legacy, 1900, "link-one", ["wwan0"]),
	).toBe(false);
});
