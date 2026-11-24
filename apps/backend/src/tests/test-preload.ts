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

import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as modemControl from "@ceralive/modem-control";
import { loadJsonConfigSync } from "../helpers/config-loader.ts";
import {
	SETUP_CONFIG_DEFAULTS,
	setupConfigSchema,
} from "../helpers/config-schemas.ts";
import { setCredentialStoreState } from "../helpers/credential-store-state.ts";
import { continuityObserverIo } from "../modules/streaming/continuity-observer.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";

// Isolated globals still share /run; seed ownership only from this file's sentinel.
const runtimeRoot = mkdtempSync(join(tmpdir(), "ceraui-backend-test-"));
const previousContinuityDir = process.env.CERALIVE_CONTINUITY_DIR;
process.env.CERALIVE_CONTINUITY_DIR = join(runtimeRoot, "continuity");
continuityObserverIo.directory = process.env.CERALIVE_CONTINUITY_DIR;
const previousStreamingMarker = process.env.CERALIVE_STREAMING_MARKER;
const previousPreparationDir =
	process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR = join(
	runtimeRoot,
	"cellular-preparation",
);
const previousCarrierIntentDir =
	process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR;
process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR = join(
	runtimeRoot,
	"carrier-intent",
);
process.env.CERALIVE_STREAMING_MARKER = join(runtimeRoot, "streaming");
const previousCarryingBootClaim = process.env.CERALIVE_CARRYING_BOOT_CLAIM;
process.env.CERALIVE_CARRYING_BOOT_CLAIM = join(
	runtimeRoot,
	"carrying-boot-claim",
);
// The sender census never reads the host's process table in unit tests.
const previousSenderCensusRoot = process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT;
process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = join(runtimeRoot, "proc");
mkdirSync(process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT);
// Modem registration creates the mode-choice key on first use; never under /data.
const previousModeChoiceDir = process.env.CERALIVE_MODE_CHOICE_DIR;
process.env.CERALIVE_MODE_CHOICE_DIR = join(runtimeRoot, "mode-choice");
const previousEventsDir = process.env.CERALIVE_EVENTS_DIR;
process.env.CERALIVE_EVENTS_DIR = join(runtimeRoot, "events");
// The device image's setup marker never resolves to the host's /data.
const previousProvisionMarker = process.env.CERALIVE_PROVISION_ACTIVE_FLAG;
process.env.CERALIVE_PROVISION_ACTIVE_FLAG = join(
	runtimeRoot,
	"provision",
	"portal-active",
);

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
// The same for the credential stores the log export waits for.
setCredentialStoreState("hotspot", "ready");
setCredentialStoreState("modem", "ready");

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

// A session left unconfirmed by one test must not close another test's interlocks.
const { publishStreamSessionUnconfirmed } = await import(
	"../modules/streaming/stream-liveness.ts"
);
beforeEach(() => {
	publishStreamSessionUnconfirmed(false);
});

afterAll(async () => {
	await Bun.sleep(0);
	await rm("stream.armed.json", { force: true });
	if (previousStreamingMarker === undefined)
		delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previousStreamingMarker;
	if (previousCarryingBootClaim === undefined)
		delete process.env.CERALIVE_CARRYING_BOOT_CLAIM;
	else process.env.CERALIVE_CARRYING_BOOT_CLAIM = previousCarryingBootClaim;
	if (previousSenderCensusRoot === undefined)
		delete process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT;
	else process.env.CERALIVE_SENDER_CENSUS_PROC_ROOT = previousSenderCensusRoot;
	if (previousModeChoiceDir === undefined)
		delete process.env.CERALIVE_MODE_CHOICE_DIR;
	else process.env.CERALIVE_MODE_CHOICE_DIR = previousModeChoiceDir;
	if (previousContinuityDir === undefined)
		delete process.env.CERALIVE_CONTINUITY_DIR;
	else process.env.CERALIVE_CONTINUITY_DIR = previousContinuityDir;
	if (previousCarrierIntentDir === undefined)
		delete process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR;
	else
		process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR = previousCarrierIntentDir;
	if (previousPreparationDir === undefined)
		delete process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR;
	else
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR =
			previousPreparationDir;
	if (previousEventsDir === undefined) delete process.env.CERALIVE_EVENTS_DIR;
	else process.env.CERALIVE_EVENTS_DIR = previousEventsDir;
	if (previousProvisionMarker === undefined)
		delete process.env.CERALIVE_PROVISION_ACTIVE_FLAG;
	else process.env.CERALIVE_PROVISION_ACTIVE_FLAG = previousProvisionMarker;
	await rm(runtimeRoot, { recursive: true, force: true });
});
