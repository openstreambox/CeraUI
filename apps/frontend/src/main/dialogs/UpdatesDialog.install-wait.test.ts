/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

// A queued install that waits on the install unit says why, under its phase.

import type { UpdateOrchestratorWireState } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";
import UpdatesDialog from "./UpdatesDialog.svelte";

const orchestrator = vi.hoisted(() => ({
	value: undefined as UpdateOrchestratorWireState | undefined,
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			getUpdateCapabilities: vi.fn(async () => ({
				mode: "legacy",
				features: [],
			})),
			startUpdate: vi.fn(async () => ({ success: true })),
			checkForUpdates: vi.fn(async () => ({ success: true })),
			getUpdateDetails: vi.fn(),
		},
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getUpdateState: () => undefined,
	getUpdateOrchestratorState: () => orchestrator.value,
}));

vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: vi.fn(async (opts: { rpc: () => Promise<unknown> }) => {
		try {
			return await opts.rpc();
		} catch {
			return undefined;
		}
	}),
	getOperationPhase: () => "idle",
	confirmOperation: vi.fn(),
}));

afterEach(() => {
	orchestrator.value = undefined;
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

const queued = (
	install_wait?: UpdateOrchestratorWireState["install_wait"],
): UpdateOrchestratorWireState => ({
	schema: 1,
	phase: "awaiting-idle",
	progress: null,
	failure_reason: null,
	cellular_override_id: null,
	...(install_wait ? { install_wait } : {}),
});

describe("UpdatesDialog: why a queued install waits", () => {
	it("says the last install's service is still loaded", () => {
		orchestrator.value = queued("unit_pinned");
		const { getByTestId } = render(UpdatesDialog, { open: true });
		expect(getByTestId("update-activity").textContent).toContain(
			en.settings.updates.phase.awaitingIdle,
		);
		expect(getByTestId("update-install-wait").textContent?.trim()).toBe(
			en.settings.updates.installWait.unitPinned,
		);
	});

	it("says the install service cannot be read", () => {
		orchestrator.value = queued("unit_unreadable");
		const { getByTestId } = render(UpdatesDialog, { open: true });
		expect(getByTestId("update-install-wait").textContent?.trim()).toBe(
			en.settings.updates.installWait.unitUnreadable,
		);
	});

	it("adds nothing while the install only waits for idle", () => {
		orchestrator.value = queued();
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});
		expect(getByTestId("update-activity")).toBeTruthy();
		expect(queryByTestId("update-install-wait")).toBeNull();
	});
});
