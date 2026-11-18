import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { projectRemoteConfig } from "../modules/remote/remote-status.ts";
import { formatConsoleEntry, formatProdEntry, logRedact } from "./logger.ts";
import {
	publicStreamIds,
	redactStreamIdJournal,
	redactStreamIdText,
	setStreamIdRedactionSource,
} from "./stream-id-secret.ts";

let previous: () => readonly (string | undefined)[];
beforeEach(() => {
	previous = setStreamIdRedactionSource(() => []);
});
afterEach(() => {
	setStreamIdRedactionSource(previous);
});
describe("Stream ID disclosure boundaries", () => {
	test("projects configured state without a reversible hint", () => {
		const input = {
			srt_streamid: "dummy-publish-key",
			relay_streamid_override: "dummy-override",
			srtla_port: 5000,
		};
		expect(publicStreamIds(input)).toEqual({
			srt_streamid_configured: true,
			relay_streamid_override_configured: true,
			srtla_port: 5000,
		});
		expect(input.srt_streamid).toBe("dummy-publish-key");
		expect(publicStreamIds(publicStreamIds(input))).toEqual(
			publicStreamIds(input),
		);
	});
	test("remote config carries neither Stream IDs nor whether one is saved", () => {
		const local = publicStreamIds({
			srt_streamid: "dummy-publish-key",
			relay_streamid_override: "dummy-override",
			srt_latency: 2000,
		});
		for (const config of [
			{
				srt_streamid: "dummy-publish-key",
				relay_streamid_override: "dummy-override",
				pairing_secret: "dummy-pairing",
				srt_latency: 2000,
			},
			{ ...local, pairing_secret: "dummy-pairing" },
		]) {
			const remote = projectRemoteConfig(config);
			expect(remote).toMatchObject({ srt_latency: 2000 });
			for (const key of [
				"srt_streamid",
				"relay_streamid_override",
				"srt_streamid_configured",
				"relay_streamid_override_configured",
				"pairing_secret",
			])
				expect(remote).not.toHaveProperty(key);
			expect(JSON.stringify(remote)).not.toContain("dummy-");
		}
	});
	test("scrubs nested trace args and Error fields", () => {
		const value = logRedact({
			args: [
				{
					srt_streamid: "dummy-key",
					streamId: "dummy-key",
					relay_streamid_override: "dummy-key",
					ingest_key: "dummy-key",
				},
			],
			error: new Error('streamid="dummy-key"'),
		});
		expect(JSON.stringify(value)).not.toContain("dummy-key");
	});
	test("scrubs historical labelled journal records with spaces, escaping and URI encoding", () => {
		for (const record of [
			'{"srt_streamid":"dummy key with spaces"}',
			"srt://example.test:9000?streamid=dummy%20key",
			"streamId: dummy-key",
			'relay_streamid_override="dummy-key"',
		]) {
			expect(redactStreamIdJournal(`before\n${record}\nafter`)).toBe(
				"before\n[REDACTED]\nafter",
			);
		}
	});
	test.each([
		"Error: invalid streamid syntheticUnsavedKey",
		"start failed (stream_id syntheticUnsavedKey): refused",
		"--streamid syntheticUnsavedKey --port: 1",
		'stream_id: Some(\n    "syntheticUnsavedKey",\n),',
		'{\n  "streamid":\n    "syntheticUnsavedKey"\n}',
		"cfg.streamid=syntheticUnsavedKey",
		"TypeError: config.srt_streamid: syntheticUnsavedKey",
		'opts.relay_streamid_override = "syntheticUnsavedKey"',
		JSON.stringify(JSON.stringify({ srt_streamid: "syntheticUnsavedKey" })),
		JSON.stringify(
			JSON.stringify(JSON.stringify({ stream_id: "syntheticUnsavedKey" })),
		),
	])("scrubs unretained labelled record %s while keeping frames", (record) => {
		const frame = "    at connect (/app/helpers/stream-id-secret.ts:63:4)";
		for (const redact of [redactStreamIdText, redactStreamIdJournal]) {
			const output = redact(
				`${record}\n${frame}\n    at start (/app/start.ts:10:2)`,
			);
			expect(output).not.toContain("syntheticUnsavedKey");
			expect(output).toContain(frame);
			expect(output).toContain("start.ts:10:2");
		}
	});
	test("scrubs retained values in unlabelled errors and leaves ordinary diagnostics", () => {
		setStreamIdRedactionSource(() => ["dummy/key with spaces"]);
		for (const key of ["dummy/key with spaces", "dummy%2Fkey%20with%20spaces"])
			expect(redactStreamIdText(`connect failed: ${key}`)).not.toContain(key);
		expect(redactStreamIdText("connection timed out")).toBe(
			"connection timed out",
		);
	});
	test.each([
		[
			"live",
			"audio delivered to the live preview",
			"audio delivered to the [REDACTED] preview",
		],
		["a", "a camera has data", "[REDACTED] camera has data"],
		["test", "latest contest: test", "latest contest: [REDACTED]"],
		["1", "port 1001: 1", "port 1001: [REDACTED]"],
		[
			"key.part",
			"keyXpart key.part key.partial",
			"keyXpart [REDACTED] key.partial",
		],
	] as const)(
		"retained %s redacts whole tokens without corrupting words",
		(id, text, expected) => {
			setStreamIdRedactionSource(() => [id]);
			expect(redactStreamIdText(text)).toBe(expected);
			expect(redactStreamIdJournal(text)).toBe(expected);
			expect(logRedact({ message: text })).toEqual({ message: expected });
		},
	);
	test.each([
		[
			"a raw journal",
			[
				'Nov 15 10:00:00 box ceralive[612]: stream_id: Some(\n                                       "syntheticUnsavedKey",\n                                   ),',
				"Nov 15 10:00:01 box ceralive[612]: link wwan0 up",
				"Nov 15 10:00:02 box kernel: usb 2-1: disconnect",
			],
		],
		[
			"the support journal",
			[
				"[boot 0] 2026-11-15T10:00:00.000Z systemd: validating stream_id:",
				"[boot 0] 2026-11-15T10:00:01.000Z ceralive: start ok",
				"[boot 0] 2026-11-15T10:00:02.000Z kernel: thermal 70C",
				'[boot 0] 2026-11-15T10:00:03.000Z ceralive: "stream_id": {\n  "key": "syntheticUnsavedKey"\n}',
				"[boot 0] 2026-11-15T10:00:04.000Z ModemManager: modem 1 reconnected",
			],
		],
	] as const)(
		"a labelled value in %s hides only its own record",
		(_, records) => {
			const output = redactStreamIdJournal(records.join("\n"));
			expect(output).not.toContain("syntheticUnsavedKey");
			for (const later of records.slice(1).filter((r) => !/stream_id/.test(r)))
				expect(output).toContain(later);
			// Outside a journal, a value still runs to the next stack frame.
			expect(
				redactStreamIdText("stream_id:\nsyntheticUnsavedKey\nnext line"),
			).not.toContain("next line");
		},
	);
	test.each([
		"SRT streamid not specified",
		"Error: invalid streamid",
		"stream_id is required",
		"    at streamId (/app/a.ts:1:1)",
		"    at async Object.streamId [as start] (file:///app/a.ts:1:1)",
		'[boot 0] 2026-11-15T10:00:00.000Z ceralive: {"msg":"SRT streamid not specified","level":"error"}',
	])("keeps a line that only names the field: %s", (line) => {
		expect(redactStreamIdJournal(line)).toBe(line);
		if (!line.startsWith("[boot")) expect(redactStreamIdText(line)).toBe(line);
	});
	test.each([
		"srt_streamid must be at most 512 characters",
		"receiver rejected the streamid (access denied)",
		"syntheticUnsavedKey: invalid streamid",
		'"syntheticUnsavedKey" rejected: unknown stream_id',
		"live: invalid streamid",
		"streamid not specified syntheticUnsavedKey",
		"streamid syntheticUnsavedKey",
		"    at streamid=syntheticUnsavedKey:1:1",
		'[boot 0] ceralive: {"msg":"SRT streamid not specified","meta":{"stream_id":"syntheticUnsavedKey"}}',
	])("still blanks a labelled line that may hold a value: %s", (line) => {
		expect(redactStreamIdText(line)).toBe("[REDACTED]");
		expect(redactStreamIdJournal(line)).toBe("[REDACTED]");
	});
	test("unrelated field names do not erase diagnostics", () => {
		for (const text of [
			"engine upstream_idle: true",
			"12:30: stream identity established",
			"streamid_configured: true",
			"reading settings.streamId from the form",
			"    at StreamId.parse (/app/a.ts:1:1)",
			"    at load (C:\\app\\streamid\\config.ts:1:1)",
		]) {
			expect(redactStreamIdText(text)).toBe(text);
			expect(redactStreamIdJournal(text)).toBe(text);
		}
	});
	test("retained IDs still scrub quoted, URI-encoded and escaped tokens", () => {
		setStreamIdRedactionSource(() => ['dummy/key with "quotes"']);
		for (const token of [
			'dummy/key with "quotes"',
			encodeURIComponent('dummy/key with "quotes"'),
			JSON.stringify('dummy/key with "quotes"').slice(1, -1),
		]) {
			expect(redactStreamIdText(`failure: '${token}'`)).toBe(
				"failure: '[REDACTED]'",
			);
		}
	});
});

describe("retained secret serialization", () => {
	test.each(["syntheticPublishKey42", "synthetic key\"'\\~!"])(
		"scrubs non-plain containers for %s",
		(secret) => {
			setStreamIdRedactionSource(() => [secret]);
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
		},
	);
	test.each(["syntheticPublishKey42", "synthetic key\"'\\~!"])(
		"scrubs additional retained encodings for %s",
		(secret) => {
			setStreamIdRedactionSource(() => [secret]);
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
				expect(redactStreamIdText(`failure: ${token}`)).toBe(
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
		},
	);
	test("preserves stack frames with stream-id paths while scrubbing values", () => {
		setStreamIdRedactionSource(() => ["syntheticPublishKey42"]);
		const error = new Error("connection refused: syntheticPublishKey42");
		error.stack = `${error.message}\n    at connect (/app/helpers/stream-id-secret.ts:63:4)\n    at start (/app/start.ts:10:2)`;
		const output = formatProdEntry(
			logRedact({ level: "error", message: "failed", error }) as Parameters<
				typeof formatProdEntry
			>[0],
		);
		expect(output).not.toContain("syntheticPublishKey42");
		expect(output).toContain("stream-id-secret.ts:63:4");
		expect(output).toContain("start.ts:10:2");
	});
});
