/**
 * A Start's terminal tells its owner when the wait is over, published or not,
 * so the Start's hold on the adapter-mode witness ends with it.
 */
import { expect, test } from "bun:test";
import {
	advanceHotspotOperation,
	beginHotspotStartTerminal,
	type HotspotSteeringDeps,
} from "../modules/wifi/wifi-hotspot-readiness.ts";
import type { WifiInterfaceWithHotspot } from "../modules/wifi/wifi-hotspot-types.ts";

function row(): WifiInterfaceWithHotspot {
	return {
		id: 97,
		ifname: "wlan97",
		hotspot: { conn: "ap97" },
	} as unknown as WifiInterfaceWithHotspot;
}

const steering: HotspotSteeringDeps = {
	reconcile: async () => {},
	verified: () => true,
};

test("the immediate terminal reports settled after it publishes", () => {
	const r = row();
	const ticket = advanceHotspotOperation(r);
	const events: string[] = [];
	beginHotspotStartTerminal(
		r,
		"ap97",
		{ ticket },
		undefined,
		() => events.push("published"),
		() => events.push("error"),
		() => events.push("settled"),
	)();
	expect(events).toEqual(["published", "settled"]);
});

test("a superseded Start publishes nothing and still reports settled", async () => {
	const r = row();
	const ticket = advanceHotspotOperation(r);
	const events: string[] = [];
	const settled = new Promise<void>((done) => {
		const run = beginHotspotStartTerminal(
			r,
			"ap97",
			{ ticket },
			steering,
			() => events.push("published"),
			() => events.push("error"),
			() => {
				events.push("settled");
				done();
			},
		);
		advanceHotspotOperation(r);
		run();
	});
	await settled;
	expect(events).toEqual(["settled"]);
});
