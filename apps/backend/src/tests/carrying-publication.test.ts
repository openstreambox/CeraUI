import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import {
	otaStreamingMarkerPath,
	setCarryingOtaProtection,
} from "../modules/streaming/ota-streaming-marker.ts";
import {
	carryingTracker,
	getCarryingLiveness,
} from "../modules/system/carrying.ts";
import {
	initCarrying,
	tickCarrying,
} from "../modules/system/carrying-runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";

test("production startup stays protected and repeated reports do not rewrite the marker", async () => {
	const status = spyOn(websocket, "broadcastMsg");
	const write = spyOn(fs, "writeFileSync");
	const broadcast = spyOn(notifications, "notificationBroadcast");
	try {
		initCarrying();
		expect(status.mock.calls).toContainEqual([
			"status",
			{ carrying: { state: "unknown" } },
		]);

		expect(
			broadcast.mock.calls.filter(([name]) => name === "client-carrying"),
		).toHaveLength(1);
		expect(
			broadcast.mock.calls.find(([name]) => name === "client-carrying")?.[7],
		).toBe("notifications.clientCarryingUnknown");
		expect(getCarryingLiveness()).toBe("unknown");
		await tickCarrying();
		expect(getCarryingLiveness()).not.toBe("idle");
		for (let i = 0; i < 5; i++)
			carryingTracker.session("rtmp-ingest", false, performance.now());
		expect(
			write.mock.calls.filter(([path]) => path === otaStreamingMarkerPath()),
		).toHaveLength(1);
		carryingTracker.session("synthetic-client", true, performance.now());
		expect(status.mock.calls).toContainEqual([
			"status",
			{ carrying: { state: "streaming" } },
		]);
	} finally {
		carryingTracker.session("synthetic-client", false, performance.now());
		status.mockRestore();
		write.mockRestore();
		broadcast.mockRestore();
		setCarryingOtaProtection(false);
	}
});
