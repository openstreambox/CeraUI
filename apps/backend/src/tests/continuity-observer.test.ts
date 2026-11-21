import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Telemetry } from "@ceraui/srtla-send/telemetry";
import { logger } from "../helpers/logger.ts";
import {
	clearContinuityTelemetry,
	flushContinuityTelemetryForTest,
	continuityObserverIo as io,
	observeSafely,
	observeStartup,
	recordSenderIntent,
	recordSenderStarted,
	recordSenderTelemetry,
	reservePublication,
	senderPaths,
} from "../modules/streaming/continuity-observer.ts";
import { writeRecord } from "../modules/streaming/continuity-records.ts";
import {
	ingestTelemetryForTest,
	setIfaceResolverForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";

const original = { ...io };
let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "continuity-observer-"));
	io.directory = dir;
	io.bootId = async () => "boot";
	io.processIdentity = async (pid) => ({
		pid,
		startTime: "123",
		argsDigest: "other",
		invocation: null,
		processCount: 1,
	});
});
afterEach(async () => {
	stopLinkTelemetry();
	clearContinuityTelemetry();
	await flushContinuityTelemetryForTest();
	setIfaceResolverForTest(null);
	mock.restore();
	Object.assign(io, original);
	await rm(dir, { recursive: true, force: true });
});
const intent = async () => {
	const record = await recordSenderIntent(
		["required"],
		senderPaths(),
		"/synthetic/ips",
	);
	if (!record) throw new Error("Expected intent");
	return record;
};
const telemetry = {
	connections: [],
	disposition: { state: "mapped" },
} as unknown as Telemetry;

test("a start finishing after stop cannot reactivate telemetry", async () => {
	const record = await intent();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	io.writeRecord = async (path, schema, value, current) => {
		if (path.endsWith("lifetime.json")) {
			entered.resolve();
			await release.promise;
		}
		await writeRecord(path, schema, value, current);
	};
	const starting = recordSenderStarted(record, 123);
	await entered.promise;
	clearContinuityTelemetry();
	release.resolve();
	await starting;
	recordSenderTelemetry(telemetry);
	await flushContinuityTelemetryForTest();
	expect(await Bun.file(join(dir, "report.json")).exists()).toBe(false);
});

test("a newer intent fences an older start completing out of order", async () => {
	const old = await intent();
	const gate = Promise.withResolvers<void>(),
		entered = Promise.withResolvers<void>();
	io.processIdentity = async (pid) => {
		if (pid === 123) {
			entered.resolve();
			await gate.promise;
		}
		return {
			pid,
			startTime: String(pid),
			argsDigest: "digest",
			invocation: null,
			processCount: 1,
		};
	};
	const starting = recordSenderStarted(old, 123);
	await entered.promise;
	const current = await intent();
	await recordSenderStarted(current, 456);
	gate.resolve();
	await starting;
	recordSenderTelemetry(telemetry);
	await flushContinuityTelemetryForTest();
	expect(
		JSON.parse(await readFile(join(dir, "report.json"), "utf8")).lifetime,
	).toBe(current.lifetime);
});

test("unmappable publication invalidates older evidence without warnings", async () => {
	await Bun.write(join(dir, "publication.json"), "old");
	await Bun.write(join(dir, "witness.json"), "old");
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	await observeSafely(() =>
		reservePublication(2, "a".repeat(64), [{ iface: "eth9", ip: "192.0.2.1" }]),
	);
	expect(await Bun.file(join(dir, "publication.json")).exists()).toBe(false);
	expect(await Bun.file(join(dir, "witness.json")).exists()).toBe(false);
	expect(warn).not.toHaveBeenCalled();
	warn.mockRestore();
});

test("an unrelated argument never claims required mapping support", async () => {
	expect((await intent()).required).toBe(false);
});

test("a reused PID cannot open the recorded control socket", async () => {
	const record = await intent();
	await recordSenderStarted(record, 123);
	io.processIdentity = async (pid) => ({
		pid,
		startTime: "reused",
		argsDigest: record.argsDigest,
		invocation: null,
		processCount: 1,
	});
	let opened = 0;
	io.createControlClient = async () => {
		opened++;
		return null;
	};
	await observeStartup("idle");
	expect(opened).toBe(0);
});

test("observation errors log a fixed warning without exception data", async () => {
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	await observeSafely(async () => {
		throw new Error("PRIVATE-ERROR");
	});
	expect(warn.mock.calls).toEqual([
		["continuity: observation unavailable; recovery unchanged"],
	]);
	warn.mockRestore();
});

test("telemetry ingestion and Stop use the observed sender lifetime", async () => {
	setIfaceResolverForTest(() => undefined);
	startLinkTelemetry("/synthetic/stats", [], { watch: () => ({ stop() {} }) });
	const record = await intent();
	await recordSenderStarted(record, 123);
	const reports: string[] = [];
	io.writeRecord = async (path, _schema, value) => {
		if (path.endsWith("report.json"))
			reports.push((value as { lifetime: string }).lifetime);
	};
	ingestTelemetryForTest(telemetry);
	await flushContinuityTelemetryForTest();
	expect(reports).toEqual([record.lifetime]);
	stopLinkTelemetry();
	recordSenderTelemetry(telemetry);
	await flushContinuityTelemetryForTest();
	expect(reports).toEqual([record.lifetime]);
});

test("an unsupported boot records no warning or invented intent", async () => {
	io.bootId = async () => "";
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	expect(
		await recordSenderIntent([], senderPaths(), "/synthetic/ips"),
	).toBeNull();
	await reservePublication(1, "a".repeat(64), []);
	await observeStartup("idle");
	expect(warn).not.toHaveBeenCalled();
});

test("an unavailable interface witness cannot leave the previous witness", async () => {
	await Bun.write(join(dir, "witness.json"), "old");
	io.captureWitness = async () => null;
	await reservePublication(1, "a".repeat(64), [
		{ linkId: "link-a", iface: "eth9", ip: "192.0.2.1" },
	]);
	expect(await Bun.file(join(dir, "witness.json")).exists()).toBe(false);
	expect(
		JSON.parse(await readFile(join(dir, "publication.json"), "utf8"))
			.generation,
	).toBe(1);
});

test("record storage is isolated from the production runtime directory", () => {
	expect(original.directory.startsWith("/run/")).toBe(false);
});

test("a stopped lifetime cannot publish a report after its write was deferred", async () => {
	const old = await intent();
	await recordSenderStarted(old, 123);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const published: string[] = [];
	io.writeRecord = async (path, _schema, value, current = () => true) => {
		if (!path.endsWith("report.json")) return;
		const lifetime = (value as { lifetime: string }).lifetime;
		if (lifetime === old.lifetime) {
			entered.resolve();
			await release.promise;
		}
		if (current()) published.push(lifetime);
	};
	recordSenderTelemetry(telemetry);
	await entered.promise;
	clearContinuityTelemetry();
	const next = await intent();
	await recordSenderStarted(next, 456);
	recordSenderTelemetry(telemetry);
	release.resolve();
	await flushContinuityTelemetryForTest();
	expect(published).toEqual([next.lifetime]);
});

test("standalone child observers inherit the isolated record directory", async () => {
	const moduleUrl = new URL(
		"../modules/streaming/continuity-observer.ts",
		import.meta.url,
	).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
		const {continuityObserverIo: io, recordSenderIntent, senderPaths} = await import(${JSON.stringify(moduleUrl)});
		if (io.directory.startsWith('/run/')) process.exit(3);
		await recordSenderIntent([], senderPaths(), '/synthetic/ips');
		console.log(io.directory);
	`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	expect(output.trim()).toBe(original.directory);
});
