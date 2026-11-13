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

/**
 * `epoch` names the device process that produced a remote frame. A device
 * restart starts a new epoch whose `seq` begins again at 1, so the client must
 * reset its notification seq fence for the new epoch and ignore any late frame
 * from an epoch it has already seen replaced.
 */
describe("remote notification epochs", () => {
	beforeEach(() => {
		resetState();
		clearNotifications();
		initSubscriptions();
	});

	const full = (epoch: string, ...names: string[]) => ({
		show: names.map((name) => notice(name)),
		remove: [],
		epoch,
		full: true,
	});

	it("ignores a late frame from a replaced epoch", () => {
		handlers.message?.("notification", full("process-1", "old-a"));
		handlers.message?.("notification", full("process-2", "new-a"));
		expect(persistentNames()).toEqual(["new-a"]);

		// A frame the dead process sent before the restart arrives late.
		handlers.message?.("notification", full("process-1", "old-a", "old-b"));
		expect(persistentNames()).toEqual(["new-a"]);
	});

	it("accepts a restarted device's frames although their seq starts again", () => {
		for (let seq = 1; seq <= 50; seq++) {
			handlers.message?.("notification", full("process-1", "old-a"), seq);
		}
		expect(persistentNames()).toEqual(["old-a"]);

		// Device restart; the browser stays connected, so no reconnect resets
		// the fence. The new process's first frame has seq 1.
		handlers.message?.("notification", full("process-2", "new-a"), 1);
		expect(persistentNames()).toEqual(["new-a"]);
		handlers.message?.("notification", full("process-2", "new-a", "new-b"), 2);
		expect(persistentNames()).toEqual(["new-a", "new-b"]);

		// Within one epoch the fence still drops a stale frame.
		handlers.message?.("notification", full("process-2", "new-a"), 2);
		expect(persistentNames()).toEqual(["new-a", "new-b"]);

		// A late frame of the replaced epoch neither applies nor moves the fence.
		handlers.message?.("notification", full("process-1", "old-a"), 60);
		expect(persistentNames()).toEqual(["new-a", "new-b"]);
		handlers.message?.("notification", full("process-2", "new-b"), 3);
		expect(persistentNames()).toEqual(["new-b"]);
	});

	it("does not merge a partial frame from an unknown epoch into the current list", () => {
		handlers.message?.("notification", full("process-1", "a"));
		handlers.message?.("notification", {
			show: [notice("other")],
			epoch: "process-9",
		});
		expect(persistentNames()).toEqual(["a"]);
	});

	it("leaves local frames without an epoch unaffected", () => {
		handlers.message?.("notification", full("process-1", "remote-a"));
		handlers.message?.("notification", { show: [notice("local-a")] });
		expect(persistentNames()).toEqual(["local-a", "remote-a"]);
	});
});
