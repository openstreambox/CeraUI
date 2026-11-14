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

for (const failure of ["result", "throw"] as const) {
	test(`restoration disposes its timer and source listener after ${failure} failure`, async () => {
		const remove = (() => {
			let count = 0;
			return {
				call: () => {
					count++;
				},
				count: () => count,
			};
		})();
		const clear = spyOn(globalThis, "clearInterval");
		const network = await import("../modules/network/network-interfaces.ts");
		const subscribe = spyOn(
			network,
			"onNetworkInterfaceSourcesChange",
		).mockReturnValue(remove.call);
		const validate = spyOn(streaming, "validateConfig").mockResolvedValue({
			pipeline: {} as never,
			srtlaAddr: "receiver.test.invalid",
			srtlaPort: 5000,
			streamid: "test",
		});
		const resolve = spyOn(srtla, "resolveSrtla").mockResolvedValue("192.0.2.2");
		const prepare = spyOn(session, "prepareSrtlaIpAddresses").mockResolvedValue(
			{} as never,
		);
		const start = spyOn(sender, "startStream").mockImplementation(async () => {
			if (failure === "throw") throw new Error("launch failed");
			return {
				success: false,
				error: "launch failed",
				reason: "launch failed",
				phase: "spawn-sender",
			} as never;
		});
		const launch = spyOn(owner, "startStreamSession").mockImplementation(
			async (request) => {
				await expect(
					request.launch({
						attemptId: "restore",
						generation: 42,
						origin: "restoration",
						cancelled: () => false,
					}),
				).rejects.toThrow();
				return { result: "failed", attemptId: "restore" } as never;
			},
		);
		try {
			expect(
				await launchRestoredStream({ pipeline: "test" } as never, () => true),
			).toEqual({ ok: false, reason: "start_failed" });
			expect(subscribe).toHaveBeenCalledTimes(1);
			expect(clear).toHaveBeenCalledTimes(1);
			expect(remove.count()).toBe(1);
		} finally {
			session.detachFamilyRefresh(42);
			for (const spy of [
				clear,
				subscribe,
				validate,
				resolve,
				prepare,
				start,
				launch,
			])
				spy.mockRestore();
		}
	});
}

test("detaching an old generation preserves the current timer and listener", async () => {
	const network = await import("../modules/network/network-interfaces.ts");
	let removed = 0;
	const subscribe = spyOn(
		network,
		"onNetworkInterfaceSourcesChange",
	).mockReturnValue(() => {
		removed++;
	});
	const clear = spyOn(globalThis, "clearInterval");
	try {
		session.attachFamilyRefresh("192.0.2.2", 44, () => false);
		session.detachFamilyRefresh(42);
		expect(removed).toBe(0);
		expect(clear).not.toHaveBeenCalled();
		session.detachFamilyRefresh(44);
		session.detachFamilyRefresh(44);
		expect(removed).toBe(1);
		expect(clear).toHaveBeenCalledTimes(1);
	} finally {
		session.detachFamilyRefresh(44);
		subscribe.mockRestore();
		clear.mockRestore();
	}
});
