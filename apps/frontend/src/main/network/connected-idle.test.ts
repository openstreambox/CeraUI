import { describe, expect, it } from "vitest";
import { ConnectedIdleDetector } from "./connected-idle";

import { links, telemetry } from "./connected-idle-fixture";

function run(
	detector: ConnectedIdleDetector,
	live = true,
	rows = links,
	frame = telemetry(),
) {
	let result: string[] = [];
	for (let t = 0; t <= 20_000; t += 1000)
		result = detector.update(t, live, rows, frame);
	return result;
}
describe("connected idle link", () => {
	it("fires after 20 seconds of fresh quiet samples while a peer carries", () => {
		expect(run(new ConnectedIdleDetector())).toEqual(["eth0"]);
	});
	it("does not fire at startup or during brief dips", () => {
		const d = new ConnectedIdleDetector();
		expect(d.update(0, true, links, telemetry())).toEqual([]);
		expect(d.update(1000, true, links, telemetry())).toEqual([]);
	});
	it("does not fire for deliberately rested or opted-out links", () => {
		expect(
			run(
				new ConnectedIdleDetector(),
				true,
				links.map((l, i) => ({ ...l, enabled: i !== 0 })),
			),
		).toEqual([]);
	});
	it("requires a live stream and another carrying link", () => {
		expect(run(new ConnectedIdleDetector(), false)).toEqual([]);
		const frame = telemetry();
		if (!frame.links[1]) throw new Error("Missing peer");
		frame.links[1].bitrate_bps = 0;
		expect(run(new ConnectedIdleDetector(), true, links, frame)).toEqual([]);
	});
	it("clears when traffic resumes", () => {
		const d = new ConnectedIdleDetector();
		run(d);
		expect(d.update(21_000, true, links, telemetry(100_000))).toEqual([]);
	});
	it("does not count missing, stale or unknown measurements", () => {
		const d = new ConnectedIdleDetector();
		d.update(0, true, links, telemetry());
		expect(d.update(20_000, true, links, telemetry())).toEqual([]);
		const frame = telemetry();
		if (!frame.links[0]) throw new Error("Missing link");
		frame.links[0].stale = true;
		expect(run(new ConnectedIdleDetector(), true, links, frame)).toEqual([]);
		frame.links[0].stale = false;
		delete frame.links[0].bitrate_bps;
		expect(run(new ConnectedIdleDetector(), true, links, frame)).toEqual([]);
	});
	it("clears for removal, disconnect and stream stop", () => {
		for (const [live, rows] of [
			[false, links],
			[true, []],
			[true, links.map((l) => ({ ...l, isConnected: false }))],
		] as const) {
			const d = new ConnectedIdleDetector();
			run(d);
			expect(d.update(21_000, live, [...rows], telemetry())).toEqual([]);
		}
	});
	it("resets on counter rollover or bytes proving activity", () => {
		const d = new ConnectedIdleDetector();
		const frame = telemetry();
		if (!frame.links[0]) throw new Error("Missing link");
		frame.links[0].bytes_sent_total = 100;
		run(d, true, links, frame);
		frame.links[0].bytes_sent_total = 10_000;
		expect(d.update(21_000, true, links, frame)).toEqual([]);
		frame.links[0].bytes_sent_total = 0;
		expect(d.update(22_000, true, links, frame)).toEqual([]);
	});
});

it("does not advance the hold on cached timestamps", () => {
	const detector = new ConnectedIdleDetector();
	for (let i = 0; i < 30; i++)
		expect(detector.update(1000, true, links, telemetry())).toEqual([]);
});
it("allows only keepalive-sized traffic and re-arms after a brief dip", () => {
	const detector = new ConnectedIdleDetector();
	expect(run(detector, true, links, telemetry(512))).toEqual(["eth0"]);
	expect(detector.update(21_000, true, links, telemetry(2048))).toEqual([]);
	expect(detector.update(22_000, true, links, telemetry())).toEqual([]);
});
