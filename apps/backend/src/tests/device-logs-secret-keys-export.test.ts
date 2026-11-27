/*
 * The support export (`known`) and bundle (`text`) mask values by key with the
 * logger's `isSensitiveKey`, through the shared secret-text lexer: SRT
 * passphrase fields keep their typed marker, every other secret key gets the
 * plain one. Synthetic values only.
 */
import { expect, test } from "bun:test";
import { buildRedactor } from "../modules/device-logs/redaction.ts";

const PASS = "[REDACTED:srt_passphrase]";
const both = (
	redactor: ReturnType<typeof buildRedactor>,
	line: string,
): string[] => [redactor.known(line).text, redactor.text(line).text];

test.each([
	[
		'{"ssh_pass_hash":"$6$fixturesalt$fixturehash","max_br":5000}',
		'{"ssh_pass_hash":"[REDACTED]","max_br":5000}',
	],
	[
		'config loaded {"ssh_pass":"fixture-old-ssh-pass","remote_key":"fixture-old-key"}',
		'config loaded {"ssh_pass":"[REDACTED]","remote_key":"[REDACTED]"}',
	],
	["note token=fixture-token-31 next", "note token=[REDACTED] next"],
	[
		"srt://h:1?streamid=fixture-stream-44&latency=120",
		"srt://h:1?streamid=[REDACTED]&latency=120",
	],
	['cfg {"passphrase":"fixture-srt-pass-55"}', `cfg {"passphrase":"${PASS}"}`],
])("%s is masked by key in both downloads", (line, expected) => {
	expect(both(buildRedactor([]), line)).toEqual([expected, expected]);
});

test("a held secret inside a named value keeps the value's quotes", () => {
	const redactor = buildRedactor([
		{ kind: "srt_passphrase", value: "fixture-held-pass-66" },
	]);
	const line = '{"passphrase":"x fixture-held-pass-66 y","latency":120}';
	const expected = `{"passphrase":"${PASS}","latency":120}`;
	expect(redactor.text(line).text).toBe(expected);
	expect(redactor.known(line).text).toBe(expected);
});

test("a single-quoted URI argument keeps its closing quote", () => {
	const line = "caller 'srt://h:1?passphrase=fixture-uri-pass-77' next";
	const expected = `caller 'srt://h:1?passphrase=${PASS}' next`;
	expect(both(buildRedactor([]), line)).toEqual([expected, expected]);
});

test("ordinary keys stay readable in both downloads", () => {
	const line =
		'{"video_passthrough":"auto","deviceKey":"d-1","latency":120} mode=caller bypass=1';
	expect(both(buildRedactor([]), line)).toEqual([line, line]);
});
