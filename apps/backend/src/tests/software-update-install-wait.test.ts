import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateOrchestratorWireState } from "@ceraui/rpc/schemas";
import { SpawnTimeoutError } from "../helpers/spawn-policy.ts";
import { softwareUpdateOutputPaths } from "../modules/system/software-update-output.ts";
import type { DetachedAptUpgradeDeps } from "../modules/system/software-update-process.ts";
import { setDetachedAptServiceDepsForTest } from "../modules/system/software-update-service.ts";
import {
	type InstallUnitWait,
	installUnitWait,
	proveInstallUnitFree,
} from "../modules/system/software-updates.ts";
import {
	getOrchestratorWireState,
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
import { updateHarness } from "./software-updates-preflight-harness.ts";

/*
  A queued package install that cannot launch because the install unit's name
  is held (a stopped unit systemd keeps loaded) or cannot be read used to show
  only "Waiting for the device to be idle", and Install now answered "nothing
  to install". The orchestrator's wire state now says why it waits.
*/

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

function queued(wait: () => InstallUnitWait | null) {
	const published: UpdateOrchestratorWireState[] = [];
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine: testQuarantine(),
			installUnitFree: async () => wait() === null,
			installUnitWait: wait,
			publishWireState: (wire) => published.push(wire),
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "awaiting-idle",
	});
	return published;
}

test("a queued install says the install unit is held, and stops saying it once the name is free", async () => {
	// Given a queued install whose install unit name is held.
	let wait: InstallUnitWait | null = "unit_pinned";
	const published = queued(() => wait);
	// Then the wire says why it waits.
	expect(getOrchestratorWireState().install_wait).toBe("unit_pinned");
	// When the tick finds the name free again.
	wait = null;
	await runOrchestratorTick();
	// Then the reason is withdrawn from the published wire.
	expect(published.at(-1)?.install_wait).toBeUndefined();
});

test("a wait reason that appears without a transition is published by the next tick", async () => {
	// Given a queued install, nothing in the way yet, outside the idle window.
	let wait: InstallUnitWait | null = null;
	const published = queued(() => wait);
	expect(getOrchestratorWireState().install_wait).toBeUndefined();
	// When the install unit becomes unreadable.
	wait = "unit_unreadable";
	await runOrchestratorTick();
	// Then the published wire carries it.
	expect(published.at(-1)?.install_wait).toBe("unit_unreadable");
});

test("only a queued install carries a wait reason", () => {
	queued(() => "unit_pinned");
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "available",
	});
	expect(getOrchestratorWireState()).not.toHaveProperty("install_wait");
});

test("Install now names the held install unit instead of 'nothing to install'", async () => {
	// Given a queued install whose install unit name is held.
	queued(() => "unit_pinned");
	// When the owner installs.
	const outcome = await installUpdatesNow();
	// Then the refusal says it waits for the install unit.
	expect(outcome).toEqual({ started: false, reason: "install_unit_waiting" });
});

test("the package side reports an unreadable, then a held, then a free install unit", async () => {
	await using _h = await updateHarness();
	let read: "timeout" | "pinned" | "free" = "timeout";
	const deps: DetachedAptUpgradeDeps = {
		outputPaths: softwareUpdateOutputPaths(),
		prepareOutput: async () => {},
		start: async () => {},
		inspect: async () => {
			if (read === "timeout") throw new SpawnTimeoutError("systemctl show");
			return read === "pinned"
				? { kind: "absent", loaded: true }
				: { kind: "absent" };
		},
		cleanup: async () => {},
		readOutput: async (_path, offset) => ({
			bytes: new Uint8Array(),
			nextOffset: offset,
		}),
		sleep: async () => {},
	};
	setDetachedAptServiceDepsForTest(deps);
	try {
		// The unit cannot be read.
		expect(await proveInstallUnitFree()).toBe(false);
		expect(installUnitWait()).toBe("unit_unreadable");
		// It reads as a stopped unit systemd keeps loaded.
		read = "pinned";
		expect(await proveInstallUnitFree()).toBe(false);
		expect(installUnitWait()).toBe("unit_pinned");
		// The name is free.
		read = "free";
		expect(await proveInstallUnitFree()).toBe(true);
		expect(installUnitWait()).toBeNull();
	} finally {
		setDetachedAptServiceDepsForTest(null);
	}
});
