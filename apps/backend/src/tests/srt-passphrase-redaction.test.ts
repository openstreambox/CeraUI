import { expect, test } from "bun:test";
import { logRedact } from "../helpers/logger";
import { redactSrtPassphrases } from "../helpers/srt-secret-redaction";
import type { AppWebSocket } from "../rpc/types";

test("scrubs SRT passphrases at nested log and diagnostic boundaries", () => {
	const secret = "dummy-secret";
	const output = logRedact({
		input: { srt_passphrase: secret },
		params: { srt: { passphrase: secret } },
	});
	expect(JSON.stringify(output)).not.toContain(secret);
});

test("scrubs archived journal JSON and URI passphrases before diagnostics export", () => {
	for (const text of [
		'{"srt_passphrase":"dummy-secret"}',
		"srt://example.invalid:9000?passphrase=dummy-secret&pbkeylen=16",
		'passphrase="dummy secret"',
	]) {
		expect(redactSrtPassphrases(text)).not.toContain("dummy");
	}
});

test("rejects encryption writes before touching the runtime configuration", async () => {
	const { call } = await import("@orpc/server");
	const { setConfigProcedure } = await import(
		"../rpc/procedures/streaming.procedure"
	);
	const { getConfig } = await import("../modules/config");
	const before = JSON.stringify(getConfig());
	const context = {
		ws: {
			send() {},
			data: { isAuthenticated: true, lastActive: Date.now() },
		} as unknown as AppWebSocket,
		isAuthenticated: () => true,
		authenticate() {},
		deauthenticate() {},
		markActive() {},
		getLastActive: () => 0,
		setSenderId() {},
		getSenderId: () => undefined,
		clearSenderId() {},
	};
	for (const input of [
		{ srt_passphrase: "dummy-secret" },
		{ srt_pbkeylen: 32 as const },
	]) {
		const result = await call(setConfigProcedure, input, { context });
		expect(result.success).toBe(false);
		expect(result.applied).not.toHaveProperty("srt_passphrase");
		expect(result.applied).not.toHaveProperty("srt_pbkeylen");
		expect(JSON.stringify(getConfig())).toBe(before);
	}
});

test("refuses retained encryption settings before acquiring an engine connection", async () => {
	const { CerastreamBackend } = await import(
		"../modules/streaming/cerastream-backend"
	);
	let connects = 0;
	const backend = new CerastreamBackend({
		connect: async () => {
			connects++;
			throw new Error("unexpected connection");
		},
	});
	await expect(
		backend.start(
			{ srt_passphrase: "dummy-secret" },
			{
				pipeline: "test",
				host: "127.0.0.1",
				port: 9000,
			},
		),
	).rejects.toThrow();
	expect(connects).toBe(0);
});

test("retained passphrases never reach config event or relay boundaries", async () => {
	const { addClient, removeClient, broadcast, buildMessage, sendToClient } =
		await import("../rpc/events");
	const { projectRemoteConfig } = await import(
		"../modules/remote/remote-status"
	);
	const { relayStatusToGateway, setControlChannel } = await import(
		"../modules/remote-control/status-relay"
	);
	const config = { srt_passphrase: "stored-dummy-secret", srt_latency: 2000 };
	const messages: string[] = [];
	const ws = {
		send: (message: string) => messages.push(message),
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	addClient(ws);
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => {
			messages.push(JSON.stringify(frame));
		},
	});
	try {
		messages.push(buildMessage("config", config));
		sendToClient(ws, "config", config);
		broadcast("config", config);
		messages.push(JSON.stringify(projectRemoteConfig(config)));
		relayStatusToGateway("config", config, 1);
		expect(messages).toHaveLength(5);
		for (const message of messages) {
			expect(message).not.toContain("stored-dummy-secret");
			expect(message).not.toContain('"srt_passphrase":');
			expect(message).toContain('"srt_latency":2000');
		}
		expect(config.srt_passphrase).toBe("stored-dummy-secret");
	} finally {
		removeClient(ws);
		setControlChannel(null);
	}
});

test("scrubs escaped JSON and camelCase passphrase fields", () => {
	for (const text of [
		String.raw`{\"srt_passphrase\":\"dummy-secret\"}`,
		'{"srtPassphrase":"dummy-secret"}',
		"srtPassphrase=dummy-secret",
	]) {
		expect(redactSrtPassphrases(text)).not.toContain("dummy-secret");
	}
});
