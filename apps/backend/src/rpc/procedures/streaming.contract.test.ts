// Setter-contract for the streaming router (S3): every mutation procedure
// returns a contains-envelope — the result CONTAINS `{ success: boolean }`.
// The check is a contains-predicate, not rigid equality: domain-rich mutations
// (start / switchAudio / reloadAudioDelay) legitimately carry extra fields and
// are NOT forced into a `{ success, applied }` shape. setBitrate exposes the
// applied bitrate as `applied`; failure paths carry `error`, never `reason`.

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../../mocks/mock-service.ts";
import { injectMockStreamError } from "../../mocks/providers/streaming.ts";
import { getConfig } from "../../modules/config.ts";
import { updateStatus } from "../../modules/streaming/streaming.ts";
import { appRouter } from "../router.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";
import {
	keepReconnectingProcedure,
	reloadAudioDelayProcedure,
	restartConnectionProcedure,
	setAudioMixProcedure,
	setBitrateProcedure,
	setConfigProcedure,
	setMockDeviceAttachedProcedure,
	setMockHardwareProcedure,
	setReconnectProcedure,
	setSourceVisibilityProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
	switchAudioProcedure,
	switchInputProcedure,
} from "./streaming.procedure.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

// Drive each setter from a deterministic idle baseline so a prior `start` does
// not leak a streaming state into the next call.
function resetStreamingIdle(): void {
	setStreamingState(false);
	updateStatus(false);
}

async function callMutation(
	procedure: unknown,
	args: unknown,
): Promise<Record<string, unknown>> {
	const result = await call(
		procedure as typeof streamingStartProcedure,
		args as never,
		{ context: makeContext() },
	);
	return result as unknown as Record<string, unknown>;
}

// Every streaming MUTATION paired with a valid argument for it. The set must
// match the router's setter procedures exactly (enforced below).
const MUTATIONS: ReadonlyArray<{
	readonly name: string;
	readonly procedure: unknown;
	readonly args: unknown;
}> = [
	{ name: "start", procedure: streamingStartProcedure, args: {} },
	{ name: "stop", procedure: streamingStopProcedure, args: undefined },
	// No offer is current in the idle baseline, so the tap is refused.
	{
		name: "restartConnection",
		procedure: restartConnectionProcedure,
		args: { token: "no-current-offer" },
	},
	// No reconnect window is current in the idle baseline: refused.
	{
		name: "keepReconnecting",
		procedure: keepReconnectingProcedure,
		args: { token: "no-current-window" },
	},
	// The defaults, so the baseline other tests read is unchanged.
	{
		name: "setReconnect",
		procedure: setReconnectProcedure,
		args: { enabled: true, max_s: 120 },
	},
	{
		name: "setBitrate",
		procedure: setBitrateProcedure,
		args: { max_br: 5000 },
	},
	{ name: "setConfig", procedure: setConfigProcedure, args: { max_br: 5000 } },
	{
		name: "setSourceVisibility",
		procedure: setSourceVisibilityProcedure,
		args: { hide_test_pattern: true },
	},
	{
		name: "switchInput",
		procedure: switchInputProcedure,
		args: { input_id: "video0" },
	},
	{
		name: "switchAudio",
		procedure: switchAudioProcedure,
		args: { audio_input_id: "default" },
	},
	{
		name: "setAudioMix",
		procedure: setAudioMixProcedure,
		args: { id: "default", gain_db: 0 },
	},
	{
		name: "reloadAudioDelay",
		procedure: reloadAudioDelayProcedure,
		args: { delay_ms: 100 },
	},
	{
		name: "setMockHardware",
		procedure: setMockHardwareProcedure,
		args: { hardware: "generic" },
	},
	{
		name: "setMockDeviceAttached",
		procedure: setMockDeviceAttachedProcedure,
		args: { input_id: "video0", attached: true },
	},
];

// Read-only streaming procedures — excluded from the setter contract.
const STREAMING_QUERIES = new Set([
	"getPipelines",
	"getAudioCodecs",
	"getConfig",
	"streamHealth",
	"getEngine",
	"listDevices",
	"getMockHardware",
]);

describe("streaming setter-contract — contains-envelope (S3)", () => {
	let priorPipeline: string | undefined;
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("streaming-active");
	});
	beforeEach(() => {
		// No persisted pipeline → the offered-set gate is skipped, so `start`
		// reaches the mock streaming branch.
		priorPipeline = getConfig().pipeline;
		getConfig().pipeline = undefined;
	});
	afterEach(() => {
		getConfig().pipeline = priorPipeline;
		resetStreamingIdle();
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("the mutation table covers exactly the streaming router's setters", () => {
		const routerMutations = Object.keys(appRouter.streaming)
			.filter((name) => !STREAMING_QUERIES.has(name))
			.sort();
		const tableMutations = MUTATIONS.map((m) => m.name).sort();
		expect(tableMutations).toEqual(routerMutations);
	});

	test("every streaming mutation result contains success: boolean", async () => {
		for (const mutation of MUTATIONS) {
			resetStreamingIdle();
			const result = await callMutation(mutation.procedure, mutation.args);
			expect(typeof result.success).toBe("boolean");
		}
	});

	test("setBitrate exposes the applied bitrate on success", async () => {
		resetStreamingIdle();
		const result = await callMutation(setBitrateProcedure, { max_br: 5000 });
		expect(result.success).toBe(true);
		expect(result).toHaveProperty("applied");
		expect(result.applied).toBe(5000);
	});

	test("a failed mutation carries an error and never a reason key", async () => {
		injectMockStreamError("srt_connect_failed");
		const result = await callMutation(streamingStartProcedure, {});
		expect(result.success).toBe(false);
		expect(result).not.toHaveProperty("reason");
		expect(result.error).toBeDefined();
	});

	test("a refused restart tap carries an error and never a reason key", async () => {
		const result = await callMutation(restartConnectionProcedure, {
			token: "no-current-offer",
		});
		expect(result).toEqual({
			success: false,
			result: "refused",
			error: "offer_not_current",
		});
		expect(result).not.toHaveProperty("reason");
	});

	test("Keep trying without a current reconnect window is refused with an error, never a reason", async () => {
		const result = await callMutation(keepReconnectingProcedure, {
			token: "no-current-window",
		});
		expect(result).toEqual({
			success: false,
			result: "refused",
			error: "reconnect_not_current",
		});
	});

	test("setReconnect persists and answers what was applied", async () => {
		const result = await callMutation(setReconnectProcedure, { max_s: 300 });
		expect(result).toEqual({
			success: true,
			applied: { enabled: true, max_s: 300 },
		});
		expect(getConfig().auto_reconnect_max_s).toBe(300);
		const off = await callMutation(setReconnectProcedure, { enabled: false });
		expect(off).toEqual({
			success: true,
			applied: { enabled: false, max_s: 300 },
		});
		await callMutation(setReconnectProcedure, { enabled: true, max_s: 120 });
		await expect(
			callMutation(setReconnectProcedure, { max_s: 5 }),
		).rejects.toThrow();
	});

	test("setReconnect echoes only its two fields to the other tabs, and a failed save changes nothing", async () => {
		const { spyOn } = await import("bun:test");
		const sockets = await import("../../modules/ui/websocket-server.ts");
		const configModule = await import("../../modules/config.ts");
		const sent: Array<[string, unknown]> = [];
		const broadcast = spyOn(sockets, "broadcastMsg").mockImplementation(
			(type: string, data: unknown) => {
				sent.push([type, data]);
			},
		);
		try {
			await callMutation(setReconnectProcedure, { max_s: 600 });
			expect(sent).toEqual([
				["config", { auto_reconnect: true, auto_reconnect_max_s: 600 }],
			]);
			const save = spyOn(configModule, "saveConfig").mockImplementation(() => {
				throw new Error("disk full");
			});
			try {
				await expect(
					callMutation(setReconnectProcedure, { enabled: false, max_s: 60 }),
				).rejects.toThrow();
			} finally {
				save.mockRestore();
			}
			expect(getConfig().auto_reconnect).toBe(true);
			expect(getConfig().auto_reconnect_max_s).toBe(600);
			expect(sent).toHaveLength(1);
		} finally {
			broadcast.mockRestore();
			await callMutation(setReconnectProcedure, { enabled: true, max_s: 120 });
		}
	});

	test("domain-rich mutations carry success WITHOUT a forced applied field", async () => {
		resetStreamingIdle();
		const audio = await callMutation(switchAudioProcedure, {
			audio_input_id: "default",
		});
		expect(audio.success).toBe(true);
		expect(audio).not.toHaveProperty("applied");
		expect(audio).toHaveProperty("active_audio_input");

		const delay = await callMutation(reloadAudioDelayProcedure, {
			delay_ms: 100,
		});
		expect(delay.success).toBe(true);
		expect(delay).not.toHaveProperty("applied");
		expect(delay).toHaveProperty("delay_ms");
	});
});
