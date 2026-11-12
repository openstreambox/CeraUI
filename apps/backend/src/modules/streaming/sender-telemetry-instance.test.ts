import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSenderTelemetryInstance,
	ownsSenderTelemetryInstance,
	removeSenderTelemetryInstance,
} from "./sender-telemetry-instance.ts";

test("producer endpoints are disjoint and matching strings cannot forge ownership", () => {
	const first = createSenderTelemetryInstance("/tmp/stats", "/tmp/control"),
		second = createSenderTelemetryInstance("/tmp/stats", "/tmp/control");
	expect(first.statsFile).not.toBe(second.statsFile);
	expect(first.controlSocket).not.toBe(second.controlSocket);
	expect(
		ownsSenderTelemetryInstance(first, first.statsFile, first.controlSocket),
	).toBe(true);
	expect(
		ownsSenderTelemetryInstance(
			{ ...first },
			first.statsFile,
			first.controlSocket,
		),
	).toBe(false);
	expect(
		ownsSenderTelemetryInstance(first, second.statsFile, second.controlSocket),
	).toBe(false);
	expect(ownsSenderTelemetryInstance(first, first.statsFile, undefined)).toBe(
		false,
	);
	expect(() =>
		createSenderTelemetryInstance("/tmp/stats", "x".repeat(108)),
	).toThrow();
});

test("retiring one exited producer never removes legacy or replacement endpoints", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sender-instance-"));
	try {
		const stats = join(dir, "stats"),
			control = join(dir, "control"),
			first = createSenderTelemetryInstance(stats, control),
			second = createSenderTelemetryInstance(stats, control),
			preserved = [stats, control, second.statsFile, second.controlSocket];
		await Promise.all(
			[...preserved, first.statsFile, first.controlSocket].map((path) =>
				writeFile(path, "sentinel"),
			),
		);
		await removeSenderTelemetryInstance(first);
		expect(await Bun.file(first.statsFile).exists()).toBe(false);
		expect(await Bun.file(first.controlSocket).exists()).toBe(false);
		for (const path of preserved)
			expect(await readFile(path, "utf8")).toBe("sentinel");
		await removeSenderTelemetryInstance(first);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
