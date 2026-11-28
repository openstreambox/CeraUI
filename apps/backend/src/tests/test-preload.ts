import { afterAll, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessSignalRunnerForTest } from "@ceraui/srtla-send/process-signals";
import {
	installNetworkSafetyGuard,
	installProcessSafetyGuard,
	resetPermittedTargets,
	takeSafetyViolations,
} from "../../../../scripts/test-safety.ts";
import { installTestTempGuard } from "./helpers/test-temp-guard.ts";

// Bun's parallel workers share the filesystem and may skip process exit hooks.
// Keep fixtures and the process guards' PATH stubs under this worker's root.
const tempParent = tmpdir();
const runtimeRoot = mkdtempSync(join(tempParent, "ceraui-backend-test-"));
const wrapperRoot = process.env.CERAUI_TEST_TEMP_ROOT;
const previousTmpDir = process.env.TMPDIR;
const previousTmp = process.env.TMP;
const previousTemp = process.env.TEMP;
const previousTempTree = process.env.CERAUI_TEST_TEMP_TREE;
const previousPath = process.env.PATH;
process.env.TMPDIR = runtimeRoot;
process.env.TMP = runtimeRoot;
process.env.TEMP = runtimeRoot;
// A plain Bun run has no wrapper to establish the tree for nested replays.
process.env.CERAUI_TEST_TEMP_TREE ||= runtimeRoot;
installTestTempGuard(
	process.env.CERAUI_TEST_TEMP_TREE,
	wrapperRoot || runtimeRoot,
	process.env.CERAUI_TEST_TEMP_PARENT || tempParent,
);
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

import * as modemControl from "@ceralive/modem-control";
import { loadJsonConfigSync } from "../helpers/config-loader.ts";
import {
	SETUP_CONFIG_DEFAULTS,
	setupConfigSchema,
} from "../helpers/config-schemas.ts";
import { setCredentialStoreState } from "../helpers/credential-store-state.ts";
import { readMutationUdevExportDb } from "../modules/modems/modem-id-path-source.ts";
import { continuityObserverIo } from "../modules/streaming/continuity-observer.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";

// Isolated globals still share /run; seed ownership only from this file's sentinel.
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
const previousSimParkDir = process.env.CERALIVE_GSM_SIM_PARK_DIR;
process.env.CERALIVE_GSM_SIM_PARK_DIR = join(runtimeRoot, "gsm-sim-park");
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
	spyOn(modemControl, "createUsbEnumerator").mockImplementation((deps) => {
		const reader = deps?.readUdevDatabase;
		return createUsbEnumerator({
			...deps,
			readUdevDatabase:
				reader === undefined || reader === readMutationUdevExportDb
					? async () => "P: /devices/test-usb/usb1\nE: DEVTYPE=usb_device\n"
					: reader,
		});
	});
}
// Isolate default USB readers without replacing parsing or journal persistence.
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
	// File-level teardown can still need its temp paths and PATH stubs.
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
	if (previousSimParkDir === undefined)
		delete process.env.CERALIVE_GSM_SIM_PARK_DIR;
	else process.env.CERALIVE_GSM_SIM_PARK_DIR = previousSimParkDir;
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
	if (previousTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmpDir;
	if (previousTmp === undefined) delete process.env.TMP;
	else process.env.TMP = previousTmp;
	if (previousTemp === undefined) delete process.env.TEMP;
	else process.env.TEMP = previousTemp;
	if (previousTempTree === undefined) delete process.env.CERAUI_TEST_TEMP_TREE;
	else process.env.CERAUI_TEST_TEMP_TREE = previousTempTree;
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	// A plain run has no outer wrapper to fail on a caught write error.
	const tempEscapes = join(runtimeRoot, "temp-escapes.log");
	let violations: string | undefined;
	try {
		if (!wrapperRoot && existsSync(tempEscapes))
			violations = readFileSync(tempEscapes, "utf8");
	} finally {
		await rm(runtimeRoot, { recursive: true, force: true });
	}
	if (violations) throw new Error(violations);
});
