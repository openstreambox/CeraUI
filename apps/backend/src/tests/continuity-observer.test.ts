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
	readDiskPublication,
	recordEngineSession,
	recordSenderIntent,
	recordSenderStarted,
	recordSenderTelemetry,
	reservePublication,
	senderPaths,
} from "../modules/streaming/continuity-observer.ts";
import {
	lifetimeSchema,
	readRecord,
	writeRecord,
} from "../modules/streaming/continuity-records.ts";
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
	io.captureInvocation = async (pid) => ({
		pid,
		startTime: "123",
		state: "S",
		processGroup: pid,
		bootId: "boot",
		pidfd: true,
	});
	io.senderHost = async () => ({ host: "backend-child" });
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
	io.captureInvocation = async (pid) => {
		if (pid === 123) {
			entered.resolve();
			await gate.promise;
		}
		return {
			pid,
			startTime: String(pid),
			state: "S",
			processGroup: pid,
			bootId: "boot",
			pidfd: true,
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

const readLifetime = () =>
	readRecord(join(dir, "lifetime.json"), lifetimeSchema);
const SENDER_UNIT = {
	host: "systemd" as const,
	unit: "ceralive-sender-1.service",
	manager: "system" as const,
	invocation: "0123456789abcdef0123456789abcdef",
	cgroup: "/system.slice/ceralive-sender-1.service",
};
const ENGINE = {
	invocation: "fedcba9876543210fedcba9876543210",
	mainPid: 777,
	sessionId: "session-1",
};

test("the start records PID, start time and pidfd from one capture, as a backend child today", async () => {
	const record = await intent();
	await recordSenderStarted(record, 123);
	expect(await readLifetime()).toMatchObject({
		pid: 123,
		startTime: "123",
		pidfd: true,
		host: "backend-child",
		invocation: null,
	});
});

test("a sender gone before its capture, or captured on another boot, records no PID", async () => {
	const record = await intent();
	io.captureInvocation = async () => null;
	await recordSenderStarted(record, 123);
	expect((await readLifetime())?.pid).toBeNull();
	io.captureInvocation = async (pid) => ({
		pid,
		startTime: "5",
		state: "S",
		processGroup: pid,
		bootId: "another-boot",
		pidfd: true,
	});
	await recordSenderStarted(record, 123);
	expect((await readLifetime())?.pid).toBeNull();
});

test("a sender that is the main process of its own unit records that unit", async () => {
	io.senderHost = async () => SENDER_UNIT;
	const record = await intent();
	await recordSenderStarted(record, 123);
	expect(await readLifetime()).toMatchObject({
		pid: 123,
		host: "systemd",
		invocation: SENDER_UNIT.invocation,
		cgroup: SENDER_UNIT.cgroup,
		unit: SENDER_UNIT.unit,
		unitManager: "system",
	});
});

test("the engine session is recorded only for a sender with its own unit", async () => {
	const record = await intent();
	await recordSenderStarted(record, 123);
	let asked = 0;
	await recordEngineSession(record, async () => {
		asked++;
		return ENGINE;
	});
	expect(asked).toBe(0);
	expect((await readLifetime())?.engineSession ?? null).toBeNull();

	io.senderHost = async () => SENDER_UNIT;
	const own = await intent();
	await recordSenderStarted(own, 456);
	await recordEngineSession(own, async () => ENGINE);
	expect(await readLifetime()).toMatchObject({
		lifetime: own.lifetime,
		pid: 456,
		host: "systemd",
		engineSession: ENGINE,
	});
});

test("an engine session answered after Stop is not recorded", async () => {
	io.senderHost = async () => SENDER_UNIT;
	const record = await intent();
	await recordSenderStarted(record, 123);
	await recordEngineSession(record, async () => {
		clearContinuityTelemetry();
		return ENGINE;
	});
	expect((await readLifetime())?.engineSession ?? null).toBeNull();
});

test("required mode is recorded only when the vector asks for it", async () => {
	const record = await recordSenderIntent(
		["/usr/bin/srtla_send", "--bind-map", "/run/x.json", "--require-bind-map"],
		senderPaths(),
		"/synthetic/ips",
	);
	expect(record?.required).toBe(true);
	expect(record?.sidecarFile).toBe("/run/x.json");
});

test("the map on disk hashes the IP list's raw bytes", async () => {
	const ips = join(dir, "ips");
	// Not valid UTF-8: a decoded read would hash replacement characters.
	const raw = Buffer.from([0x31, 0x30, 0x2e, 0x30, 0xff, 0x0a]);
	await Bun.write(ips, raw);
	const sha = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
	await Bun.write(
		join(dir, "ips.bindmap.json"),
		JSON.stringify({
			schema_version: 1,
			generation: 3,
			ips_file_sha256: sha,
			links: [{ link_id: "eth", iface: "eth0", ip: "10.0.0.2" }],
		}),
	);
	expect(
		await readDiskPublication({ sidecarFile: null, ipsFile: ips }),
	).toMatchObject({ generation: 3, sha256: sha });
});

test("the launch capture is tied to the spawning handle and read again after the host", async () => {
	const record = await intent();
	const handles: Array<boolean | undefined> = [];
	io.captureInvocation = async (pid, ownChild) => {
		handles.push(ownChild?.());
		return {
			pid,
			startTime: "123",
			state: "S",
			processGroup: pid,
			bootId: "boot",
			pidfd: true,
		};
	};
	await recordSenderStarted(record, 123, () => true);
	expect(handles).toEqual([true, true]);
	expect((await readLifetime())?.pid).toBe(123);
});

test("a process whose start time changed across the host lookup records no PID", async () => {
	const record = await intent();
	let reads = 0;
	io.captureInvocation = async (pid) => ({
		pid,
		startTime: reads++ === 0 ? "123" : "999",
		state: "S",
		processGroup: pid,
		bootId: "boot",
		pidfd: true,
	});
	await recordSenderStarted(record, 123);
	expect((await readLifetime())?.pid).toBeNull();
});

test("an engine session is not recorded once the launch it belongs to is gone", async () => {
	io.senderHost = async () => SENDER_UNIT;
	const record = await intent();
	await recordSenderStarted(record, 123);
	await recordEngineSession(
		record,
		async () => ENGINE,
		() => false,
	);
	expect((await readLifetime())?.engineSession ?? null).toBeNull();
});

test("the publication and the map on disk both carry a valid id_path", async () => {
	await reservePublication(4, "a".repeat(64), [
		{
			linkId: "eth",
			iface: "eth0",
			ip: "10.0.0.2",
			idPath: "/devices/usb1/1-1",
		},
		{ linkId: "wifi", iface: "wlan0", ip: "10.0.0.3", idPath: "relative" },
	] as never);
	const published = JSON.parse(
		await readFile(join(dir, "publication.json"), "utf8"),
	);
	expect(published.links).toEqual([
		{
			linkId: "eth",
			iface: "eth0",
			ip: "10.0.0.2",
			idPath: "/devices/usb1/1-1",
		},
		{ linkId: "wifi", iface: "wlan0", ip: "10.0.0.3" },
	]);
	const ips = join(dir, "ips");
	await Bun.write(ips, "10.0.0.2\n");
	const sha = new Bun.CryptoHasher("sha256").update("10.0.0.2\n").digest("hex");
	await Bun.write(
		join(dir, "ips.bindmap.json"),
		JSON.stringify({
			schema_version: 1,
			generation: 4,
			ips_file_sha256: sha,
			links: [
				{
					link_id: "eth",
					iface: "eth0",
					ip: "10.0.0.2",
					id_path: "/devices/usb1/1-1",
				},
			],
		}),
	);
	expect(
		(await readDiskPublication({ sidecarFile: null, ipsFile: ips }))?.links,
	).toEqual([
		{
			linkId: "eth",
			iface: "eth0",
			ip: "10.0.0.2",
			idPath: "/devices/usb1/1-1",
		},
	]);
});
