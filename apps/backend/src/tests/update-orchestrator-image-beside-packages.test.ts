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

	test("a queued package offer gets the same in-place check; a found image replaces the queue", () => {
		const queued = packagesWaiting({ phase: "awaiting-idle" });
		const started = reduceOrchestrator(queued, {
			type: "OS_CHECK_STARTED",
			now: 6,
		});
		expect(started.phase).toBe("awaiting-idle");
		expect(started.osCheck.lastAttemptAt).toBe(6);
		expect(
			reduceOrchestrator(started, {
				type: "CHECK_SUCCEEDED_OS",
				now: 7,
				nextAttemptAt: 99,
			}).phase,
		).toBe("os-available");
	});

	test("once a package install is launched, image events are ignored", () => {
		const launched = packagesWaiting({ phase: "downloading" });
		for (const event of [
			{ type: "OS_CHECK_STARTED", now: 6 },
			{ type: "CHECK_SUCCEEDED_OS", now: 6, nextAttemptAt: 99 },
		] as const)
			expect(reduceOrchestrator(launched, event)).toBe(launched);
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

	test("a package install that starts during the uplink read stops the image check before it runs", async () => {
		// Given the image check waiting on the metered-uplink read.
		const uplink = Promise.withResolvers<boolean>();
		let uplinkReads = 0;
		const h = setup(imageFound, {
			onlyMeteredCandidateExists: () =>
				++uplinkReads === 1 ? uplink.promise : Promise.resolve(false),
		});
		setOrchestratorStateForTest(packagesWaiting());
		const tick = runOrchestratorTick();
		while (uplinkReads === 0) await Bun.sleep(1);
		// When the operator starts the package install meanwhile.
		expect(await installUpdatesNow({ scope: "packages" })).toEqual({
			started: true,
		});
		uplink.resolve(false);
		await tick;
		// Then no image check ran and no image is offered beside the install.
		expect(h.calls.checks).toBe(0);
		expect(getOsUpdateSummary().candidate).toBeNull();
		expect(["awaiting-idle", "downloading"]).toContain(
			getOrchestratorState().phase,
		);
	});

	test("a package offer queued for idle no longer hides a due image", async () => {
		// Given packages queued for an idle window that never comes.
		const h = setup(imageFound, {
			loadSettings: settings(true),
			isIdle: async () => false,
		});
		setOrchestratorStateForTest(packagesWaiting({ phase: "awaiting-idle" }));
		// When the orchestrator ticks.
		await runOrchestratorTick();
		// Then the image is checked and offered; no package install started.
		expect(h.calls.checks).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(h.calls.installs).toBe(0);
	});

	test("turning automatic packages off during the image check keeps the offer unqueued", async () => {
		// Given automatic packages on when the tick starts.
		let packagesAuto = true;
		setup(
			async () => {
				packagesAuto = false;
				return noImage;
			},
			{
				loadSettings: async () => ({
					...(await settings(packagesAuto)()),
				}),
			},
		);
		setOrchestratorStateForTest(packagesWaiting());
		// When the switch goes off while the image check runs.
		await runOrchestratorTick();
		// Then the offer stays offered, not queued for install.
		expect(getOrchestratorState().phase).toBe("available");
	});

	test("an image result that lands while a package install is starting is dropped", async () => {
		// Given a queued offer whose image check is on the wire.
		const reply = Promise.withResolvers<CheckOsManifestResult>();
		const installUplink = Promise.withResolvers<boolean>();
		let uplinkReads = 0;
		const h = setup(() => reply.promise, {
			isIdle: async () => false,
			onlyMeteredCandidateExists: () =>
				++uplinkReads === 2 ? installUplink.promise : Promise.resolve(false),
		});
		setOrchestratorStateForTest(packagesWaiting({ phase: "awaiting-idle" }));
		const tick = runOrchestratorTick();
		while (h.calls.checks === 0) await Bun.sleep(1);
		// When the operator's install is past its own phase check (its uplink read pending).
		const install = installUpdatesNow({ scope: "packages" });
		while (uplinkReads < 2) await Bun.sleep(1);
		// And the image check then finds an image.
		reply.resolve(imageFound);
		await tick;
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		installUplink.resolve(false);
		// Then the install launches and no image is offered beside it.
		expect(await install).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(getOsUpdateSummary().candidate).toBeNull();
		expect(h.calls.installs).toBe(1);
	});

	test("an older image result is dropped once a re-check has superseded it", async () => {
		// Given a scheduled image check still on the wire beside the offer.
		const first = Promise.withResolvers<CheckOsManifestResult>();
		let manifests = 0;
		const h = setup(() =>
			++manifests === 1 ? first.promise : Promise.resolve(noImage),
		);
		setOrchestratorStateForTest(packagesWaiting());
		const tick = runOrchestratorTick();
		while (h.calls.checks === 0) await Bun.sleep(1);
		// When Check now re-checks the packages (back to `available`) and the image.
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("available");
		// And the older check then reports an image.
		first.resolve(imageFound);
		await tick;
		// Then the newer answer stands.
		expect(h.calls.checks).toBe(2);
		expect(getOrchestratorState().phase).toBe("available");
		expect(getOsUpdateSummary().candidate).toBeNull();
	});

	test("a scheduled step that stalled before its image check yields to Check now", async () => {
		// Given a tick that read the stable channel and then stalls on capabilities.
		let channel: "stable" | "beta" = "stable";
		const stall = Promise.withResolvers<void>();
		const fresh = Promise.withResolvers<CheckOsManifestResult>();
		let capabilityReads = 0;
		const channels: string[] = [];
		setup(async () => noImage, {
			loadSettings: async () => ({ ...(await settings(false)()), channel }),
			loadCapabilities: async () => {
				if (++capabilityReads === 1) await stall.promise;
				return {
					mode: "capable",
					features: ["apt-all-packages", "rauc-verity-streaming"],
				};
			},
			checkOsManifest: async (requested) => {
				channels.push(requested ?? "");
				return requested === "beta" ? fresh.promise : imageFound;
			},
		});
		setOrchestratorStateForTest(packagesWaiting());
		const tick = runOrchestratorTick();
		while (capabilityReads === 0) await Bun.sleep(1);
		// When the channel changes and Check now's image check is still on the
		// wire (the OS clock still due) as the stalled tick resumes.
		channel = "beta";
		const check = checkUpdatesNow();
		while (channels.length === 0) await Bun.sleep(1);
		stall.resolve();
		await tick;
		fresh.resolve(noImage);
		expect(await check).toEqual({ started: true });
		// Then only the fresh check ran, on the new channel, and its answer stands.
		expect(channels).toEqual(["beta"]);
		expect(getOrchestratorState().phase).toBe("available");
		expect(getOsUpdateSummary().candidate).toBeNull();
	});

	test("a superseded scheduled check does not queue the packages", async () => {
		// Given automatic packages and a scheduled image check on the wire.
		const scheduled = Promise.withResolvers<CheckOsManifestResult>();
		const manual = Promise.withResolvers<CheckOsManifestResult>();
		let manifests = 0;
		const h = setup(
			() => (++manifests === 1 ? scheduled.promise : manual.promise),
			{ loadSettings: settings(true) },
		);
		setOrchestratorStateForTest(packagesWaiting());
		const tick = runOrchestratorTick();
		while (h.calls.checks === 0) await Bun.sleep(1);
		// When Check now starts its own image check, and the older one answers first.
		const check = checkUpdatesNow();
		while (h.calls.checks < 2) await Bun.sleep(1);
		scheduled.resolve(noImage);
		await tick;
		// Then the offer was not queued behind the fresh check's back.
		expect(getOrchestratorState().phase).toBe("available");
		// And the fresh answer decides.
		manual.resolve(imageFound);
		expect(await check).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(h.calls.installs).toBe(0);
	});

	test("a stalled idle tick cannot take the image check from Check now", async () => {
		// Given an idle device with the image check due, and a tick that read the
		// stable channel and then stalls on the capability read after it.
		let channel: "stable" | "beta" = "stable";
		const tickStall = Promise.withResolvers<void>();
		const settingsHold = Promise.withResolvers<void>();
		let capabilityReads = 0;
		let holdSettings = false;
		let settingsHeld = false;
		const channels: string[] = [];
		setup(async () => noImage, {
			getPackageInstallWireState: () => ({ kind: "idle" }) as UpdateState,
			loadSettings: async () => {
				if (holdSettings) {
					holdSettings = false;
					settingsHeld = true;
					await settingsHold.promise;
				}
				return { ...(await settings(false)()), channel };
			},
			loadCapabilities: async () => {
				// The tick reads capabilities, then settings, then capabilities again.
				if (++capabilityReads === 2) await tickStall.promise;
				return {
					mode: "capable",
					features: ["apt-all-packages", "rauc-verity-streaming"],
				};
			},
			checkOsManifest: async (requested) => {
				channels.push(requested ?? "");
				return requested === "beta" ? noImage : imageFound;
			},
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const tick = runOrchestratorTick();
		while (capabilityReads < 2) await Bun.sleep(1);
		// When the channel changes, and Check now (no package offers) is reading
		// its settings as the stalled tick resumes.
		channel = "beta";
		holdSettings = true;
		const check = checkUpdatesNow();
		while (!settingsHeld) await Bun.sleep(1);
		tickStall.resolve();
		await tick;
		settingsHold.resolve();
		expect(await check).toEqual({ started: true });
		// Then the image check ran once, on the new channel.
		expect(channels).toEqual(["beta"]);
		expect(getOsUpdateSummary().candidate).toBeNull();
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
