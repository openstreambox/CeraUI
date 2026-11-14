import { expect, test } from "bun:test";
import { createRtmpStatsPoller } from "../modules/ingest/rtmp-probe.ts";
import { CarryingTracker } from "../modules/system/carrying.ts";

test("real refused loopback RTMP endpoint reports absent, not a probe error", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const url = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	const states: (boolean | null)[] = [];
	const tracker = new CarryingTracker();
	tracker.start(0);
	const poll = createRtmpStatsPoller(
		(active) => {
			states.push(active);
			tracker.session("rtmp", active, 0);
		},
		() => 0,
		() => fetch(url),
	);
	await poll();
	expect(states).toEqual([false]);
	for (let now = 0; now <= 120_000; now += 5000) tracker.upload(now, {});
	expect(tracker.read(120_000)).toBe("idle");
});

test("genuine RTMP errors stay distinct but cannot withhold idle forever", async () => {
	let now = 0;
	const tracker = new CarryingTracker();
	const poll = createRtmpStatsPoller(
		(state) => tracker.session("rtmp", state, now),
		() => now,
		async () => new Response("broken XML"),
	);
	await poll();
	expect(tracker.read(now)).toBe("unknown");
	now = 119_999;
	await poll();
	expect(tracker.read(now)).toBe("unknown");
	now = 120_000;
	await poll();
	expect(tracker.read(now)).toBe("idle");
	now = 121_000;
	await poll();
	expect(tracker.read(now)).toBe("idle");
});

test("HTTP absence is idle while server errors remain unknown", async () => {
	for (const status of [404, 410, 500]) {
		const states: (boolean | null)[] = [];
		const poll = createRtmpStatsPoller(
			(active) => states.push(active),
			() => 0,
			async () => new Response("", { status }),
		);
		await poll();
		expect(states).toEqual([status === 500 ? null : false]);
	}
});

test("a stalled response body is bounded and overlapping polls do not race", async () => {
	let calls = 0;
	const states: (boolean | null)[] = [];
	const poll = createRtmpStatsPoller(
		(active) => states.push(active),
		() => 0,
		async () => {
			calls++;
			return new Response(new ReadableStream({ start() {} }));
		},
	);
	const first = poll();
	expect(await poll()).toBeNull();
	await first;
	expect(calls).toBe(1);
	expect(states).toEqual([null]);
}, 4000);

test("a previously active publisher retains its hold through probe failure and recovers", async () => {
	let now = 0;
	let healthy = true;
	const tracker = new CarryingTracker();
	const poll = createRtmpStatsPoller(
		(state) => tracker.session("rtmp", state, now),
		() => now,
		async () =>
			new Response(
				healthy
					? "<rtmp><server><application><live><stream><name>phone</name><bytes_in>1000</bytes_in></stream></live></application></server></rtmp>"
					: "bad",
			),
	);
	await poll();
	expect(tracker.read(now)).toBe("streaming");
	healthy = false;
	now = 1000;
	await poll();
	now = 120_999;
	await poll();
	expect(tracker.read(now)).toBe("streaming");
	now = 121_000;
	await poll();
	expect(tracker.read(now)).toBe("idle");
	healthy = true;
	now++;
	await poll();
	expect(tracker.read(now)).toBe("streaming");
});
