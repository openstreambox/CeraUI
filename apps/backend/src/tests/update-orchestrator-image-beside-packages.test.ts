/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Offered packages must not hide a system image. On 5.1 an apt.ceralive.tv
 * package offer kept the orchestrator in `available`, and the image check ran
 * only from `idle`, so no image was ever offered. The image check now runs
 * beside a waiting package offer, an image replaces the offer (it carries its
 * own packages), and the two installs never overlap.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	getOsUpdateSummary,
	installUpdatesNow,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import {
	harness,
	MIN,
	manifest,
	T0,
} from "./helpers/orchestrator-runtime-os-scheduler.ts";

afterEach(() => {
	mock.restore();
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

const HOUR = 60 * MIN;

type CheckOsManifestResult = Awaited<
	ReturnType<OrchestratorRuntimeDeps["checkOsManifest"]>
>;

// The package offer on the 5.1 box: zstd (ceralive-device is withheld now).
const packageOffer = {
	kind: "available",
	identity: { version: "zstd", packages: ["zstd"] },
	package_count: 1,
	packages: [
		{ name: "zstd", version: "1.5.7+dfsg-1", layer: "app", actionable: true },
	],
	actionable_count: 1,
} as unknown as UpdateState;

const imageFound: CheckOsManifestResult = {
	available: true,
	rateLimited: false,
	failed: false,
	reason: "",
	manifest,
};
const noImage: CheckOsManifestResult = {
	available: false,
	rateLimited: false,
	failed: false,
	reason: "",
};
const imageCheckFailed: CheckOsManifestResult = {
	available: false,
	rateLimited: false,
	failed: true,
	reason: "repos_unreachable",
};

function settings(packagesAuto: boolean) {
	return async () => ({
		packagesAuto,
		systemAuto: true,
		schedule: { mode: "any-idle" as const, start: "03:00", end: "05:00" },
		channel: "stable" as const,
		allowPackagesOverCellular: true,
		allowSystemOverCellular: true,
	});
}

// A package offer waiting in `available`, the image check due, the package
// check not due: the 5.1 box's persisted state.
function packagesWaiting(
	patch: Partial<OrchestratorState> = {},
): OrchestratorState {
	const base = initialOrchestratorState(0);
	return {
		...base,
		phase: "available",
		packageCheck: {
			...base.packageCheck,
			lastSuccessAt: T0 - HOUR,
			nextAttemptAt: T0 + 5 * HOUR,
		},
		...patch,
	};
}

function setup(
	result: CheckOsManifestResult | (() => Promise<CheckOsManifestResult>),
	overrides: Partial<OrchestratorRuntimeDeps> = {},
) {
	const h = harness([], {
		loadSettings: settings(false),
		getPackageInstallWireState: () => packageOffer,
		checkOsManifest: async () => {
			h.calls.checks++;
			return typeof result === "function" ? result() : result;
		},
		...overrides,
	});
	return h;
}

describe("reducer: the image check beside a package offer", () => {
	const waiting = packagesWaiting();

	test("starts in place, so the package offer stays", () => {
		const next = reduceOrchestrator(waiting, {
			type: "OS_CHECK_STARTED",
			now: 5,
		});
		expect(next.phase).toBe("available");
		expect(next.enteredAt).toBe(waiting.enteredAt);
		expect(next.osCheck.lastAttemptAt).toBe(5);
		expect(next.packageCheck).toEqual(waiting.packageCheck);
	});

	test("a found image replaces the package offer", () => {
		const next = reduceOrchestrator(waiting, {
			type: "CHECK_SUCCEEDED_OS",
			now: 6,
			nextAttemptAt: 99,
		});
		expect(next.phase).toBe("os-available");
		expect(next.osCheck).toMatchObject({ lastSuccessAt: 6, nextAttemptAt: 99 });
		expect(next.packageCheck).toEqual(waiting.packageCheck);
	});

	test("no image keeps the offer and books the next image check", () => {
		const next = reduceOrchestrator(waiting, {
			type: "CHECK_SUCCEEDED_NONE",
			now: 6,
			kind: "os",
			nextAttemptAt: 99,
		});
		expect(next.phase).toBe("available");
		expect(next.osCheck).toMatchObject({ lastSuccessAt: 6, nextAttemptAt: 99 });
	});

	test("a failed image check keeps the offer and its package meaning", () => {
		const next = reduceOrchestrator(waiting, {
			type: "CHECK_FAILED",
			now: 6,
			kind: "os",
			rateLimited: false,
			reason: "repos_unreachable",
			nextAttemptAt: 66,
		});
		expect(next.phase).toBe("available");
		expect(next.failureReason).toBeNull();
		expect(next.osCheck).toMatchObject({
			consecutiveFailures: 1,
			nextAttemptAt: 66,
		});
	});

	test("package-kind results are still ignored in `available`", () => {
		for (const event of [
			{
				type: "CHECK_SUCCEEDED_NONE",
				now: 6,
				kind: "packages",
				nextAttemptAt: 9,
			},
			{
				type: "CHECK_FAILED",
				now: 6,
				kind: "packages",
				rateLimited: false,
				reason: "x",
				nextAttemptAt: 9,
			},
		] as const)
			expect(reduceOrchestrator(waiting, event)).toBe(waiting);
	});

	test("once a package install is planned, image results are ignored", () => {
		const planned = packagesWaiting({ phase: "awaiting-idle" });
		expect(
			reduceOrchestrator(planned, {
				type: "CHECK_SUCCEEDED_OS",
				now: 6,
				nextAttemptAt: 99,
			}),
		).toBe(planned);
		expect(
			reduceOrchestrator(planned, { type: "OS_CHECK_STARTED", now: 6 }),
		).toBe(planned);
	});
});

describe("runtime: offered packages no longer hide a system image", () => {
	test("the 5.1 case: a waiting package offer, the image check due → the image is offered", async () => {
		// Given packages offered and an image published.
		const h = setup(imageFound);
		setOrchestratorStateForTest(packagesWaiting());
		// When the orchestrator ticks.
		await runOrchestratorTick();
		// Then the image check ran and the image replaced the package offer.
		expect(h.calls.checks).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOsUpdateSummary().candidate).toEqual({
			version: manifest.version,
			sizeBytes: manifest.bundle.size,
		});
		// And the packages can't be installed beside it.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(h.calls.installs).toBe(0);
	});

	test("no image: the package offer stays and the image is not re-checked until due", async () => {
		const h = setup(noImage);
		setOrchestratorStateForTest(packagesWaiting());
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(h.calls.checks).toBe(1);
		const state = getOrchestratorState();
		expect(state.phase).toBe("available");
		expect(state.osCheck.lastSuccessAt).toBe(T0);
		expect(state.osCheck.nextAttemptAt).toBeGreaterThan(T0 + 11 * HOUR);
		expect(getOsUpdateSummary().candidate).toBeNull();
	});

	test("a failed image check leaves the package offer usable and backs off", async () => {
		const h = setup(imageCheckFailed);
		setOrchestratorStateForTest(packagesWaiting());
		await runOrchestratorTick();
		const state = getOrchestratorState();
		expect(state.phase).toBe("available");
		expect(state.failureReason).toBeNull();
		expect(state.osCheck.consecutiveFailures).toBe(1);
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		expect(h.calls.installs).toBe(1);
	});

	test("an image check that is not due does not run", async () => {
		const h = setup(imageFound);
		setOrchestratorStateForTest(
			packagesWaiting({
				osCheck: {
					...initialOrchestratorState(0).osCheck,
					lastSuccessAt: T0 - HOUR,
					nextAttemptAt: T0 + HOUR,
				},
			}),
		);
		await runOrchestratorTick();
		expect(h.calls.checks).toBe(0);
		expect(getOrchestratorState().phase).toBe("available");
	});

	test.each([
		[imageFound, "os-available"],
		[noImage, "awaiting-idle"],
	] as const)(
		"with automatic packages the image is checked first (%#)",
		async (result, phase) => {
			setup(result, { loadSettings: settings(true) });
			setOrchestratorStateForTest(packagesWaiting());
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe(phase);
		},
	);

	test("a package install that starts during the image check wins; the image waits for the next check", async () => {
		// Given an image check still on the wire.
		const reply = Promise.withResolvers<CheckOsManifestResult>();
		const h = setup(() => reply.promise);
		setOrchestratorStateForTest(packagesWaiting());
		const tick = runOrchestratorTick();
		while (h.calls.checks === 0) await Bun.sleep(1);
		// When the operator starts the package install meanwhile.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		const installing = getOrchestratorState().phase;
		expect(["awaiting-idle", "downloading"]).toContain(installing);
		// And the image check then finds an image.
		reply.resolve(imageFound);
		await tick;
		// Then the install keeps the device and no image is offered beside it.
		expect(getOrchestratorState().phase).toBe(installing);
		expect(getOsUpdateSummary().candidate).toBeNull();
		expect(getOrchestratorState().osCheck.lastSuccessAt).toBeNull();
		expect(h.calls.installs).toBe(1);
	});

	test("a failed package check does not hold back the image check", async () => {
		// Given an idle device whose package check fails.
		const h = setup(imageFound, {
			loadSettings: settings(true),
			getPackageInstallWireState: () => ({ kind: "idle" }) as UpdateState,
			runPackageCheck: async () => "repos_unreachable",
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		// When the orchestrator ticks twice.
		await runOrchestratorTick();
		expect(getOrchestratorState().packageCheck.consecutiveFailures).toBe(1);
		await runOrchestratorTick();
		// Then the image check ran on the next tick and found the image.
		expect(h.calls.checks).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");
	});

	test("Check now runs the image check even when it finds packages", async () => {
		const h = setup(imageFound);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(h.calls.checks).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");
	});
});
