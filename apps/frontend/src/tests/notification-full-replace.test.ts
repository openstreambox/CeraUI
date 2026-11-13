/**
 * A remote notification frame marked `full: true` carries the device's complete
 * persistent list (remote relay, both paths). After a backend restart its names
 * are new and it cannot name what the previous process showed, so the client
 * must replace its persistent list instead of merging into it. Frames without
 * `full` (the local socket) keep the existing add/update/remove behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import {
	clearNotifications,
	getActive,
	getPersistent,
} from "$lib/stores/notifications.svelte";

const notice = (name: string, persistent = true) => ({
	name,
	type: "warning",
	msg: `${name} text`,
	is_dismissable: false,
	is_persistent: persistent,
	duration: persistent ? 0 : 5,
	revision: 1,
});

const persistentNames = () =>
	getPersistent()
		.map((n) => n.name)
		.sort();

describe("full-replace notification frames", () => {
	beforeEach(() => {
		resetState();
		clearNotifications();
		initSubscriptions();
	});

	it("drops persistent notices that a full frame no longer lists (restart)", () => {
		handlers.message?.("notification", {
			show: [notice("old-a"), notice("old-b")],
			remove: [],
			epoch: "process-1",
			full: true,
		});
		expect(persistentNames()).toEqual(["old-a", "old-b"]);

		handlers.message?.("notification", {
			show: [notice("new-a")],
			remove: [],
			epoch: "process-2",
			full: true,
		});
		expect(persistentNames()).toEqual(["new-a"]);

		handlers.message?.("notification", {
			show: [],
			remove: [],
			epoch: "process-3",
			full: true,
		});
		expect(persistentNames()).toEqual([]);
	});

	it("keeps transient toasts and leaves merge behaviour for frames without full", () => {
		handlers.message?.("notification", { show: [notice("toast", false)] });
		handlers.message?.("notification", { show: [notice("local-a")] });
		handlers.message?.("notification", { show: [notice("local-b")] });
		expect(persistentNames()).toEqual(["local-a", "local-b"]);

		handlers.message?.("notification", {
			show: [notice("local-b")],
			remove: [],
			epoch: "process-1",
			full: true,
		});
		expect(persistentNames()).toEqual(["local-b"]);
		expect(getActive().map((n) => n.name)).toContain("toast");
	});
});
