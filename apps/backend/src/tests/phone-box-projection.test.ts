import { expect, test } from "bun:test";
import { setupConfigSchema } from "../helpers/config-schemas";
import { projectRemoteStatus } from "../modules/remote/remote-status";
import { CarryingTracker } from "../modules/system/carrying";
import {
	getPhoneBoxHealth,
	markBootDegraded,
	resetBootReadiness,
} from "../modules/system/readiness";

test("no-encoder image metadata stays explicit", () => {
	expect(setupConfigSchema.parse({ engine: "none", hw: "rk3588" }).engine).toBe(
		"none",
	);
});
test("phone remote status withholds planted network names, addresses and secrets", () => {
	const result = projectRemoteStatus({
		phone_box: true,
		phone_links: { ready: 2, sending: null },
		carrying: { state: "streaming" },
		box_health: [],
		wifi: { ssid: "planted-private-name", password: "planted-secret" },
		srt: { address: "srt://192.0.2.1:4000" },
	});
	expect(result).toEqual({
		phone_box: true,
		phone_links: { ready: 2, sending: null },
		carrying: { state: "streaming" },
		box_health: [],
	});
	expect(JSON.stringify(result)).not.toMatch(/planted|192\.0\.2/);
});
test("boot health uses only typed parts, with first-failure timestamps", () => {
	resetBootReadiness();
	try {
		markBootDegraded("cellular");
		markBootDegraded("unrelated");
		markBootDegraded("cellular");
		expect(getPhoneBoxHealth()).toEqual([
			{ part: "cellular", since: expect.any(Number) },
		]);
	} finally {
		resetBootReadiness();
	}
});

test("boot checking remains unknown through 119999 ms and releases at 120000 ms", () => {
	const tracker = new CarryingTracker();
	tracker.start(0);
	tracker.upload(119999, {});
	expect(tracker.read(119999)).toBe("unknown");
	tracker.upload(120000, {});
	expect(tracker.read(120000)).toBe("idle");
});

test("checking snapshot retires startup permission at 120 s even with unreadable counters", () => {
	const tracker = new CarryingTracker();
	tracker.start(0);
	tracker.upload(119999, null);
	expect(tracker.snapshot(119999)).toEqual({ state: "unknown", startup: true });
	expect(tracker.snapshot(120000)).toEqual({
		state: "unknown",
		startup: false,
	});
	tracker.session("srt", true, 120001);
	expect(tracker.snapshot(120001)).toEqual({
		state: "streaming",
		startup: false,
	});
});
