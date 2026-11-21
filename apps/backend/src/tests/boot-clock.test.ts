import { describe, expect, it } from "bun:test";
import { createBootClock } from "../helpers/boot-clock.ts";

describe("the boot clock", () => {
	it("reads CLOCK_BOOTTIME from /proc/uptime on every call, in milliseconds", () => {
		let uptime = "123.45 999.99\n";
		const clock = createBootClock(() => uptime);
		expect(clock()).toBe(123_450);
		uptime = "124.00 1000.00\n";
		expect(clock()).toBe(124_000);
	});

	it("an unreadable uptime is undefined, never another clock, and is not cached", () => {
		let fail = true;
		const clock = createBootClock(() => {
			if (fail) throw new Error("EACCES");
			return "5.00 1.00";
		});
		expect(clock()).toBeUndefined();
		expect(createBootClock(() => "garbage")()).toBeUndefined();
		expect(createBootClock(() => "-1 0")()).toBeUndefined();
		fail = false;
		expect(clock()).toBe(5_000);
	});

	it("reads the real file on Linux", () => {
		const value = createBootClock()();
		expect(typeof value).toBe("number");
		expect(value as number).toBeGreaterThan(0);
	});
});
