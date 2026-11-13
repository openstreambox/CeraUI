import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

let messageHandler:
	| ((type: string, data: unknown, seq?: number) => void)
	| undefined;
vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (handler: typeof messageHandler) => {
			messageHandler = handler;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getStatus,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import Harness from "./fixtures/PhoneHomeStoreHarness.svelte";

describe("phone Home consumes carrying broadcasts", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});
	it("renders partial updates from the real shared subscription store without polling", async () => {
		messageHandler?.(
			"status",
			{ phone_box: true, carrying: { state: "unknown" } },
			1,
		);
		render(Harness);
		expect(
			screen.getByRole("heading", {
				name: "Checking whether your phone uses the box",
			}),
		).toBeTruthy();
		for (const [state, heading] of [
			["streaming", "Carrying your phone's stream"],
			["unknown", "Checking whether your phone uses the box"],
			["idle", "Ready for your phone"],
		] as const) {
			messageHandler?.(
				"status",
				{ carrying: { state } },
				state === "streaming" ? 2 : state === "unknown" ? 3 : 4,
			);
			await waitFor(() =>
				expect(screen.getByRole("heading", { name: heading })).toBeTruthy(),
			);
			expect(getStatus()?.phone_box).toBe(true);
		}
	});
});
