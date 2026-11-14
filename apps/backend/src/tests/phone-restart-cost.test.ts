/*
 * A phone-only box never leaves restart as a dead end. While it carries a
 * phone's stream (or cannot tell after the startup check), a local operator can
 * restart after a confirmation that names the cost. The acceptance never covers
 * the box's own encoder stream, the startup check, an update, power-off, or a
 * relayed/remote session.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rebootInputSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { setup } from "../modules/setup.ts";
import { carryingTracker } from "../modules/system/carrying.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import * as softwareUpdates from "../modules/system/software-updates.ts";
import {
	setOwnStreamLiveForTest,
	setStreamLivenessSourceForTest,
} from "../modules/system/stream-liveness-source.ts";
import {
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(opts: {
	senderId?: string;
	remoteAddress?: string;
}): RPCContext {
	const ws = {
		send: () => {},
		remoteAddress: opts.remoteAddress ?? "127.0.0.1",
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
		getSenderId: () => opts.senderId,
		clearSenderId: () => {},
	};
}

let oldEngine: typeof setup.engine;
let oldNodeEnv: string | undefined;
let oldMockMode: string | undefined;
let startup: ReturnType<typeof spyOn>;

beforeEach(() => {
	oldEngine = setup.engine;
	oldNodeEnv = process.env.NODE_ENV;
	oldMockMode = process.env.MOCK_MODE;
	setup.engine = "none";
	startup = spyOn(carryingTracker, "startupChecking").mockReturnValue(false);
	setOwnStreamLiveForTest(() => false);
	setStreamLivenessSourceForTest(() => "streaming");
});

afterEach(() => {
	setup.engine = oldEngine;
	if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = oldNodeEnv;
	if (oldMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = oldMockMode;
	startup.mockRestore();
	setOwnStreamLiveForTest(null);
	setStreamLivenessSourceForTest(null);
	resetPowerCommandRunner();
});

describe("restart while a phone-only box carries a stream", () => {
	test("plain restart stays held", () => {
		expect(getDisruptiveActionDecision({ powerAction: "reboot" })).toEqual({
			allowed: false,
			reason: "streaming",
		});
	});

	test("a confirmed restart is admitted while carrying", () => {
		expect(
			getDisruptiveActionDecision({
				powerAction: "reboot",
				acceptCarryingCost: true,
			}),
		).toEqual({ allowed: true });
	});

	test("a confirmed restart is admitted when traffic is unknown after the startup check", () => {
		setStreamLivenessSourceForTest(() => "unknown");
		expect(
			getDisruptiveActionDecision({
				powerAction: "reboot",
				acceptCarryingCost: true,
			}),
		).toEqual({ allowed: true });
	});

	test("the startup check still holds restart", () => {
		setStreamLivenessSourceForTest(() => "unknown");
		startup.mockReturnValue(true);
		expect(
			getDisruptiveActionDecision({
				powerAction: "reboot",
				acceptCarryingCost: true,
			}),
		).toEqual({ allowed: false, reason: "stream_liveness_unknown" });
	});

	test("the box's own encoder stream is never overridden", () => {
		setOwnStreamLiveForTest(() => true);
		expect(
			getDisruptiveActionDecision({
				powerAction: "reboot",
				acceptCarryingCost: true,
			}),
		).toEqual({ allowed: false, reason: "streaming" });
	});

	test("an encoder box ignores the acceptance", () => {
		setup.engine = "cerastream";
		expect(
			getDisruptiveActionDecision({
				powerAction: "reboot",
				acceptCarryingCost: true,
			}),
		).toEqual({ allowed: false, reason: "streaming" });
	});

	test("an update still holds a confirmed restart", () => {
		const updating = spyOn(softwareUpdates, "isUpdating").mockReturnValue(true);
		try {
			expect(
				getDisruptiveActionDecision({
					powerAction: "reboot",
					acceptCarryingCost: true,
				}),
			).toEqual({ allowed: false, reason: "update_in_progress" });
		} finally {
			updating.mockRestore();
		}
	});

	test("the acceptance never admits power-off", () => {
		expect(
			getDisruptiveActionDecision({
				powerAction: "poweroff",
				acceptCarryingCost: true,
			}),
		).toEqual({ allowed: false, reason: "streaming" });
	});
});

describe("reboot procedure", () => {
	function production() {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
	}

	test("a local operator's confirmed restart reaches the runner once", async () => {
		production();
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));
		const result = await call(
			rebootProcedure,
			{ acceptCarryingCost: true },
			{ context: makeContext({}) },
		);
		expect(result.success).toBe(true);
		expect(commands).toEqual(["reboot"]);
	});

	test("without the acceptance the carried stream holds restart", async () => {
		production();
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));
		const result = await call(rebootProcedure, undefined, {
			context: makeContext({}),
		});
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(commands).toEqual([]);
	});

	test.each([
		["a relayed session", { senderId: "remote-viewer" }],
		["the remote control channel", { remoteAddress: "control-channel" }],
	])("%s cannot accept the cost", async (_label, opts) => {
		production();
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));
		const result = await call(
			rebootProcedure,
			{ acceptCarryingCost: true },
			{ context: makeContext(opts) },
		);
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(commands).toEqual([]);
	});
});

describe("reboot input", () => {
	test("accepts nothing, an empty object or an explicit true", () => {
		expect(rebootInputSchema.safeParse(undefined).success).toBe(true);
		expect(rebootInputSchema.safeParse({}).success).toBe(true);
		expect(
			rebootInputSchema.safeParse({ acceptCarryingCost: true }).success,
		).toBe(true);
	});

	test("rejects false, strings and unknown keys", () => {
		expect(
			rebootInputSchema.safeParse({ acceptCarryingCost: false }).success,
		).toBe(false);
		expect(
			rebootInputSchema.safeParse({ acceptCarryingCost: "yes" }).success,
		).toBe(false);
		expect(rebootInputSchema.safeParse({ force: true }).success).toBe(false);
	});
});
