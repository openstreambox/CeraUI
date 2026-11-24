import { expect, spyOn, test } from "bun:test";
import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import {
	defaultHotspotDeps,
	wifiHotspotStart,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotOutcomePublisher,
	publishHotspotOutcome,
} from "../modules/wifi/wifi-hotspot-outcome.ts";
import * as compat from "../rpc/compat.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

/*
  The Start attempt and the Start ticket meet in one publisher: the attempt
  decorates every Start frame, and the ticket hook tells a chained caller which
  Start owns the terminal. Neither may cost the other.
*/

test("a Start attempt keeps the publisher's start-ticket hook", async () => {
	const f = await wifiFrameFixture();
	try {
		const attempt = crypto.randomUUID();
		const published: unknown[][] = [];
		const tickets: unknown[] = [];
		const publishOutcome: HotspotOutcomePublisher = Object.assign(
			(...args: Parameters<HotspotOutcomePublisher>) => {
				published.push(args);
			},
			{ startTicket: (ticket: unknown) => tickets.push(ticket) },
		);
		const result = await wifiHotspotStart(
			{ device: 0, attempt },
			{ ...defaultHotspotDeps, publishOutcome },
		);
		expect(result).toEqual({ success: true });
		expect(tickets).toHaveLength(1);
		expect(published).toEqual([["start", 0, { success: true }, attempt]]);
	} finally {
		await f.restore();
	}
});

test("a steering-pending Start terminal echoes its attempt", () => {
	const frames: string[] = [];
	const broadcast = spyOn(compat, "broadcastMsg").mockImplementation(
		(type, data) => {
			frames.push(compat.buildMsg(type, data));
		},
	);
	try {
		const attempt = crypto.randomUUID();
		publishHotspotOutcome(
			"start",
			0,
			{ success: true, pending: true, reason: "steering-readiness-timeout" },
			attempt,
		);
		const start = wifiMessageSchema.parse(JSON.parse(frames[0] ?? "{}").wifi)
			.hotspot?.start;
		expect(start).toEqual({
			device: 0,
			pending: true,
			reason: "steering-readiness-timeout",
			attempt,
		});
	} finally {
		broadcast.mockRestore();
	}
});
