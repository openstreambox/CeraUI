import { afterAll, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { setProcessSignalRunnerForTest } from "@ceraui/srtla-send/process-signals";
import {
	installNetworkSafetyGuard,
	installProcessSafetyGuard,
	resetPermittedTargets,
	takeSafetyViolations,
} from "../../../../scripts/test-safety.ts";

installProcessSafetyGuard();
installNetworkSafetyGuard();
setProcessSignalRunnerForTest(async () => {
	// Tests own no production name-signalled processes.
});
afterEach(() => {
	resetPermittedTargets();
	const violations = takeSafetyViolations();
	if (violations.length) throw new Error(violations.join("\n"));
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as modemControl from "@ceralive/modem-control";
import { loadJsonConfigSync } from "../helpers/config-loader.ts";
import {
	SETUP_CONFIG_DEFAULTS,
	setupConfigSchema,
} from "../helpers/config-schemas.ts";
import { continuityObserverIo } from "../modules/streaming/continuity-observer.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";

// Isolated globals still share /run; seed ownership only from this file's sentinel.
const runtimeRoot = mkdtempSync(join(tmpdir(), "ceraui-backend-test-"));
continuityObserverIo.directory = join(runtimeRoot, "continuity");
const previousStreamingMarker = process.env.CERALIVE_STREAMING_MARKER;
process.env.CERALIVE_STREAMING_MARKER = join(runtimeRoot, "streaming");

const setup = await loadJsonConfigSync(
	"setup.json",
	setupConfigSchema,
	SETUP_CONFIG_DEFAULTS,
	false,
);
mock.module("../modules/setup.ts", () => ({ setup }));
// A test process models a booted backend whose stream reconciliation returned;
// suites that exercise the pre-reconciliation window close the latch themselves.
setStreamReconciliationCompletedForTest(true);

// Status builders call getSshStatus() without deps; no test may ask the host's
// systemd about its ssh unit. A probe that fails reads as inactive/disabled.
const { setSshSystemctlProbesForTest } = await import(
	"../modules/system/ssh-status-probes.ts"
);
const noHostSystemd = async (): Promise<never> => {
	throw new Error("tests do not query the host's systemd");
};
setSshSystemctlProbesForTest({
	systemctlIsActive: noHostSystemd,
	systemctlIsEnabled: noHostSystemd,
});

const createUsbEnumerator = modemControl.createUsbEnumerator;
function isolateModemEnumeration(): void {
	spyOn(modemControl, "createUsbEnumerator").mockImplementation((deps) =>
		createUsbEnumerator({
			...deps,
			readUdevDatabase: deps?.readUdevDatabase ?? (async () => ""),
		}),
	);
}
// Isolate both implicit USB readers without replacing parsing or journal persistence.
isolateModemEnumeration();
beforeEach(isolateModemEnumeration);

afterAll(async () => {
	await Bun.sleep(0);
	await rm("stream.armed.json", { force: true });
	if (previousStreamingMarker === undefined)
		delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previousStreamingMarker;
	await rm(runtimeRoot, { recursive: true, force: true });
});
