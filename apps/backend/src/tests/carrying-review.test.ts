import { expect, test } from "bun:test";
import { CarryingTracker } from "../modules/system/carrying.ts";

test("startup and restart never open an admission gap during the hold", () => {
	for (const boot of [0, 900_000]) {
		const tracker = new CarryingTracker();
		tracker.start(boot);
		for (let elapsed = 0; elapsed <= 120_000; elapsed += 5000) {
			tracker.upload(boot + elapsed, {});
			expect(tracker.activityAt(boot + elapsed)).toBe(boot + elapsed);
			expect(tracker.read(boot + elapsed)).toBe(
				elapsed < 120_000 ? "unknown" : "idle",
			);
		}
	}
});

test("qualification survives adaptive dips and established low bitrate keeps carrying", () => {
	const tracker = new CarryingTracker();
	let bytes = 0;
	tracker.upload(0, { phone: bytes });
	for (let now = 5000; now <= 300_000; now += 5000) {
		bytes +=
			((now > 30_000 || now % 15_000 === 0 ? 800_000 : 1_300_000) * 5) / 8;
		tracker.upload(now, { phone: bytes });
		expect(tracker.read(now)).toBe(now < 20_000 ? "unknown" : "streaming");
	}
	for (let now = 305_000; now <= 420_000; now += 5000)
		tracker.upload(now, { phone: bytes });
	expect(tracker.read(420_000)).toBe("idle");
	expect(tracker.activityAt(420_000)).toBe(420_000);
	expect(tracker.activityAt(2_220_000)).toBe(420_000);
});

test("qualification activity continues aging the idle clock after a short burst", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, { phone: 0 });
	tracker.upload(5000, { phone: 1_000_000 });
	tracker.upload(10_000, { phone: 1_000_000 });
	expect(tracker.activityAt(100_000)).toBe(5000);
});

test("idle admission ages from the hold boundary", async () => {
	const { evaluateIdle } = await import("../modules/system/idle-detector.ts");
	const tracker = new CarryingTracker();
	tracker.session("phone", true, 0);
	tracker.session("phone", false, 1000);
	for (const now of [121_000, 1_920_999, 1_921_000]) {
		const result = evaluateIdle({
			now,
			idleMinutes: 30,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			lastActivity: {
				carrying: tracker.activityAt(now),
				stream: 0,
				preview: null,
				remote: null,
				ui: null,
				startLease: null,
			},
		});
		expect(result.since).toBe(121_000);
		expect(result.idle).toBe(now === 1_921_000);
	}
});

test("low-rate traffic cannot enter carrying without entry evidence", () => {
	const tracker = new CarryingTracker();
	for (let now = 0; now <= 180_000; now += 5000)
		tracker.upload(now, { phone: now * 100 });
	expect(tracker.read(180_000)).toBe("idle");
});

for (const dipRate of [0, 200_000]) {
	test(`qualification dips at ${dipRate} never admit idle`, () => {
		for (const interval of [10_000, 15_000]) {
			const tracker = new CarryingTracker();
			let bytes = 0;
			tracker.upload(0, { phone: bytes });
			for (let now = 5000; now <= 300_000; now += 5000) {
				bytes += ((now % interval === 0 ? dipRate : 1_300_000) * 5) / 8;
				tracker.upload(now, { phone: bytes });
				expect(tracker.read(now)).not.toBe("idle");
			}
			for (let now = 305_000; now <= 440_000; now += 5000)
				tracker.upload(now, { phone: bytes });
			expect(tracker.read(440_000)).toBe("idle");
		}
	});
}

test("an isolated entry burst with a stalled sample has bounded qualification protection", () => {
	const tracker = new CarryingTracker();
	tracker.upload(0, { phone: 0 });
	tracker.upload(5000, { phone: 1_000_000 });
	for (let now = 10_000; now <= 25_000; now += 5000) {
		tracker.upload(now, { phone: 1_000_000 });
		expect(tracker.read(now)).toBe(now < 25_000 ? "unknown" : "idle");
	}
});

test("startup checking expires despite ambient keep-level upload", () => {
	for (const boot of [0, 900_000]) {
		const tracker = new CarryingTracker();
		tracker.start(boot);
		for (let elapsed = 0; elapsed <= 3600_000; elapsed += 5000) {
			tracker.upload(boot + elapsed, { phone: (elapsed * 300_000) / 8000 });
			expect(tracker.read(boot + elapsed)).toBe(
				elapsed < 120_000 ? "unknown" : "idle",
			);
		}
	}
});

test("real evidence takes precedence over startup checking", () => {
	const tracker = new CarryingTracker();
	tracker.start(0);
	tracker.session("srt", true, 1000);
	expect(tracker.read(1000)).toBe("streaming");
	tracker.session("srt", false, 2000);
	tracker.upload(122_000, {});
	expect(tracker.read(122_000)).toBe("idle");
});
