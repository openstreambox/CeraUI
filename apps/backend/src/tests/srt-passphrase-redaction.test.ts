import { expect, test } from "bun:test";
import { inspect } from "node:util";
import ts from "typescript";
import {
	formatConsoleEntry,
	formatProdEntry,
	logRedact,
} from "../helpers/logger";
import { redactSrtPassphrases } from "../helpers/srt-secret-redaction";
import type { AppWebSocket } from "../rpc/types";
import { encryptionWrites } from "./helpers/encryption-writes";

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
	).rejects.toThrow("params:start_invalid");
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
	const config = {
		srt_passphrase: "stored-dummy-secret",
		srt_streamid: "stored-publish-key",
		relay_streamid_override: "stored-relay-key",
		srt_latency: 2000,
	};
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
			expect(message).not.toContain("stored-publish-key");
			expect(message).not.toContain("stored-relay-key");
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

test("scrubs both retained credentials in nested Errors without corrupting words", async () => {
	const { setStreamIdRedactionSource } = await import(
		"../helpers/stream-id-secret"
	);
	const { setSrtPassphraseRedactionSource } = await import(
		"../helpers/srt-secret-redaction"
	);
	const previousIds = setStreamIdRedactionSource(() => [
		"live",
		"live/secretkey",
	]);
	const previousPassphrase = setSrtPassphraseRedactionSource(() => [
		"retained-secret",
	]);
	try {
		const output = JSON.stringify(
			logRedact({
				err: new Error(
					"delivered live/secretkey passphrase: Some(retained-secret)",
				),
			}),
		);
		expect(output).toContain("delivered");
		expect(output).not.toContain("secretkey");
		expect(output).not.toContain("retained-secret");
		expect(
			formatProdEntry({
				level: "error",
				message: "failed",
				err: new Error("retained-secret live/secretkey"),
			}),
		).not.toContain("retained-secret");
		for (const text of [
			"passphrase%3Dretained-secret",
			String.raw`{\"srt_passphrase\":\"retained-secret\"}`,
			"--passphrase retained-secret",
		]) {
			expect(redactSrtPassphrases(text)).not.toContain("retained-secret");
		}
	} finally {
		setStreamIdRedactionSource(previousIds);
		setSrtPassphraseRedactionSource(previousPassphrase);
	}
});

test("retained passphrases scrub quoted and multiply escaped diagnostics", async () => {
	const { setSrtPassphraseRedactionSource } = await import(
		"../helpers/srt-secret-redaction"
	);
	const secret = 'retained "quoted" secret';
	const previous = setSrtPassphraseRedactionSource(() => [secret]);
	try {
		let text = JSON.stringify({ srt_passphrase: secret });
		for (let depth = 0; depth < 3; depth++) {
			expect(redactSrtPassphrases(text)).not.toContain("quoted");
			text = JSON.stringify(text);
		}
		expect(
			JSON.stringify(logRedact({ err: new Error("?passphrase=old-key") })),
		).not.toContain("old-key");
	} finally {
		setSrtPassphraseRedactionSource(previous);
	}
});

test("explicit clear accepts a selected key length and clears both stored fields", async () => {
	const { call } = await import("@orpc/server");
	const { setConfigProcedure } = await import(
		"../rpc/procedures/streaming.procedure"
	);
	const { getConfig, getConfigFilePath, setConfigFilePath } = await import(
		"../modules/config"
	);
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const config = getConfig();
	const before = structuredClone(config);
	const oldPath = getConfigFilePath();
	const scratch = await mkdtemp(join(tmpdir(), "srt-clear-"));
	setConfigFilePath(join(scratch, "config.json"));
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
	try {
		Object.assign(config, {
			srt_passphrase: "retained-secret",
			srt_pbkeylen: 32,
		});
		const result = await call(
			setConfigProcedure,
			{ srt_passphrase: "", srt_pbkeylen: 32 },
			{ context },
		);
		expect(result.success).toBe(true);
		expect(config.srt_passphrase).toBeUndefined();
		expect(config.srt_pbkeylen).toBeUndefined();
	} finally {
		for (const key of Object.keys(config)) Reflect.deleteProperty(config, key);
		Object.assign(config, before);
		setConfigFilePath(oldPath);
		await rm(scratch, { recursive: true, force: true });
	}
});

function assertReceiverWrites(text: string) {
	const source = ts.createSourceFile(
		"streaming.procedure.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const declaration = source.statements
		.flatMap((node) =>
			ts.isVariableStatement(node)
				? [...node.declarationList.declarations]
				: [],
		)
		.find((node) => node.name.getText(source) === "setConfigProcedure");
	const call = declaration?.initializer;
	const handler =
		call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
	if (!handler || !ts.isArrowFunction(handler) || !ts.isBlock(handler.body)) {
		throw new Error("setConfig handler body unavailable");
	}
	const statements = [...handler.body.statements];
	const condition = (node: ts.Statement) =>
		ts.isIfStatement(node) ? node.expression.getText(source) : "";

	// Every write to a stored encryption field clears it.
	const writes: { value: string; statement: number }[] = [];
	statements.forEach((statement, index) => {
		for (const value of encryptionWrites(statement, source)) {
			writes.push({ value, statement: index });
		}
	});
	const clear = statements.findIndex(
		(node) => condition(node) === 'input.srt_passphrase === ""',
	);
	expect(clear).toBeGreaterThanOrEqual(0);
	expect(
		writes,
		"receiver encryption writes must only be the two explicit clears",
	).toEqual([
		{ value: "undefined", statement: clear },
		{ value: "undefined", statement: clear },
	]);

	// The clear is its own step, not part of the run that decides where the
	// stream goes (relay or custom address through the ingest slot).
	const destinationStart = statements.findIndex(
		(node) => condition(node) === "input.relay_server",
	);
	const destinationEnd = statements.findIndex(
		(node) =>
			condition(node) === "input.selected_ingest_endpoint !== undefined",
	);
	expect(destinationStart).toBeGreaterThanOrEqual(0);
	expect(destinationEnd).toBeGreaterThan(destinationStart);
	expect(clear).toBeGreaterThan(destinationEnd);
}

test.each(["syntheticPassphrase42", "synthetic phrase\"'\\~!"])(
	"scrubs retained passphrase serialization and encodings: %s",
	async (secret) => {
		const { getConfig } = await import("../modules/config");
		const config = getConfig();
		const previous = config.srt_passphrase;
		config.srt_passphrase = secret;
		try {
			class Detail {
				constructor(public detail: string) {}
			}
			for (const detail of [
				new Detail(secret),
				{ nested: new Detail(secret) },
				[Buffer.from(secret)],
				Buffer.from(secret),
				{ toJSON: () => secret },
				{ toJSON: () => ({ nested: new Detail(secret) }) },
			]) {
				for (const format of [
					formatProdEntry,
					(info: Parameters<typeof formatProdEntry>[0]) =>
						formatConsoleEntry(info, false),
				]) {
					const output = format(
						logRedact({
							level: "error",
							message: "failure",
							detail,
						}) as Parameters<typeof formatProdEntry>[0],
					);
					expect(output).not.toContain("synthetic");
					expect(output).not.toContain(
						Buffer.from(secret).toJSON().data.join(","),
					);
					expect(output).toContain("[REDACTED]");
				}
			}
			const tokens = [secret, inspect(secret).slice(1, -1)];
			let escaped = secret;
			for (let i = 0; i < 4; i++) {
				escaped = JSON.stringify(escaped).slice(1, -1);
				tokens.push(escaped);
			}
			for (const encoded of [
				encodeURIComponent(secret),
				new URLSearchParams({ value: secret }).toString().slice(6),
				encodeURIComponent(secret).replace(
					/[!'~]/g,
					(s) => `%${s.charCodeAt(0).toString(16).toUpperCase()}`,
				),
			]) {
				const lower = encoded.replace(/%[A-F0-9]{2}/g, (s) => s.toLowerCase());
				tokens.push(
					encoded,
					lower,
					encodeURIComponent(encoded),
					encodeURIComponent(lower),
				);
			}
			for (const token of tokens) {
				expect(redactSrtPassphrases(`failure: ${token}`)).toBe(
					"failure: [REDACTED]",
				);
				const info = logRedact({
					level: "error",
					message: `failure: ${token}`,
					detail: token,
				}) as Parameters<typeof formatProdEntry>[0];
				for (const output of [
					formatProdEntry(info),
					formatConsoleEntry(info, false),
				]) {
					expect(output).not.toContain("synthetic");
					expect(output).toContain("[REDACTED]");
				}
			}
		} finally {
			config.srt_passphrase = previous;
		}
	},
);

test.each([
	{ srt_passphrase: "syntheticPassphrase42" },
	{ srt_pbkeylen: 32 as const },
])(
	"reports a specific secret-free encryption Start refusal: %j",
	async (config) => {
		const { CerastreamBackend } = await import(
			"../modules/streaming/cerastream-backend"
		);
		const { StreamStartFailure } = await import(
			"../modules/streaming/start-failure-taxonomy"
		);
		const backend = new CerastreamBackend({
			connect: async () => {
				throw new Error("unexpected connection");
			},
		});
		try {
			await backend.start(config, {
				pipeline: "test",
				host: "127.0.0.1",
				port: 9000,
			});
			throw new Error("unexpected success");
		} catch (error) {
			expect(error).toBeInstanceOf(StreamStartFailure);
			const failure = (error as InstanceType<typeof StreamStartFailure>)
				.failure;
			expect(failure.class).toBe("start_invalid");
			expect(failure.code).toBe("srt_encryption_unavailable");
			expect(failure.retriable).toBe(false);
			expect(JSON.stringify(failure)).not.toContain("synthetic");
		}
	},
);

test("publishes a specific encryption refusal notification", async () => {
	const { addClient, removeClient } = await import("../rpc/events");
	const { reportStartTerminalFailure } = await import(
		"../modules/streaming/stream-start-retry-reporting"
	);
	const messages: string[] = [];
	const ws = {
		send: (message: string) => messages.push(message),
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	addClient(ws);
	try {
		reportStartTerminalFailure({
			attemptId: "att_encryption",
			phase: "params",
			class: "start_invalid",
			code: "srt_encryption_unavailable",
			retry: {
				state: "not_retriable",
				attempt: 1,
				maxAttempts: 3,
				suppressed: false,
			},
		});
		const notification = messages
			.flatMap((message) => JSON.parse(message).notification?.show ?? [])
			.find((value) => value?.name === "stream_start_failed");
		expect(notification.key).toBe(
			"notifications.streamStartSrtEncryptionUnavailableFailed",
		);
		expect(notification.msg).toBe(
			"Saved SRT encryption settings are not supported. Clear them before starting.",
		);
	} finally {
		removeClient(ws);
	}
});

const receiverSource = () =>
	Bun.file(
		new URL("../rpc/procedures/streaming.procedure.ts", import.meta.url),
	).text();

test("setConfig writes encryption fields only in the explicit clear after destination writes", async () => {
	assertReceiverWrites(await receiverSource());
});

function insertAtAnchor(text: string, code: string) {
	const anchor = "if (input.relay_server) {";
	expect(text.split(anchor)).toHaveLength(2);
	return text.replace(anchor, `${anchor}\n${code}`);
}

test("receiver fixture insertion requires a unique anchor", () => {
	expect(() => insertAtAnchor("", "config.srt_latency = 1;")).toThrow(
		"toHaveLength",
	);
	expect(() =>
		insertAtAnchor("if (input.relay_server) { if (input.relay_server) {", ""),
	).toThrow("toHaveLength");
});

const writeMutants = [
	"({srt_passphrase: config.srt_passphrase} = input);",
	"[config.srt_pbkeylen] = [32];",
	"({nested: [config.srt_passphrase = input.srt_passphrase]} = input);",
	"({...config.srt_passphrase} = input);",
	"[...config.srt_pbkeylen] = input;",
	'Object.defineProperty(config, "srt_passphrase", {value: input.srt_passphrase});',
	"Object.defineProperties(config, {srt_pbkeylen: {value: 32}});",
	"Object.defineProperties(config, {...input});",
	"Object.defineProperty(config, key, {value: input.value});",
	"for (config.srt_passphrase of input.values) {}",
	"for ([config.srt_pbkeylen] of input.values) {}",
	"for (config.srt_passphrase in input) {}",
	'Object["assign"](config, {srt_passphrase: input.srt_passphrase});',
	'Object["defineProperty"](config, "srt_pbkeylen", {value: 32});',
	'Object["defineProperties"](config, {srt_passphrase: {value: input.srt_passphrase}});',
	'Reflect["set"](config, "srt_pbkeylen", 32);',
	"globalThis.Object.assign(config, {srt_pbkeylen: 32});",
	"config.srt_passphrase = input.srt_passphrase;",
	'config["srt_pbkeylen"] = 32;',
	'config[`srt_passphrase`] = "synthetic-secret";',
	'config["srt_" + "passphrase"] = input.srt_passphrase;',
	'const key = "srt_passphrase"; config[key] = input.srt_passphrase;',
	"config[input.key] = input.value;",
	"config.srt_passphrase ??= input.srt_passphrase;",
	"config.srt_passphrase ||= input.srt_passphrase;",
	"config.srt_pbkeylen += 16;",
	"config.srt_pbkeylen++;",
	"Object.assign(config, { srt_passphrase: input.srt_passphrase });",
	'Object.assign(config, { ["srt_pbkeylen"]: 32 });',
	"Object.assign(config, { ...input });",
	"Object.assign(config, input);",
	"config = { ...config, srt_passphrase: input.srt_passphrase };",
	"config = { ...config, ...input };",
	'Reflect.set(config, "srt_passphrase", input.srt_passphrase);',
	"Reflect.set(config, key, input.value);",
];

test.each(writeMutants)(
	"receiver-write mutant is rejected: %s",
	async (mutant) => {
		const text = await receiverSource();
		expect(() => assertReceiverWrites(insertAtAnchor(text, mutant))).toThrow(
			"receiver encryption writes must only be the two explicit clears",
		);
	},
);

test.each([
	"({[config.srt_passphrase]: other.value} = input);",
	"[other.srt_pbkeylen = config.srt_pbkeylen] = input;",
	"for (other.srt_passphrase of [config.srt_passphrase]) {}",
	"for (const value of config.srt_passphrase) {}",
	'Object.defineProperty(other, "srt_passphrase", {value: config.srt_passphrase});',
	"Object.defineProperties(other, {srt_pbkeylen: {value: config.srt_pbkeylen}});",
	'Object.defineProperty(config.audio_inputs, "srt_passphrase", {value: 1});',
	'Object.defineProperty(config, "srt_latency", {value: 2000});',
	"Object.defineProperties(config, {srt_latency: {value: 2000}});",
	'Object["assign"](other, config);',
	'Object["assign"](config, {srt_latency: 2000});',
	"other[config.srt_passphrase] = 1;",
	"this.config.srt_passphrase = input.srt_passphrase;",
	"delete config.srt_passphrase;",
	"const value = config.srt_passphrase;",
	'const value = config["srt_pbkeylen"];',
	"const value = config[key];",
	"config[key] = undefined;",
	"Reflect.set(config, key, undefined);",
	"const copy = { ...config, ...input };",
	"const copy = Object.assign({}, config, input);",
	'const value = Reflect.get(config, "srt_passphrase");',
	"other.srt_passphrase = config.srt_passphrase;",
	"config.srt_latency = input.srt_latency;",
	"Object.assign(config, { srt_latency: input.srt_latency });",
	'Reflect.set(config, "srt_latency", input.srt_latency);',
	"config = { ...config, srt_latency: input.srt_latency };",
])("receiver reads and unrelated writes stay valid: %s", async (fixture) => {
	const text = await receiverSource();
	assertReceiverWrites(insertAtAnchor(text, fixture));
});
