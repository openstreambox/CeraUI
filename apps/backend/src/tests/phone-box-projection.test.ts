import { expect, test } from "bun:test";
import { setupConfigSchema } from "../helpers/config-schemas";
import {
	projectPhoneStatus,
	projectRemoteLegacyFrame,
	projectRemoteStatus,
} from "../modules/remote/remote-status";
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
	const result = projectPhoneStatus({
		phone_box: true,
		phone_links: { ready: 2, sending: null },
		carrying: { state: "streaming" },
		box_health: [],
		wifi: { ssid: "planted-private-name", password: "planted-secret" },
		srt: { address: "srt://192.0.2.1:4000" },
	});
	expect(result).toEqual({
		remote_status: true,
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

test("phone fields are typed leaves: nested planted values never cross", () => {
	const planted = "planted-moblin-password";
	const result = projectPhoneStatus({
		carrying: { state: "streaming", startup: true, ssid: planted },
		box_health: [
			{ part: "moblink", since: 5, password: planted },
			{ part: "moblink", since: 6 },
			{ part: planted, since: 7 },
			{ part: "hotspot", since: planted },
		],
		phone_links: { ready: 1, sending: planted, address: "192.0.2.9" },
		moblin: { password: planted },
		stream_key: planted,
		srt: { passphrase: planted, streamid: planted },
	});
	expect(result).toEqual({
		remote_status: true,
		phone_box: true,
		carrying: { state: "streaming", startup: true },
		box_health: [{ part: "moblink", since: 5 }],
		phone_links: { ready: 1, sending: null },
	});
	expect(JSON.stringify(result)).not.toMatch(/planted|192\.0\.2/);
});
test("encoder status never carries phone fields, even if a producer sets them", () => {
	const result = projectRemoteStatus({
		phone_box: true,
		carrying: { state: "streaming" },
		box_health: [{ part: "cellular", since: 1 }],
		phone_links: { ready: 1, sending: null },
	});
	expect(JSON.stringify(result)).not.toMatch(
		/phone_box|carrying|box_health|phone_links/,
	);
});
test("legacy phone-box frame relays status only", () => {
	const planted = "planted-private-name";
	const out = projectRemoteLegacyFrame(
		{
			status: { carrying: { state: "idle" }, wifi: { ssid: planted } },
			config: { remote_key: planted, srt_streamid: planted },
			netif: { [planted]: { ip: "192.0.2.1" } },
			modems: { [planted]: {} },
			relays: { servers: { [planted]: {} } },
			seq: 3,
		},
		"legacy",
		true,
	);
	expect(out).toEqual({
		status: {
			remote_status: true,
			phone_box: true,
			carrying: { state: "idle" },
		},
		seq: 3,
	});
});
test("a frame whose every type is withheld stays empty, seq included", () => {
	// A phone box withholds every non-status type.
	for (const frame of [
		{ config: { remote_key: "planted" }, seq: 42 },
		{ netif: {}, modems: {}, seq: 7 },
		{ notification: { show: [] }, seq: 9 },
		{ seq: 0 },
	])
		expect(projectRemoteLegacyFrame(frame, "legacy", true)).toEqual({});
	// An encoder withholds the base notification and unknown types.
	for (const frame of [
		{ notification: { show: [] }, seq: 9 },
		{ "planted-type": { ssid: "planted" }, seq: 3 },
		{ seq: 0 },
	])
		expect(projectRemoteLegacyFrame(frame, "legacy", false)).toEqual({});
	expect(
		projectRemoteLegacyFrame(
			{ status: { carrying: { state: "idle" } }, config: {}, seq: 5 },
			"legacy",
			true,
		),
	).toEqual({
		status: {
			remote_status: true,
			phone_box: true,
			carrying: { state: "idle" },
		},
		seq: 5,
	});
});
