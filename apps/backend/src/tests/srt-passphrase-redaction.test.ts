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
