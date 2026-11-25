/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import {
	IMAGE_APT_SOURCE_POLICY,
	setImageAptSourceReaderForTest,
	setImageClockGateFlagForTest,
} from "../modules/system/image-apt-source.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

const HOST = "updates.example.org";
const SOURCES_FILE = "/etc/apt/sources.list.d/openstreambox.sources";
const SUITE = "rock-5b-plus-2026.11.6";
const FILES = {
	[IMAGE_APT_SOURCE_POLICY]: `{"schema":1,"sourcesFile":"${SOURCES_FILE}","host":"${HOST}","origin":"OpenStreamBox","label":"OpenStreamBox","suites":["${SUITE}","${SUITE}-emergency"]}`,
	[SOURCES_FILE]: `Types: deb\nURIs: https://${HOST}/k7Qm2xV9pL4sT8wZ/apt/\nSuites: ${SUITE} ${SUITE}-emergency\nComponents: main\nSigned-By: /usr/share/keyrings/openstreambox-archive-keyring.pgp\n`,
};

let dir: string;
let flag: string;
let quiet: ReturnType<typeof spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orchestrator-image-apt-"));
	flag = join(dir, "clock-gate-open");
	setImageClockGateFlagForTest(flag);
	quiet = spyOn(logger, "info").mockImplementation(() => logger);
});

afterEach(() => {
	quiet.mockRestore();
	resetOrchestratorRuntimeForTest();
	setImageAptSourceReaderForTest(null);
	setImageClockGateFlagForTest(null);
	rmSync(dir, { recursive: true, force: true });
	for (const q of quarantineDirs.splice(0)) rmSync(q, { recursive: true });
});

const withImageSource = () =>
	setImageAptSourceReaderForTest(
		(file) => FILES[file as keyof typeof FILES] ?? null,
	);
const withoutImageSource = () => setImageAptSourceReaderForTest(() => null);

function counting() {
	const counts = { packageChecks: 0, osChecks: 0, installs: 0 };
	const deps = fakeDeps({
		quarantine: testQuarantine(),
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "rauc-verity-streaming"],
		}),
		runPackageCheck: async () => {
			counts.packageChecks++;
			return null;
		},
		checkOsManifest: async () => {
			counts.osChecks++;
			return {
				available: false,
				rateLimited: false,
				failed: false,
				reason: "",
			};
		},
		getPackageInstallWireState: () => ({
			kind: "available",
			identity: { version: "emergency", packages: ["modemmanager"] },
			package_count: 1,
			actionable_count: 1,
			packages: [
				{ name: "modemmanager", origin: HOST, layer: "app", actionable: true },
			],
		}),
		startPackageInstall: () => {
			counts.installs++;
			return { started: true };
		},
	});
	return { counts, deps };
}

describe("package checks wait for the image's clock gate", () => {
	test("a manual check skips packages, still checks the image, and records no failure", async () => {
		withImageSource();
		const { counts, deps } = counting();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(counts.packageChecks).toBe(0);
		expect(counts.osChecks).toBe(1);
		expect(getOrchestratorState().phase).toBe("idle");
		expect(getOrchestratorState().packageCheck.consecutiveFailures).toBe(0);
		// Once the clock is usable, the next check runs.
		writeFileSync(flag, "");
		await checkUpdatesNow();
		expect(counts.packageChecks).toBe(1);
	});

	test("a scheduled tick skips packages and lets the image check run", async () => {
		withImageSource();
		const { counts, deps } = counting();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await runOrchestratorTick();
		expect(counts.packageChecks).toBe(0);
		expect(counts.osChecks).toBe(1);
		expect(getOrchestratorState().packageCheck.consecutiveFailures).toBe(0);
	});

	test("without the image's source, the clock gate is not consulted", async () => {
		withoutImageSource();
		const { counts, deps } = counting();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		expect(counts.packageChecks).toBe(1);
	});
});

describe("installs from the image's own source are manual only", () => {
	test("automatic updates on: the offer waits for the user", async () => {
		withImageSource();
		writeFileSync(flag, "");
		const { counts, deps } = counting();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		expect(getOrchestratorState().phase).toBe("available");
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("available");
		expect(counts.installs).toBe(0);
		// Asked for, it installs.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		expect(counts.installs).toBe(1);
	});

	test("without the image's source, automatic updates still install", async () => {
		withoutImageSource();
		const { counts, deps } = counting();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(counts.installs).toBe(1);
	});
});
