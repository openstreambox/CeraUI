import { expect, spyOn, test } from "bun:test";
import * as srtla from "../modules/streaming/srtla.ts";
import { launchRestoredStream } from "../modules/streaming/stream-restoration.ts";
import * as owner from "../modules/streaming/stream-session-orchestrator.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import * as session from "../modules/streaming/streamloop/session.ts";
import * as sender from "../modules/streaming/streamloop/start-stream.ts";

test("restoration resolves, publishes and attaches its generation refresh before sender launch", async () => {
	const calls: string[] = [];
	const validate = spyOn(streaming, "validateConfig").mockResolvedValue({
		pipeline: {} as never,
		srtlaAddr: "receiver.test.invalid",
		srtlaPort: 5000,
		streamid: "test",
	});
	const resolve = spyOn(srtla, "resolveSrtla").mockImplementation(async () => {
		calls.push("resolve");
		return "192.0.2.2";
	});
	const prepare = spyOn(session, "prepareSrtlaIpAddresses").mockImplementation(
		async (address) => {
			expect(address).toBe("192.0.2.2");
			calls.push("publish");
			return {} as never;
		},
	);
	const attach = spyOn(session, "attachFamilyRefresh").mockImplementation(
		(address, generation, current) => {
			expect(address).toBe("192.0.2.2");
			expect(generation).toBe(42);
			expect(current()).toBe(true);
			calls.push("refresh");
		},
	);
	const start = spyOn(sender, "startStream").mockImplementation(async () => {
		calls.push("sender");
		return { success: true };
	});
	const launch = spyOn(owner, "startStreamSession").mockImplementation(
		async (request) => {
			await request.launch({
				attemptId: "restore",
				generation: 42,
				origin: "restoration",
				cancelled: () => false,
			});
			return { result: "started", attemptId: "restore" };
		},
	);
	try {
		expect(
			await launchRestoredStream({ pipeline: "test" } as never, () => true),
		).toEqual({ ok: true });
		expect(calls).toEqual([
			"resolve",
			"publish",
			"resolve",
			"publish",
			"refresh",
			"sender",
		]);
	} finally {
		for (const spy of [validate, resolve, prepare, attach, start, launch])
			spy.mockRestore();
	}
});
