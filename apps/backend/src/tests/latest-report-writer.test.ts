import { expect, test } from "bun:test";
import { createLatestReportWriter } from "../modules/streaming/latest-report-writer.ts";

test("stalled storage retains only the newest pending telemetry report", async () => {
	const gate = Promise.withResolvers<void>();
	const written: number[] = [];
	const writer = createLatestReportWriter<number>(async (value) => {
		written.push(value);
		if (value === 0) await gate.promise;
	});
	writer.submit(0);
	for (let value = 1; value <= 10000; value++) writer.submit(value);
	expect(written).toEqual([0]);
	gate.resolve();
	await writer.flush();
	expect(written).toEqual([0, 10000]);
	writer.submit(10001);
	await writer.flush();
	expect(written).toEqual([0, 10000, 10001]);
});

test("a failed write releases the newest pending report and permits later writes", async () => {
	const gate = Promise.withResolvers<void>();
	const written: number[] = [];
	let errors = 0;
	const writer = createLatestReportWriter<number>(
		async (value) => {
			written.push(value);
			if (value === 0) {
				await gate.promise;
				throw new Error("unavailable");
			}
		},
		() => {
			errors++;
		},
	);
	writer.submit(0);
	writer.submit(1);
	writer.submit(2);
	gate.resolve();
	await writer.flush();
	writer.submit(3);
	await writer.flush();
	expect(errors).toBe(1);
	expect(written).toEqual([0, 2, 3]);
});

test("clearing a stopped lifetime drops its pending report", async () => {
	const gate = Promise.withResolvers<void>();
	const written: number[] = [];
	const writer = createLatestReportWriter<number>(async (value) => {
		written.push(value);
		if (value === 0) await gate.promise;
	});
	writer.submit(0);
	writer.submit(1);
	writer.discardPending();
	gate.resolve();
	await writer.flush();
	expect(written).toEqual([0]);
});
