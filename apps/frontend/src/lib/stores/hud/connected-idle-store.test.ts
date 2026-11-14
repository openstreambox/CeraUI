// @vitest-environment jsdom
import { flushSync } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { telemetry } from "$main/network/connected-idle-fixture";
import { idleFeed } from "../../../tests/fixtures/connected-idle-feed.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { idleFeed } = await import(
		"../../../tests/fixtures/connected-idle-feed.svelte"
	);
	return {
		getIsStreaming: () => idleFeed.live,
		getIsConnected: () => idleFeed.connected,
		getConnectionState: () =>
			idleFeed.connected ? "connected" : "disconnected",
		getLinkTelemetry: () => idleFeed.frame,
		getNetif: () => ({
			eth0: { enabled: true, ip: "192.0.2.2", error: "" },
			eth1: { enabled: true, ip: "192.0.2.3", error: "" },
		}),
		getConfig: () => undefined,
		getModems: () => undefined,
		getWifi: () => undefined,
		getSensors: () => undefined,
		getUpdating: () => null,
		getStatus: () => undefined,
	};
});

import { destroyHudStore, getConnectedIdleLinks } from "./store.svelte";

afterEach(() => {
	destroyHudStore();
	vi.useRealTimers();
});
it("observes before Network mounts, survives selector remounts, and clears on stop", () => {
	vi.useFakeTimers();
	idleFeed.live = true;
	idleFeed.connected = true;
	getConnectedIdleLinks();
	for (let t = 0; t <= 22_000; t += 5500) {
		vi.setSystemTime(t);
		idleFeed.frame = { ...telemetry(), lastReadMs: t };
		flushSync();
	}
	expect(getConnectedIdleLinks().map((l) => l.id)).toEqual(["eth0"]);
	// Reading a new surface does not create a detector or restart its hold.
	expect(getConnectedIdleLinks().map((l) => l.id)).toEqual(["eth0"]);
	idleFeed.live = false;
	flushSync();
	expect(getConnectedIdleLinks()).toEqual([]);
});
