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
		expect(
			projectRemoteConfig({ ...input, pairing_secret: "dummy-pairing" }),
		).toEqual(publicStreamIds(input));
		expect(input.srt_streamid).toBe("dummy-publish-key");
		expect(publicStreamIds(publicStreamIds(input))).toEqual(
			publicStreamIds(input),
		);
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
	test("unrelated field names do not erase diagnostics", () => {
		for (const text of [
			"engine upstream_idle: true",
			"12:30: stream identity established",
			"streamid_configured: true",
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

test("overlapping retained IDs redact the longest token first", () => {
	const previous = setStreamIdRedactionSource(() => ["live", "live/secretkey"]);
	try {
		expect(redactStreamIdText("delivered live/secretkey")).toBe(
			"delivered [REDACTED]",
		);
	} finally {
		setStreamIdRedactionSource(previous);
	}
});
